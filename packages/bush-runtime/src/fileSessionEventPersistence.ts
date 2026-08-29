import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { sessionEventSchema, type SessionEvent } from "@cardbush/bush-protocol";

import type { SessionEventPersistence } from "./sessionStore.js";

const RECORD_PROTOCOL = "bush.session_event_record.v1" as const;

export interface SessionJournalRecoveryIssue {
  code: "truncated_tail_removed";
  path: string;
  removedBytes: number;
}

export interface FileSessionEventPersistenceOptions {
  root: string;
  onRecoveryIssue?: (issue: SessionJournalRecoveryIssue) => void;
}

export class SessionJournalCorruptionError extends Error {
  readonly code = "session_event_journal_corrupt" as const;
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string) {
    super(message);
    this.name = "SessionJournalCorruptionError";
    this.path = path;
    this.line = line;
  }
}

export class FileSessionEventPersistence implements SessionEventPersistence {
  readonly #root: string;
  readonly #onRecoveryIssue?: FileSessionEventPersistenceOptions["onRecoveryIssue"];
  readonly #descriptors = new Map<string, number>();

  constructor(options: FileSessionEventPersistenceOptions) {
    const root = String(options.root || "").trim();
    if (!root) throw new Error("Session persistence requires an explicit root.");
    if (!isAbsolute(root)) throw new Error("Session persistence root must be absolute.");
    this.#root = resolve(root);
    this.#onRecoveryIssue = options.onRecoveryIssue;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#root, 0o700);
    } catch {
      // Windows applies the current user's directory ACL instead of POSIX mode bits.
    }
  }

  load(sessionId: string): SessionEvent[] {
    const path = this.#path(sessionId);
    if (!existsSync(path)) return [];
    let bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (bytes.length > 0 && lastNewline !== bytes.length - 1) {
      const retainedBytes = lastNewline >= 0 ? lastNewline + 1 : 0;
      const removedBytes = bytes.length - retainedBytes;
      truncateSync(path, retainedBytes);
      bytes = bytes.subarray(0, retainedBytes);
      this.#onRecoveryIssue?.({ code: "truncated_tail_removed", path, removedBytes });
    }
    const text = bytes.toString("utf8");
    if (!text) return [];
    return text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => this.#decode(path, index + 1, line, sessionId));
  }

  append(candidate: SessionEvent): void {
    const event = sessionEventSchema.parse(candidate);
    const path = this.#path(event.sessionId);
    const eventJson = JSON.stringify(event);
    const record = JSON.stringify({
      protocol: RECORD_PROTOCOL,
      checksum: checksum(eventJson),
      event,
    });
    const descriptor = this.#descriptor(path);
    writeSync(descriptor, `${record}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  }

  listSessionIds(): string[] {
    const identities = new Set<string>();
    for (const name of readdirSync(this.#root)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = resolve(this.#root, name);
      const first = readFileSync(path, "utf8").split("\n").find(Boolean);
      if (!first) continue;
      try {
        const record = JSON.parse(first) as Record<string, unknown>;
        if (record.protocol !== RECORD_PROTOCOL) throw new Error("record protocol mismatch");
        const event = sessionEventSchema.parse(record.event);
        this.#decode(path, 1, first, event.sessionId);
        identities.add(event.sessionId);
      } catch (error) {
        throw new SessionJournalCorruptionError(
          path,
          1,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return [...identities];
  }

  remove(sessionId: string): boolean {
    const path = this.#path(sessionId);
    const descriptor = this.#descriptors.get(path);
    if (descriptor !== undefined) {
      closeSync(descriptor);
      this.#descriptors.delete(path);
    }
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  close(): void {
    for (const descriptor of this.#descriptors.values()) closeSync(descriptor);
    this.#descriptors.clear();
  }

  #decode(path: string, line: number, value: string, sessionId: string): SessionEvent {
    try {
      const record = JSON.parse(value) as Record<string, unknown>;
      if (record.protocol !== RECORD_PROTOCOL) throw new Error("record protocol mismatch");
      const event = sessionEventSchema.parse(record.event);
      if (event.sessionId !== sessionId) throw new Error("session identity mismatch");
      if (record.checksum !== checksum(JSON.stringify(event))) {
        throw new Error("record checksum mismatch");
      }
      return event;
    } catch (error) {
      throw new SessionJournalCorruptionError(
        path,
        line,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #path(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return resolve(this.#root, `${key}.jsonl`);
  }

  #descriptor(path: string): number {
    const existing = this.#descriptors.get(path);
    if (existing !== undefined) return existing;
    const descriptor = openSync(path, "a", 0o600);
    this.#descriptors.set(path, descriptor);
    return descriptor;
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
