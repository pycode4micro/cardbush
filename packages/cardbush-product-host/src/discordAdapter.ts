import type { BotAdapter, BotAdapterContext, BotAdapterFactory, BotRuntimeStatus } from "./botSupervisor.js";
import type { ChatEnvelope, ConversationBackend } from "./conversation.js";
import { identityIsAllowed } from "./conversation.js";

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface DiscordAdapterDependencies {
  backend: ConversationBackend;
  fetch?: typeof globalThis.fetch;
  createWebSocket?: (url: string) => WebSocket;
  retryDelayMs?: number;
  connectTimeoutMs?: number;
}

export function createDiscordAdapterFactory(
  dependencies: DiscordAdapterDependencies,
): BotAdapterFactory {
  return (context) => new DiscordGatewayAdapter(context, dependencies);
}

export class DiscordGatewayAdapter implements BotAdapter {
  readonly #context: BotAdapterContext;
  readonly #backend: ConversationBackend;
  readonly #fetch: typeof globalThis.fetch;
  readonly #createWebSocket: (url: string) => WebSocket;
  readonly #retryDelayMs: number;
  readonly #connectTimeoutMs: number;
  readonly #dedup = new ExpiringSet(600_000, 4096);
  #runTask?: Promise<void>;
  #websocket?: WebSocket;
  #sequence?: number;
  #heartbeat?: ReturnType<typeof setInterval>;
  #botUserId = "";
  #connected = false;
  #lastError = "";
  #stopRequested = false;

  constructor(context: BotAdapterContext, dependencies: DiscordAdapterDependencies) {
    this.#context = context;
    this.#backend = dependencies.backend;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#createWebSocket = dependencies.createWebSocket ?? ((url) => new WebSocket(url));
    this.#retryDelayMs = dependencies.retryDelayMs ?? 5_000;
    this.#connectTimeoutMs = dependencies.connectTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.#runTask) return;
    this.#stopRequested = false;
    const firstConnection = deferred<void>();
    this.#runTask = this.#run(firstConnection).catch(async (error) => {
      this.#lastError = errorMessage(error);
      await this.#context.log("error", this.#lastError);
      firstConnection.reject(error);
    });
    await withTimeout(firstConnection.promise, this.#connectTimeoutMs, "Discord gateway connection timed out");
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.#clearHeartbeat();
    this.#websocket?.close(1000, "CardBush stopped");
    this.#websocket = undefined;
    await this.#runTask?.catch(() => undefined);
    this.#runTask = undefined;
    this.#connected = false;
    await this.#backend.close?.();
  }

  status(): BotRuntimeStatus {
    return {
      healthStatus: this.#connected ? "healthy" : (this.#lastError ? "connection_failed" : "connecting"),
      lastError: this.#lastError,
      errorCode: this.#lastError ? "discord_gateway_error" : "",
    };
  }

  async #run(firstConnection: Deferred<void>): Promise<void> {
    while (!this.#stopped()) {
      try {
        const gateway = await this.#gatewayUrl();
        await this.#connect(gateway, firstConnection);
      } catch (error) {
        if (this.#stopped()) return;
        this.#connected = false;
        this.#lastError = errorMessage(error);
        await this.#context.log("warning", `gateway reconnect: ${this.#lastError}`);
        await delay(this.#retryDelayMs, this.#context.signal).catch(() => undefined);
      }
    }
  }

  async #gatewayUrl(): Promise<string> {
    const response = await this.#fetch(`${stringConfig(this.#context.config, "api_base")}/gateway/bot`, {
      headers: { authorization: `Bot ${stringConfig(this.#context.config, "bot_token")}` },
      signal: this.#context.signal,
    });
    if (!response.ok) {
      throw new Error(`Discord gateway request failed (${response.status})`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const url = String(payload.url ?? "").trim();
    if (!url) throw new Error("Discord gateway response did not contain a URL");
    return `${url.replace(/\/$/, "")}/?v=10&encoding=json`;
  }

  async #connect(url: string, firstConnection: Deferred<void>): Promise<void> {
    const websocket = this.#createWebSocket(url);
    this.#websocket = websocket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      websocket.addEventListener("error", () => rejectOnce(new Error("Discord gateway socket error")));
      websocket.addEventListener("close", (event) => {
        this.#connected = false;
        this.#clearHeartbeat();
        if (!settled) {
          settled = true;
          if (this.#stopped() || event.code === 1000) resolve();
          else reject(new Error(`Discord gateway closed (${event.code})`));
        }
      });
      websocket.addEventListener("message", (event) => {
        void this.#handleSocketMessage(websocket, event.data, firstConnection).then((reconnect) => {
          if (reconnect && !settled) websocket.close(1012, "Reconnect requested");
        }).catch(rejectOnce);
      });
    });
    if (this.#websocket === websocket) this.#websocket = undefined;
  }

  async #handleSocketMessage(
    websocket: WebSocket,
    source: unknown,
    firstConnection: Deferred<void>,
  ): Promise<boolean> {
    const payload = JSON.parse(await socketText(source)) as Record<string, unknown>;
    if (typeof payload.s === "number") this.#sequence = payload.s;
    const operation = Number(payload.op);
    if (operation === OP_HEARTBEAT_ACK) return false;
    if (operation === OP_HELLO) {
      const data = object(payload.d);
      const interval = positiveInteger(data.heartbeat_interval, 45_000);
      this.#clearHeartbeat();
      this.#heartbeat = setInterval(() => {
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.#sequence ?? null }));
        }
      }, interval);
      websocket.send(JSON.stringify({
        op: OP_IDENTIFY,
        d: {
          token: stringConfig(this.#context.config, "bot_token"),
          intents: positiveInteger(this.#context.config.gateway_intents, 37377),
          properties: { os: process.platform, browser: "cardbush", device: "cardbush" },
        },
      }));
      this.#connected = true;
      this.#lastError = "";
      firstConnection.resolve();
      return false;
    }
    if (operation === OP_RECONNECT || operation === OP_INVALID_SESSION) return true;
    if (operation !== OP_DISPATCH) return false;
    const eventType = String(payload.t ?? "");
    const data = object(payload.d);
    if (eventType === "READY") {
      this.#botUserId = String(object(data.user).id ?? "").trim();
    } else if (eventType === "MESSAGE_CREATE") {
      void this.#handleMessage(data).catch((error) => this.#context.log("error", errorMessage(error)));
    }
    return false;
  }

  async #handleMessage(data: Record<string, unknown>): Promise<void> {
    const author = object(data.author);
    if (author.bot === true) return;
    const userId = String(author.id ?? "").trim();
    const channelId = String(data.channel_id ?? "").trim();
    const messageId = String(data.id ?? "").trim();
    if (!userId || !channelId) return;
    if (!identityIsAllowed({
      userId,
      channelId,
      allowedUserIds: stringArray(this.#context.config.allowed_user_ids),
      allowedChannelIds: stringArray(this.#context.config.allowed_channel_ids),
    })) return;
    const dedupKey = messageId || String(data.nonce ?? "").trim();
    if (!this.#dedup.take(dedupKey)) return;
    const text = this.#messageText(data);
    if (!text) return;
    const envelope: ChatEnvelope = {
      platform: "discord",
      sessionId: `discord:${channelId}:${userId}`,
      userId,
      channelId,
      text,
      ...(messageId ? { messageId } : {}),
      rawEvent: data,
    };
    try {
      const reply = await this.#backend.respond(envelope, {
        signal: this.#context.signal,
        onPermissionRequest: async (request) => {
          await this.#sendText(channelId, formatPermissionRequest(request), messageId);
        },
      });
      await this.#sendText(channelId, reply.text, messageId);
    } catch (error) {
      await this.#context.log("error", `message failed: ${errorMessage(error)}`);
      await this.#sendText(channelId, `执行失败：${errorMessage(error)}`, messageId);
    }
  }

  #messageText(data: Record<string, unknown>): string {
    let text = String(data.content ?? "").trim();
    if (Number(data.channel_type ?? 0) === 1) return text;
    const mentioned = Array.isArray(data.mentions) && data.mentions.some(
      (item) => String(object(item).id ?? "") === this.#botUserId,
    );
    if (!this.#botUserId || !mentioned) return "";
    text = text.replaceAll(`<@${this.#botUserId}>`, "")
      .replaceAll(`<@!${this.#botUserId}>`, "").trim();
    return text;
  }

  async #sendText(channelId: string, text: string, replyTo?: string): Promise<void> {
    const chunks = splitText(text, 2000);
    for (let index = 0; index < chunks.length; index += 1) {
      const body: Record<string, unknown> = { content: chunks[index] };
      if (index === 0 && replyTo) {
        body.message_reference = { message_id: replyTo };
        body.allowed_mentions = { replied_user: false };
      }
      const response = await this.#fetch(
        `${stringConfig(this.#context.config, "api_base")}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bot ${stringConfig(this.#context.config, "bot_token")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: this.#context.signal,
        },
      );
      if (!response.ok) throw new Error(`Discord message delivery failed (${response.status})`);
    }
  }

  #clearHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  #stopped(): boolean {
    return this.#stopRequested || this.#context.signal.aborted;
  }
}

class ExpiringSet {
  readonly #entries = new Map<string, number>();
  constructor(readonly ttlMs: number, readonly maxEntries: number) {}

  take(key: string): boolean {
    if (!key) return true;
    const now = Date.now();
    for (const [entry, expires] of this.#entries) {
      if (expires <= now) this.#entries.delete(entry);
      else break;
    }
    if ((this.#entries.get(key) ?? 0) > now) return false;
    this.#entries.delete(key);
    this.#entries.set(key, now + this.ttlMs);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    return true;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringConfig(config: Readonly<Record<string, unknown>>, key: string): string {
  return String(config[key] ?? "").replace(/\/$/, "");
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitText(text: string, maximum: number): string[] {
  const source = text || " ";
  const chunks: string[] = [];
  for (let offset = 0; offset < source.length; offset += maximum) {
    chunks.push(source.slice(offset, offset + maximum));
  }
  return chunks;
}

async function socketText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.text();
  return String(value);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
