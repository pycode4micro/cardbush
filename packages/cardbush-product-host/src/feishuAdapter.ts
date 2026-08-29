import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";

import type { BotAdapter, BotAdapterContext, BotAdapterFactory, BotRuntimeStatus } from "./botSupervisor.js";
import type { BotDeliveryRequest, BotDeliveryResult, ChatEnvelope, ConversationBackend } from "./conversation.js";
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
  sendFile(chatId: string, path: string): Promise<string>;
  downloadResource(messageId: string, resourceKey: string, type: "file" | "image", path: string): Promise<void>;
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

  async deliver(request: BotDeliveryRequest): Promise<BotDeliveryResult> {
    const chatId = sessionPart(request.sessionId, "feishu", 1);
    const messageIds: string[] = [];
    for (const path of request.paths) {
      messageIds.push(await this.#connector.sendFile(chatId, path));
    }
    return { channel: "feishu", delivered: [...request.paths], messageIds };
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
    const mentions = message.mentions ?? [];
    if (message.chat_type !== "p2p" && mentions.length === 0) return;
    const content = parseContent(message.content);
    const media = await this.#downloadMessageResource(message, content);
    const source = String(content.text ?? "");
    const text = mentions.reduce((value, mention) => value.replaceAll(mention.key, ""), source).trim()
      || (media.length ? "The user sent the attached resources." : "");
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
      files: media.filter((item) => item.type === "file").map((item) => item.path),
      images: media.filter((item) => item.type === "image").map((item) => item.path),
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

  async #downloadMessageResource(
    message: FeishuMessageEvent["message"],
    content: Record<string, unknown>,
  ): Promise<Array<{ type: "file" | "image"; path: string }>> {
    const type = message.message_type === "image" ? "image"
      : message.message_type === "file" || message.message_type === "audio" || message.message_type === "media"
        ? "file"
        : undefined;
    if (!type) return [];
    const key = String(type === "image" ? content.image_key : content.file_key ?? content.file_token ?? "").trim();
    if (!key) throw new Error(`Feishu ${type} message omitted its resource key`);
    const rawName = String(content.file_name ?? content.name ?? `${type}-${message.message_id}`).trim();
    const name = safeFileName(rawName, type === "image" ? ".png" : "");
    const directory = join(this.#context.dataDir, "inbound", message.message_id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${crypto.randomUUID()}-${name}`);
    await this.#connector.downloadResource(message.message_id, key, type, path);
    return [{ type, path }];
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
    async sendFile(chatId, path) {
      const uploaded = await client.im.file.create({
        data: {
          file_type: "stream",
          file_name: basename(path),
          file: createReadStream(path),
        },
      });
      if (!uploaded?.file_key) throw new Error("Feishu file upload returned no file key");
      const sent = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "file",
          content: JSON.stringify({ file_key: uploaded.file_key }),
        },
      });
      if ((sent.code ?? 0) !== 0) {
        throw new Error(`Feishu file delivery failed (${sent.code}): ${sent.msg ?? ""}`);
      }
      return String(sent.data?.message_id ?? "");
    },
    async downloadResource(messageId, resourceKey, type, path) {
      const result = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: resourceKey },
        params: { type },
      });
      await result.writeFile(path);
    },
  };
}

function sessionPart(sessionId: string, platform: string, index: number): string {
  const parts = sessionId.split(":");
  if (parts[0] !== platform || !parts[index]) throw new Error(`Invalid ${platform} Session identity`);
  return parts[index];
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

function parseContent(content: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(content);
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeFileName(value: string, extension: string): string {
  const name = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || `attachment${extension}`;
  return name.includes(".") || !extension ? name : `${name}${extension}`;
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
