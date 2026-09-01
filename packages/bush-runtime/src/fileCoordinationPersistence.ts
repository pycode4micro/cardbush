import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  coordinationEventSchema,
  type CoordinationEvent,
} from "@cardbush/bush-protocol";

import type { CoordinationPersistence } from "./coordinationStore.js";

const RECORD_PROTOCOL = "bush.coordination_journal_record.v1" as const;

export class CoordinationJournalCorruptionError extends Error {
  readonly code = "coordination_journal_corrupt" as const;
  constructor(readonly path: string, readonly line: number, message: string) {
    super(message);
    this.name = "CoordinationJournalCorruptionError";
  }
}

export class FileCoordinationPersistence implements CoordinationPersistence {
  readonly #root: string;
  readonly #descriptors = new Map<string, number>();
  readonly #onTruncatedTail?: (input: { path: string; removedBytes: number }) => void;

  constructor(options: {
    root: string;
    onTruncatedTail?: (input: { path: string; removedBytes: number }) => void;
  }) {
    const root = String(options.root || "").trim();
    if (!root) throw new Error("Coordination persistence requires an explicit root.");
    if (!isAbsolute(root)) throw new Error("Coordination persistence root must be absolute.");
    this.#root = resolve(root);
    this.#onTruncatedTail = options.onTruncatedTail;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#root, 0o700);
    } catch {
      // Windows applies the current user's directory ACL instead of POSIX mode bits.
    }
  }

  load(sessionId: string): CoordinationEvent[] {
    const path = this.#path(sessionId);
    if (!existsSync(path)) return [];
    let bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (bytes.length > 0 && lastNewline !== bytes.length - 1) {
      const retained = lastNewline >= 0 ? lastNewline + 1 : 0;
      const removedBytes = bytes.length - retained;
      truncateSync(path, retained);
      bytes = bytes.subarray(0, retained);
      this.#onTruncatedTail?.({ path, removedBytes });
    }
    if (bytes.length === 0) return [];
    return bytes
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => this.#decode(path, index + 1, line, sessionId));
  }

  append(candidate: CoordinationEvent): void {
    const event = coordinationEventSchema.parse(candidate);
    const serialized = JSON.stringify(event);
    const line = JSON.stringify({
      protocol: RECORD_PROTOCOL,
      checksum: checksum(serialized),
      event,
    });
    const descriptor = this.#descriptor(this.#path(event.sessionId));
    writeSync(descriptor, `${line}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  }

  close(): void {
    for (const descriptor of this.#descriptors.values()) closeSync(descriptor);
    this.#descriptors.clear();
  }

  #decode(
    path: string,
    lineNumber: number,
    line: string,
    sessionId: string,
  ): CoordinationEvent {
    try {
      const candidate = JSON.parse(line) as Record<string, unknown>;
      if (candidate.protocol !== RECORD_PROTOCOL) throw new Error("record protocol mismatch");
      const persistedEventJson = JSON.stringify(candidate.event);
      if (candidate.checksum !== checksum(persistedEventJson)) {
        throw new Error("record checksum mismatch");
      }
      const event = coordinationEventSchema.parse(candidate.event);
      if (event.sessionId !== sessionId) throw new Error("session identity mismatch");
      return event;
    } catch (error) {
      throw new CoordinationJournalCorruptionError(
        path,
        lineNumber,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #path(sessionId: string): string {
    return resolve(
      this.#root,
      `${createHash("sha256").update(sessionId).digest("hex")}.jsonl`,
    );
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
