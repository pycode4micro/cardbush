import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";

import type { BotAdapter, BotAdapterContext, BotAdapterFactory, BotRuntimeStatus } from "./botSupervisor.js";
import type { ChatEnvelope, ConversationBackend } from "./conversation.js";
import { identityIsAllowed } from "./conversation.js";

export interface FeishuMessageEvent {
  event_id?: string;
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string }>;
  };
}

export interface FeishuConnector {
  start(handler: (event: FeishuMessageEvent) => void | Promise<void>): Promise<void>;
  stop(): Promise<void>;
  status(): { state: string };
  replyText(messageId: string, text: string): Promise<void>;
  addReaction(messageId: string, emoji: string): Promise<void>;
}

export interface FeishuAdapterDependencies {
  backend: ConversationBackend;
  createConnector?: (context: BotAdapterContext) => FeishuConnector;
  connectTimeoutMs?: number;
}

export function createFeishuAdapterFactory(
  dependencies: FeishuAdapterDependencies,
): BotAdapterFactory {
  return (context) => new FeishuLongConnectionAdapter(context, dependencies);
}

export class FeishuLongConnectionAdapter implements BotAdapter {
  readonly #context: BotAdapterContext;
  readonly #backend: ConversationBackend;
  readonly #connector: FeishuConnector;
  readonly #connectTimeoutMs: number;
  readonly #dedup = new ExpiringSet(28_800_000, 4096);
  #lastError = "";
  #started = false;

  constructor(context: BotAdapterContext, dependencies: FeishuAdapterDependencies) {
    this.#context = context;
    this.#backend = dependencies.backend;
    this.#connector = (dependencies.createConnector ?? createSdkConnector)(context);
    this.#connectTimeoutMs = dependencies.connectTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    try {
      await withTimeout(
        this.#connector.start((event) => this.#handle(event)),
        this.#connectTimeoutMs,
        "Feishu long connection timed out",
      );
      this.#started = true;
      this.#lastError = "";
    } catch (error) {
      this.#lastError = errorMessage(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.#connector.stop();
    this.#started = false;
    await this.#backend.close?.();
  }

  status(): BotRuntimeStatus {
    const state = this.#connector.status().state;
    return {
      healthStatus: state === "connected" ? "healthy" : state,
      errorCode: this.#lastError ? "feishu_connection_error" : "",
      lastError: this.#lastError,
    };
  }

  async #handle(event: FeishuMessageEvent): Promise<void> {
    const message = event.message;
    if (!message?.message_id || !message.chat_id) return;
    if (event.sender?.sender_type === "app") return;
    const userId = String(
      event.sender?.sender_id?.open_id ??
      event.sender?.sender_id?.user_id ??
      event.sender?.sender_id?.union_id ?? "",
    ).trim();
    if (!userId) return;
    if (!identityIsAllowed({
      userId,
      channelId: message.chat_id,
      allowedUserIds: strings(this.#context.config.allowed_user_ids),
      allowedChannelIds: strings(this.#context.config.allowed_channel_ids),
    })) return;
    if (!this.#dedup.take(message.message_id || event.event_id || "")) return;
    if (message.message_type !== "text") {
      await this.#connector.replyText(message.message_id, "当前仅支持文本消息。");
      return;
    }
    const source = parseTextContent(message.content);
    const mentions = message.mentions ?? [];
    if (message.chat_type !== "p2p" && mentions.length === 0) return;
    const text = mentions.reduce(
      (value, mention) => value.replaceAll(mention.key, ""),
      source,
    ).trim();
    if (!text) return;
    const ackMode = String(this.#context.config.ack_mode ?? "reaction");
    if (ackMode === "reaction") {
      await this.#connector.addReaction(
        message.message_id,
        String(this.#context.config.ack_reaction_emoji ?? "OK"),
      ).catch((error) => this.#context.log("warning", `ack failed: ${errorMessage(error)}`));
    }
    const envelope: ChatEnvelope = {
      platform: "feishu",
      sessionId: `feishu:${message.chat_id}:${userId}`,
      userId,
      channelId: message.chat_id,
      text,
      messageId: message.message_id,
      ...(message.thread_id ? { threadId: message.thread_id } : {}),
      rawEvent: event as unknown as Record<string, unknown>,
    };
    try {
      const reply = await this.#backend.respond(envelope, {
        signal: this.#context.signal,
        onPermissionRequest: (request) => this.#connector.replyText(
          message.message_id,
          formatPermissionRequest(request),
        ),
      });
      await this.#connector.replyText(message.message_id, reply.text);
    } catch (error) {
      await this.#context.log("error", `message failed: ${errorMessage(error)}`);
      await this.#connector.replyText(message.message_id, `执行失败：${errorMessage(error)}`);
    }
  }
}

function createSdkConnector(context: BotAdapterContext): FeishuConnector {
  const appId = String(context.config.app_id ?? "");
  const appSecret = String(context.config.app_secret ?? "");
  const domain = String(context.config.api_base ?? "https://open.feishu.cn");
  const client = new Client({ appId, appSecret, domain, source: "cardbush" });
  let ws: WSClient | undefined;
  let connectionState = "idle";
  return {
    async start(handler) {
      const ready = deferred<void>();
      const dispatcher = new EventDispatcher({
        verificationToken: String(context.config.verification_token ?? ""),
        encryptKey: String(context.config.encrypt_key ?? ""),
      }).register({
        "im.message.receive_v1": handler,
      });
      ws = new WSClient({
        appId,
        appSecret,
        domain,
        autoReconnect: true,
        source: "cardbush",
        handshakeTimeoutMs: 20_000,
        onReady: () => { connectionState = "connected"; ready.resolve(); },
        onError: (error) => { connectionState = "failed"; ready.reject(error); },
        onReconnecting: () => { connectionState = "reconnecting"; },
        onReconnected: () => { connectionState = "connected"; },
      });
      connectionState = "connecting";
      void ws.start({ eventDispatcher: dispatcher }).catch((error) => ready.reject(error));
      await ready.promise;
    },
    async stop() {
      ws?.close({ force: false });
      ws = undefined;
      connectionState = "idle";
    },
    status() {
      return { state: ws?.getConnectionStatus().state ?? connectionState };
    },
    async replyText(messageId, text) {
      const result = await client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text }) },
      });
      if ((result.code ?? 0) !== 0) throw new Error(`Feishu reply failed (${result.code}): ${result.msg ?? ""}`);
    },
    async addReaction(messageId, emoji) {
      const result = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      if ((result.code ?? 0) !== 0) throw new Error(`Feishu reaction failed (${result.code}): ${result.msg ?? ""}`);
    },
  };
}

class ExpiringSet {
  readonly #entries = new Map<string, number>();
  constructor(readonly ttlMs: number, readonly maximum: number) {}
  take(key: string): boolean {
    if (!key) return true;
    const now = Date.now();
    for (const [item, expires] of this.#entries) {
      if (expires <= now) this.#entries.delete(item);
    }
    if ((this.#entries.get(key) ?? 0) > now) return false;
    this.#entries.set(key, now + this.ttlMs);
    while (this.#entries.size > this.maximum) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (!first) break;
      this.#entries.delete(first);
    }
    return true;
  }
}

function parseTextContent(content: string): string {
  try {
    const payload: unknown = JSON.parse(content);
    return String(
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).text ?? ""
        : "",
    );
  } catch {
    return "";
  }
}

function strings(value: unknown): string[] {
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
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
