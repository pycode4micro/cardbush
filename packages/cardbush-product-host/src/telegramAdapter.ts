import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { BotAdapter, BotAdapterContext, BotAdapterFactory, BotRuntimeStatus } from "./botSupervisor.js";
import type { BotDeliveryRequest, BotDeliveryResult, ChatEnvelope, ConversationBackend } from "./conversation.js";
import { identityIsAllowed } from "./conversation.js";
import { replaceFile } from "./atomicFiles.js";
import { downloadInboundMedia } from "./inboundMedia.js";

export interface TelegramAdapterDependencies {
  backend: ConversationBackend;
  fetch?: typeof globalThis.fetch;
}

export function createTelegramAdapterFactory(
  dependencies: TelegramAdapterDependencies,
): BotAdapterFactory {
  return (context) => new TelegramPollingAdapter(context, dependencies);
}

export class TelegramPollingAdapter implements BotAdapter {
  readonly #context: BotAdapterContext;
  readonly #backend: ConversationBackend;
  readonly #fetch: typeof globalThis.fetch;
  readonly #statePath: string;
  #task?: Promise<void>;
  #botId = "";
  #botUsername = "";
  #offset = 0;
  #lastError = "";

  constructor(context: BotAdapterContext, dependencies: TelegramAdapterDependencies) {
    this.#context = context;
    this.#backend = dependencies.backend;
    this.#fetch = dependencies.fetch ?? globalThis.fetch;
    this.#statePath = join(context.dataDir, "telegram-state.json");
  }

  async start(): Promise<void> {
    const identity = await this.#request("getMe", {}, this.#context.signal);
    const result = record(identity.result);
    this.#botId = String(result.id ?? "");
    this.#botUsername = String(result.username ?? "").trim();
    if (!this.#botId) throw new Error("Telegram getMe omitted the Bot identity");
    this.#offset = await this.#readOffset();
    this.#task = this.#poll();
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.#task ? [this.#task] : []);
    this.#task = undefined;
    await this.#backend.close?.();
  }

  status(): BotRuntimeStatus {
    return {
      healthStatus: this.#lastError ? "degraded" : "healthy",
      lastError: this.#lastError,
      accounts: [{
        account_id: this.#botId,
        username: this.#botUsername,
        status: "running",
      }],
    };
  }

  async deliver(request: BotDeliveryRequest): Promise<BotDeliveryResult> {
    const chatId = sessionPart(request.sessionId, "telegram", 1);
    const messageIds: string[] = [];
    for (let index = 0; index < request.paths.length; index += 1) {
      const path = request.paths[index];
      const form = new FormData();
      form.append("chat_id", chatId);
      if (index === 0 && request.text) form.append("caption", request.text.slice(0, 1024));
      form.append("document", new Blob([await readFile(path)]), basename(path));
      const token = String(this.#context.config.bot_token ?? "").trim();
      const base = String(this.#context.config.api_base ?? "https://api.telegram.org").replace(/\/$/, "");
      const response = await this.#fetch(`${base}/bot${token}/sendDocument`, {
        method: "POST",
        body: form,
        signal: this.#context.signal,
      });
      const source = await response.text();
      let payload: Record<string, unknown> = {};
      try { payload = record(JSON.parse(source)); } catch {}
      if (!response.ok || payload.ok !== true) {
        throw new Error(`Telegram file delivery failed (${response.status}): ${String(payload.description ?? source).slice(0, 500)}`);
      }
      const result = record(payload.result);
      if (result.message_id != null) messageIds.push(String(result.message_id));
    }
    return { channel: "telegram", delivered: [...request.paths], messageIds };
  }

  async #poll(): Promise<void> {
    let failures = 0;
    while (!this.#context.signal.aborted) {
      try {
        const payload = await this.#request("getUpdates", {
          offset: this.#offset,
          timeout: positiveNumber(this.#context.config.poll_timeout_seconds, 35),
          allowed_updates: ["message"],
        }, this.#context.signal, positiveNumber(this.#context.config.poll_timeout_seconds, 35) * 1000 + 5_000);
        failures = 0;
        this.#lastError = "";
        const updates = Array.isArray(payload.result) ? payload.result : [];
        for (const raw of updates) {
          const update = record(raw);
          const updateId = Number(update.update_id);
          if (Number.isInteger(updateId) && updateId >= this.#offset) {
            this.#offset = updateId + 1;
          }
          await this.#handle(update);
          await this.#writeOffset();
        }
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

  async #handle(update: Record<string, unknown>): Promise<void> {
    const message = record(update.message);
    const chat = record(message.chat);
    const sender = record(message.from);
    const messageId = String(message.message_id ?? "");
    const chatId = String(chat.id ?? "");
    const userId = String(sender.id ?? "");
    if (!chatId || !userId || sender.is_bot === true) return;
    if (!identityIsAllowed({
      userId,
      channelId: chatId,
      allowedUserIds: stringArray(this.#context.config.allowed_user_ids),
      allowedChannelIds: stringArray(this.#context.config.allowed_channel_ids),
    })) return;
    let text = String(message.text ?? message.caption ?? "").trim();
    const chatType = String(chat.type ?? "");
    if (chatType !== "private") {
      const mention = this.#botUsername ? `@${this.#botUsername}` : "";
      if (!mention || !text.toLowerCase().includes(mention.toLowerCase())) return;
      text = text.replace(new RegExp(escapeRegExp(mention), "ig"), "").trim();
    }
    const media = await this.#downloadMedia(message, messageId);
    if (!text && !media.length) return;
    if (!text) text = "The user sent the attached resources.";
    const envelope: ChatEnvelope = {
      platform: "telegram",
      sessionId: `telegram:${chatId}:${userId}`,
      userId,
      channelId: chatId,
      text,
      files: media.filter((item) => item.kind === "file").map((item) => item.path),
      images: media.filter((item) => item.kind === "image").map((item) => item.path),
      ...(messageId ? { messageId } : {}),
      rawEvent: update,
    };
    try {
      const reply = await this.#backend.respond(envelope, {
        signal: this.#context.signal,
        onPermissionRequest: (request) => this.#send(chatId, formatPermissionRequest(request)),
      });
      await this.#send(chatId, reply.text);
    } catch (error) {
      await this.#context.log("error", `message failed: ${errorMessage(error)}`);
      await this.#send(chatId, `执行失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async #downloadMedia(message: Record<string, unknown>, messageId: string) {
    const candidates: Array<{ fileId: string; name: string; mediaType: string }> = [];
    const photos = Array.isArray(message.photo)
      ? message.photo.filter((item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const photo = [...photos].sort(
      (left, right) => Number(right.file_size ?? 0) - Number(left.file_size ?? 0),
    )[0];
    if (photo?.file_id) {
      candidates.push({ fileId: String(photo.file_id), name: "photo.jpg", mediaType: "image/jpeg" });
    }
    for (const [field, fallback] of [
      ["document", "attachment"],
      ["video", "video.mp4"],
      ["audio", "audio.mp3"],
      ["voice", "voice.ogg"],
    ] as const) {
      const item = record(message[field]);
      if (!item.file_id) continue;
      candidates.push({
        fileId: String(item.file_id),
        name: String(item.file_name ?? fallback),
        mediaType: String(item.mime_type ?? ""),
      });
    }
    const media = [];
    for (const candidate of candidates.slice(0, 4)) {
      const file = record((await this.#request("getFile", { file_id: candidate.fileId }, this.#context.signal)).result);
      const filePath = String(file.file_path ?? "").trim();
      if (!filePath) throw new Error("Telegram getFile omitted file_path");
      const token = String(this.#context.config.bot_token ?? "").trim();
      const base = String(this.#context.config.api_base ?? "https://api.telegram.org").replace(/\/$/, "");
      media.push(await downloadInboundMedia({
        url: `${base}/file/bot${token}/${filePath.replace(/^\/+/, "")}`,
        directory: join(this.#context.dataDir, "inbound", messageId || crypto.randomUUID()),
        name: candidate.name,
        mediaType: candidate.mediaType,
        fetch: this.#fetch,
        signal: this.#context.signal,
      }));
    }
    return media;
  }

  async #send(chatId: string, text: string): Promise<void> {
    await this.#request("sendMessage", { chat_id: chatId, text }, this.#context.signal);
  }

  async #request(
    method: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = positiveNumber(this.#context.config.api_timeout_seconds, 15) * 1000,
  ): Promise<Record<string, unknown>> {
    const token = String(this.#context.config.bot_token ?? "").trim();
    if (!token) throw new Error("Telegram bot token is missing");
    const base = String(this.#context.config.api_base ?? "https://api.telegram.org").replace(/\/$/, "");
    const response = await this.#fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    const source = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(source); } catch { throw new Error("Telegram API returned invalid JSON"); }
    const result = record(payload);
    if (!response.ok || result.ok !== true) {
      throw new Error(`Telegram API failed (${response.status}): ${String(result.description ?? source).slice(0, 500)}`);
    }
    return result;
  }

  async #readOffset(): Promise<number> {
    try {
      const payload = record(JSON.parse(await readFile(this.#statePath, "utf8")));
      const value = Number(payload.offset);
      return Number.isInteger(value) && value >= 0 ? value : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async #writeOffset(): Promise<void> {
    await mkdir(dirname(this.#statePath), { recursive: true });
    const temporary = `${this.#statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ offset: this.#offset })}\n`, "utf8");
    await replaceFile(temporary, this.#statePath);
  }
}

function sessionPart(sessionId: string, platform: string, index: number): string {
  const parts = sessionId.split(":");
  if (parts[0] !== platform || !parts[index]) throw new Error(`Invalid ${platform} Session identity`);
  return parts[index];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
