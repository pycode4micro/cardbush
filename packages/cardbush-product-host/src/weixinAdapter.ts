import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { BotAdapter, BotAdapterContext, BotAdapterFactory, BotRuntimeStatus } from "./botSupervisor.js";
import type { ChatEnvelope, ConversationBackend } from "./conversation.js";
import { identityIsAllowed } from "./conversation.js";
import type { WeixinAccountHost } from "./productHost.js";

const SESSION_EXPIRED = -14;

export interface WeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  savedAt?: string;
}

interface WeixinLoginState {
  loginId: string;
  qrcodeUrl: string;
  status: "waiting" | "scanned" | "confirmed" | "expired" | "failed";
  expiresAt: string;
  account?: Record<string, unknown>;
  message: string;
}

export interface WeixinAdapterDependencies {
  backend: ConversationBackend;
  store: WeixinAccountStore;
  createClient?: (config: Readonly<Record<string, unknown>>) => WeixinApiClient;
}

export function createWeixinAdapterFactory(
  dependencies: WeixinAdapterDependencies,
): BotAdapterFactory {
  return (context) => new WeixinPollingAdapter(context, dependencies);
}

export class WeixinAccountStore {
  readonly #root: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async list(): Promise<WeixinAccount[]> {
    const ids = await this.#readJson<unknown[]>(join(this.#root, "accounts.json"), []);
    const accounts: WeixinAccount[] = [];
    for (const raw of ids) {
      const accountId = validAccountId(raw);
      if (!accountId) continue;
      const account = await this.load(accountId);
      if (account) accounts.push(account);
    }
    return accounts;
  }

  async load(accountId: string): Promise<WeixinAccount | undefined> {
    const normalized = requireAccountId(accountId);
    const value = await this.#readJson<Record<string, unknown> | undefined>(
      this.#accountPath(normalized),
      undefined,
    );
    if (!value) return undefined;
    const token = String(value.token ?? "").trim();
    const baseUrl = String(value.base_url ?? value.baseUrl ?? "").trim();
    if (!token || !baseUrl) return undefined;
    return {
      accountId: normalized,
      token,
      baseUrl,
      ...(String(value.user_id ?? value.userId ?? "").trim()
        ? { userId: String(value.user_id ?? value.userId).trim() }
        : {}),
      ...(String(value.saved_at ?? value.savedAt ?? "").trim()
        ? { savedAt: String(value.saved_at ?? value.savedAt).trim() }
        : {}),
    };
  }

  save(account: WeixinAccount): Promise<void> {
    return this.#serialize(async () => {
      const accountId = requireAccountId(account.accountId);
      const accounts = await this.list();
      for (const current of accounts) {
        if (account.userId && current.userId === account.userId && current.accountId !== accountId) {
          await this.#removeFiles(current.accountId);
        }
      }
      await this.#writeJson(this.#accountPath(accountId), {
        account_id: accountId,
        token: account.token,
        base_url: account.baseUrl,
        user_id: account.userId ?? "",
        saved_at: account.savedAt ?? new Date().toISOString(),
      });
      const remaining = (await this.list()).map((item) => item.accountId)
        .filter((item) => item !== accountId);
      await this.#writeJson(join(this.#root, "accounts.json"), [...remaining, accountId]);
    });
  }

  remove(accountId: string): Promise<boolean> {
    return this.#serialize(async () => {
      const normalized = requireAccountId(accountId);
      const accounts = await this.list();
      if (!accounts.some((item) => item.accountId === normalized)) return false;
      await this.#removeFiles(normalized);
      await this.#writeJson(
        join(this.#root, "accounts.json"),
        accounts.map((item) => item.accountId).filter((item) => item !== normalized),
      );
      return true;
    });
  }

  async loadSync(accountId: string): Promise<string> {
    const value = await this.#readJson<Record<string, unknown>>(
      join(this.#root, "accounts", `${requireAccountId(accountId)}.sync.json`),
      {},
    );
    return String(value.get_updates_buf ?? "");
  }

  saveSync(accountId: string, value: string): Promise<void> {
    return this.#serialize(() => this.#writeJson(
      join(this.#root, "accounts", `${requireAccountId(accountId)}.sync.json`),
      { get_updates_buf: value },
    ));
  }

  async contextToken(accountId: string, userId: string): Promise<string> {
    const value = await this.#readJson<Record<string, unknown>>(
      join(this.#root, "accounts", `${requireAccountId(accountId)}.context-tokens.json`),
      {},
    );
    return String(value[userId] ?? "");
  }

  async setContextToken(accountId: string, userId: string, token: string): Promise<void> {
    await this.#serialize(async () => {
      const path = join(this.#root, "accounts", `${requireAccountId(accountId)}.context-tokens.json`);
      const value = await this.#readJson<Record<string, unknown>>(path, {});
      value[userId] = token;
      await this.#writeJson(path, value);
    });
  }

  async handledIds(accountId: string): Promise<Record<string, number>> {
    const value = await this.#readJson<Record<string, unknown>>(
      join(this.#root, "accounts", `${requireAccountId(accountId)}.handled.json`),
      {},
    );
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => Number.isFinite(Number(item)))
        .map(([key, item]) => [key, Number(item)]),
    );
  }

  saveHandledIds(accountId: string, value: Record<string, number>): Promise<void> {
    return this.#serialize(() => this.#writeJson(
      join(this.#root, "accounts", `${requireAccountId(accountId)}.handled.json`),
      value,
    ));
  }

  async #removeFiles(accountId: string): Promise<void> {
    const root = join(this.#root, "accounts");
    await Promise.all([
      ".json", ".sync.json", ".context-tokens.json", ".handled.json",
    ].map((suffix) => rm(join(root, `${accountId}${suffix}`), { force: true })));
  }

  #accountPath(accountId: string): string {
    return join(this.#root, "accounts", `${accountId}.json`);
  }

  async #readJson<T>(path: string, fallback: T): Promise<T> {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
    try {
      return JSON.parse(source) as T;
    } catch (error) {
      throw new Error(`Invalid Weixin state JSON at ${path}: ${errorMessage(error)}`);
    }
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(action, action);
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export class WeixinApiClient {
  readonly #config: Readonly<Record<string, unknown>>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: Readonly<Record<string, unknown>>, fetcher = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetcher;
  }

  async startQrLogin(signal?: AbortSignal): Promise<{ qrcode: string; qrcodeUrl: string }> {
    const base = stringConfig(this.#config, "login_api_base", "https://ilinkai.weixin.qq.com");
    const url = new URL("ilink/bot/get_bot_qrcode", `${trailing(base)}/`);
    url.searchParams.set("bot_type", stringConfig(this.#config, "bot_type", "3"));
    const payload = await this.#request(url, { signal });
    const qrcode = String(payload.qrcode ?? "").trim();
    const qrcodeUrl = String(payload.qrcode_img_content ?? "").trim();
    if (!qrcode || !qrcodeUrl) throw new Error("Weixin QR response is incomplete");
    return { qrcode, qrcodeUrl };
  }

  async qrStatus(qrcode: string, baseUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const url = new URL("ilink/bot/get_qrcode_status", `${trailing(baseUrl)}/`);
    url.searchParams.set("qrcode", qrcode);
    return this.#request(url, { signal, timeoutMs: numberConfig(this.#config, "poll_timeout_seconds", 35) * 1000 });
  }

  async updates(
    account: WeixinAccount,
    sync: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL("ilink/bot/getupdates", `${trailing(account.baseUrl)}/`);
    return this.#request(url, {
      method: "POST",
      signal,
      timeoutMs: numberConfig(this.#config, "poll_timeout_seconds", 35) * 1000 + 5_000,
      token: account.token,
      body: {
        get_updates_buf: sync,
        base_info: { channel_version: stringConfig(this.#config, "app_version", "2.1.7") },
      },
    });
  }

  async sendText(input: {
    account: WeixinAccount;
    userId: string;
    text: string;
    contextToken?: string;
    signal: AbortSignal;
  }): Promise<void> {
    const url = new URL("ilink/bot/sendmessage", `${trailing(input.account.baseUrl)}/`);
    await this.#request(url, {
      method: "POST",
      signal: input.signal,
      token: input.account.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: input.userId,
          client_id: `cardbush-weixin-${crypto.randomUUID()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: input.text } }],
          ...(input.contextToken ? { context_token: input.contextToken } : {}),
        },
        base_info: { channel_version: stringConfig(this.#config, "app_version", "2.1.7") },
      },
    });
  }

  async #request(
    url: URL,
    input: {
      method?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      token?: string;
      body?: unknown;
    },
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? numberConfig(this.#config, "api_timeout_seconds", 15) * 1000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      "iLink-App-Id": stringConfig(this.#config, "app_id", "bot"),
      "iLink-App-ClientVersion": String(buildClientVersion(stringConfig(this.#config, "app_version", "2.1.7"))),
      "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 2 ** 32))).toString("base64"),
    };
    const routeTag = String(this.#config.route_tag ?? "").trim();
    if (routeTag) headers.SKRouteTag = routeTag;
    if (input.token) {
      headers.AuthorizationType = "ilink_bot_token";
      headers.Authorization = `Bearer ${input.token}`;
      headers["content-type"] = "application/json";
    }
    const response = await this.#fetch(url, {
      method: input.method ?? "GET",
      headers,
      signal,
      ...(input.body == null ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Weixin API failed (${response.status}): ${text.slice(0, 500)}`);
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error("Weixin API returned invalid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Weixin API returned a non-object response");
    }
    return payload as Record<string, unknown>;
  }
}

export class WeixinAccountManager implements WeixinAccountHost {
  readonly #store: WeixinAccountStore;
  readonly #config: () => Promise<Readonly<Record<string, unknown>>>;
  readonly #clients: (config: Readonly<Record<string, unknown>>) => WeixinApiClient;
  #login?: WeixinLoginState & { controller: AbortController };

  constructor(input: {
    store: WeixinAccountStore;
    config: () => Promise<Readonly<Record<string, unknown>>>;
    createClient?: (config: Readonly<Record<string, unknown>>) => WeixinApiClient;
  }) {
    this.#store = input.store;
    this.#config = input.config;
    this.#clients = input.createClient ?? ((config) => new WeixinApiClient(config));
  }

  async startLogin(): Promise<Record<string, unknown>> {
    if (this.#login?.status === "waiting" || this.#login?.status === "scanned") {
      return loginPayload(this.#login, true);
    }
    this.#login?.controller.abort();
    const config = await this.#config();
    const client = this.#clients(config);
    const controller = new AbortController();
    const qr = await client.startQrLogin(controller.signal);
    const timeout = Math.max(5, numberConfig(config, "login_timeout_seconds", 480));
    const login: WeixinLoginState & { controller: AbortController } = {
      loginId: `wx-${crypto.randomUUID()}`,
      qrcodeUrl: qr.qrcodeUrl,
      status: "waiting",
      expiresAt: new Date(Date.now() + timeout * 1000).toISOString(),
      message: "",
      controller,
    };
    this.#login = login;
    void this.#pollLogin(login, client, qr.qrcode, config, timeout);
    return loginPayload(login, true);
  }

  async loginStatus(loginId: string): Promise<Record<string, unknown>> {
    if (!this.#login || this.#login.loginId !== loginId) {
      throw new Error(`Unknown Weixin login: ${loginId}`);
    }
    return loginPayload(this.#login, false);
  }

  async deleteAccount(accountId: string): Promise<Record<string, unknown>> {
    const deleted = await this.#store.remove(accountId);
    if (!deleted) throw new Error(`Unknown Weixin account: ${accountId}`);
    return { account_id: accountId, deleted: true };
  }

  async #pollLogin(
    login: WeixinLoginState & { controller: AbortController },
    client: WeixinApiClient,
    qrcode: string,
    config: Readonly<Record<string, unknown>>,
    timeoutSeconds: number,
  ): Promise<void> {
    let baseUrl = stringConfig(config, "login_api_base", "https://ilinkai.weixin.qq.com");
    const deadline = Date.now() + timeoutSeconds * 1000;
    try {
      while (Date.now() < deadline && !login.controller.signal.aborted) {
        const status = await client.qrStatus(qrcode, baseUrl, login.controller.signal);
        const value = String(status.status ?? "wait");
        if (value === "scaned_but_redirect" && status.redirect_host) {
          baseUrl = `https://${String(status.redirect_host)}`;
        } else if (value === "confirmed") {
          const accountId = String(status.ilink_bot_id ?? "").trim();
          const token = String(status.bot_token ?? "").trim();
          if (!accountId || !token) throw new Error("Confirmed Weixin login omitted credentials");
          const account: WeixinAccount = {
            accountId,
            token,
            baseUrl: String(status.baseurl ?? config.api_base ?? "https://ilinkai.weixin.qq.com"),
            userId: String(status.ilink_user_id ?? "").trim() || undefined,
            savedAt: new Date().toISOString(),
          };
          await this.#store.save(account);
          login.status = "confirmed";
          login.account = publicAccount(account);
          login.message = "Weixin account connected";
          return;
        } else if (value === "expired") {
          login.status = "expired";
          login.message = "Weixin login QR code expired";
          return;
        } else if (value.includes("scan")) {
          login.status = "scanned";
        }
        await delay(1_000, login.controller.signal);
      }
      if (!login.controller.signal.aborted) {
        login.status = "expired";
        login.message = "Weixin login timed out";
      }
    } catch (error) {
      if (login.controller.signal.aborted) return;
      login.status = "failed";
      login.message = errorMessage(error);
    }
  }
}

export class WeixinPollingAdapter implements BotAdapter {
  readonly #context: BotAdapterContext;
  readonly #backend: ConversationBackend;
  readonly #store: WeixinAccountStore;
  readonly #client: WeixinApiClient;
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #expired = new Set<string>();
  #accounts: WeixinAccount[] = [];
  #lastError = "";

  constructor(context: BotAdapterContext, dependencies: WeixinAdapterDependencies) {
    this.#context = context;
    this.#backend = dependencies.backend;
    this.#store = dependencies.store;
    this.#client = (dependencies.createClient ?? ((config) => new WeixinApiClient(config)))(context.config);
  }

  async start(): Promise<void> {
    this.#accounts = await this.#store.list();
    if (!this.#accounts.length) throw new Error("No connected Weixin account");
    for (const account of this.#accounts) {
      this.#tasks.set(account.accountId, this.#poll(account));
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.#tasks.values());
    this.#tasks.clear();
    await this.#backend.close?.();
  }

  status(): BotRuntimeStatus {
    const allExpired = this.#accounts.length > 0 && this.#expired.size === this.#accounts.length;
    return {
      healthStatus: allExpired ? "authentication_expired" : this.#expired.size ? "degraded" : "healthy",
      errorCode: this.#expired.size ? "weixin_session_expired" : "",
      lastError: allExpired ? "Weixin login expired; reconnect the account." : this.#lastError,
      requiresReauthentication: this.#expired.size > 0,
      accounts: this.#accounts.map((account) => ({
        ...publicAccount(account),
        status: this.#expired.has(account.accountId) ? "authentication_expired" : "running",
      })),
    };
  }

  async #poll(account: WeixinAccount): Promise<void> {
    let sync = await this.#store.loadSync(account.accountId);
    let failures = 0;
    while (!this.#context.signal.aborted) {
      try {
        const payload = await this.#client.updates(account, sync, this.#context.signal);
        failures = 0;
        const ret = Number(payload.ret ?? 0);
        const errcode = Number(payload.errcode ?? 0);
        if (ret === SESSION_EXPIRED || errcode === SESSION_EXPIRED) {
          this.#expired.add(account.accountId);
          return;
        }
        if (ret !== 0 || errcode !== 0) {
          throw new Error(`Weixin getupdates failed: ret=${ret} errcode=${errcode} ${String(payload.errmsg ?? "")}`);
        }
        const messages = Array.isArray(payload.msgs) ? payload.msgs : [];
        for (const item of messages) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            await this.#handle(account, item as Record<string, unknown>);
          }
        }
        sync = String(payload.get_updates_buf ?? sync);
        await this.#store.saveSync(account.accountId, sync);
      } catch (error) {
        if (this.#context.signal.aborted) return;
        failures += 1;
        this.#lastError = errorMessage(error);
        await this.#context.log("warning", `poll failed: ${this.#lastError}`);
        await delay(Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6)), this.#context.signal)
          .catch(() => undefined);
      }
    }
  }

  async #handle(account: WeixinAccount, message: Record<string, unknown>): Promise<void> {
    const userId = String(message.from_user_id ?? "").trim();
    const messageId = String(message.message_id ?? "").trim();
    if (!userId) return;
    if (!identityIsAllowed({
      userId,
      channelId: account.accountId,
      allowedUserIds: stringArray(this.#context.config.allowed_user_ids),
      allowedChannelIds: stringArray(this.#context.config.allowed_channel_ids),
    })) return;
    const handled = await this.#store.handledIds(account.accountId);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, at] of Object.entries(handled)) if (at < cutoff) delete handled[key];
    if (messageId && handled[messageId]) return;
    const contextToken = String(message.context_token ?? "").trim()
      || await this.#store.contextToken(account.accountId, userId);
    if (message.context_token) {
      await this.#store.setContextToken(account.accountId, userId, String(message.context_token));
    }
    const text = extractMessageText(message);
    if (!text) {
      await this.#send(account, userId, stringConfig(this.#context.config, "unsupported_message_text", "当前仅支持文本消息。"), contextToken);
      if (messageId) {
        handled[messageId] = Date.now();
        await this.#store.saveHandledIds(account.accountId, handled);
      }
      return;
    }
    const envelope: ChatEnvelope = {
      platform: "weixin",
      sessionId: `weixin:${account.accountId}:${userId}`,
      userId,
      channelId: account.accountId,
      text,
      ...(messageId ? { messageId } : {}),
      rawEvent: message,
    };
    try {
      const reply = await this.#backend.respond(envelope, {
        signal: this.#context.signal,
        onPermissionRequest: (request) => this.#send(
          account,
          userId,
          formatPermissionRequest(request),
          contextToken,
        ),
      });
      await this.#send(account, userId, reply.text, contextToken);
      if (messageId) {
        handled[messageId] = Date.now();
        await this.#store.saveHandledIds(account.accountId, handled);
      }
    } catch (error) {
      await this.#context.log("error", `message failed: ${errorMessage(error)}`);
      await this.#send(account, userId, `执行失败：${errorMessage(error)}`, contextToken);
      throw error;
    }
  }

  async #send(account: WeixinAccount, userId: string, text: string, contextToken: string): Promise<void> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#client.sendText({
          account,
          userId,
          text,
          contextToken: contextToken || undefined,
          signal: this.#context.signal,
        });
        return;
      } catch (error) {
        last = error;
        if (attempt < 2) await delay(250 * (attempt + 1), this.#context.signal);
      }
    }
    throw last;
  }
}

function extractMessageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.item_list)) return "";
  for (const raw of message.item_list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const source = Number(item.type) === 1 ? item.text_item : Number(item.type) === 3 ? item.voice_item : undefined;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const text = String((source as Record<string, unknown>).text ?? "").trim();
      if (text) return text;
    }
  }
  return "";
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((item) => Number(item) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function loginPayload(login: WeixinLoginState, includeQr: boolean): Record<string, unknown> {
  return {
    protocol: "cardbush.product_weixin_login.v1",
    login_id: login.loginId,
    ...(includeQr ? { qrcode_url: login.qrcodeUrl, expires_at: login.expiresAt } : {}),
    status: login.status,
    account: login.account ?? null,
    message: login.message,
  };
}

function publicAccount(account: WeixinAccount): Record<string, unknown> {
  return {
    account_id: account.accountId,
    user_id: account.userId ?? "",
    base_url: account.baseUrl,
    saved_at: account.savedAt ?? "",
  };
}

function validAccountId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text && basename(text) === text && !text.includes("/") && !text.includes("\\") ? text : "";
}

function requireAccountId(value: unknown): string {
  const text = validAccountId(value);
  if (!text) throw new Error("Invalid Weixin account id");
  return text;
}

function trailing(value: string): string {
  return value.replace(/\/$/, "");
}

function stringConfig(config: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  return String(config[key] ?? fallback).trim() || fallback;
}

function numberConfig(config: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = Number(config[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatPermissionRequest(request: {
  reason: string;
  actions: string[];
  resources: string[];
}): string {
  return [
    "需要你的授权",
    request.reason,
    `动作：${request.actions.join(", ")}`,
    `资源：${request.resources.join("\n")}`,
    "回复 1 仅本次允许，2 本会话允许，3 拒绝。",
  ].join("\n");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, milliseconds);
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
