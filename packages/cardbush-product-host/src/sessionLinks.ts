import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { replaceFile } from "./atomicFiles.js";
import type { ChatEnvelope, ChatReply, ConversationBackend } from "./conversation.js";

interface PendingLink {
  code: string;
  sessionId: string;
  platform?: string;
  expiresAt: string;
}

interface SessionLinkDocument {
  revision: number;
  pending: PendingLink[];
  bindings: Record<string, string>;
}

export class SessionLinkStore {
  readonly #path: string;
  #operation = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async issue(input: {
    sessionId: string;
    platform?: string;
    expiresSeconds: number;
  }): Promise<PendingLink> {
    return this.#exclusive(async () => {
      const document = await this.#read();
      const now = Date.now();
      document.pending = document.pending.filter((item) => Date.parse(item.expiresAt) > now);
      let code = "";
      do code = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
      while (document.pending.some((item) => item.code === code));
      const link: PendingLink = {
        code,
        sessionId: input.sessionId,
        ...(input.platform ? { platform: input.platform } : {}),
        expiresAt: new Date(now + input.expiresSeconds * 1000).toISOString(),
      };
      document.pending.push(link);
      document.revision += 1;
      await this.#write(document);
      return link;
    });
  }

  async resolve(envelope: ChatEnvelope): Promise<{
    sessionId: string;
    linked: boolean;
  }> {
    return this.#exclusive(async () => {
      const document = await this.#read();
      const key = bindingKey(envelope);
      const code = envelope.text.trim().toUpperCase();
      const now = Date.now();
      const index = document.pending.findIndex((item) =>
        item.code === code &&
        Date.parse(item.expiresAt) > now &&
        (!item.platform || item.platform === envelope.platform));
      let changed = false;
      let linked = false;
      if (index >= 0) {
        const [item] = document.pending.splice(index, 1);
        document.bindings[key] = item!.sessionId;
        linked = true;
        changed = true;
      }
      const valid = document.pending.filter((item) => Date.parse(item.expiresAt) > now);
      if (valid.length !== document.pending.length) {
        document.pending = valid;
        changed = true;
      }
      if (changed) {
        document.revision += 1;
        await this.#write(document);
      }
      return { sessionId: document.bindings[key] ?? envelope.sessionId, linked };
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #read(): Promise<SessionLinkDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<SessionLinkDocument>;
      return {
        revision: Number.isInteger(parsed.revision) ? Number(parsed.revision) : 0,
        pending: Array.isArray(parsed.pending) ? parsed.pending.filter(validPending) : [],
        bindings: objectStrings(parsed.bindings),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { revision: 0, pending: [], bindings: {} };
    }
  }

  async #write(document: SessionLinkDocument): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await replaceFile(temporary, this.#path);
  }
}

export class LinkedConversationBackend implements ConversationBackend {
  constructor(
    readonly backend: ConversationBackend,
    readonly links: SessionLinkStore,
  ) {}

  async respond(
    envelope: ChatEnvelope,
    options?: Parameters<ConversationBackend["respond"]>[1],
  ): Promise<ChatReply> {
    const resolved = await this.links.resolve(envelope);
    if (resolved.linked) {
      return { text: "会话已连接，后续消息将继续此 CardBush 会话。", metadata: { linked: true } };
    }
    return this.backend.respond({ ...envelope, sessionId: resolved.sessionId }, options);
  }

  stopSession(sessionId: string): Promise<void> {
    return this.backend.stopSession?.(sessionId) ?? Promise.resolve();
  }

  close(): Promise<void> {
    return this.backend.close?.() ?? Promise.resolve();
  }
}

function bindingKey(envelope: ChatEnvelope): string {
  return `${envelope.platform}:${envelope.channelId}:${envelope.userId}`;
}

function validPending(value: unknown): value is PendingLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.code === "string" && typeof item.sessionId === "string" &&
    typeof item.expiresAt === "string" &&
    (item.platform == null || typeof item.platform === "string");
}

function objectStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}
