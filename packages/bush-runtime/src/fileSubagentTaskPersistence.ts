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

import { subagentEventSchema, type SubagentEvent } from "@cardbush/bush-protocol";
import type { SubagentTaskPersistence } from "./subagentTaskStore.js";

const RECORD_PROTOCOL = "bush.subagent_journal_record.v1" as const;

export class SubagentJournalCorruptionError extends Error {
  readonly code = "subagent_journal_corrupt" as const;
  constructor(readonly path: string, readonly line: number, message: string) {
    super(message);
    this.name = "SubagentJournalCorruptionError";
  }
}

export class FileSubagentTaskPersistence implements SubagentTaskPersistence {
  readonly #root: string;
  readonly #descriptors = new Map<string, number>();
  readonly #onTruncatedTail?: (input: { path: string; removedBytes: number }) => void;

  constructor(options: {
    root: string;
    onTruncatedTail?: (input: { path: string; removedBytes: number }) => void;
  }) {
    const root = String(options.root || "").trim();
    if (!root) throw new Error("Subagent persistence requires an explicit root.");
    if (!isAbsolute(root)) throw new Error("Subagent persistence root must be absolute.");
    this.#root = resolve(root);
    this.#onTruncatedTail = options.onTruncatedTail;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try { chmodSync(this.#root, 0o700); } catch { /* Windows uses the user ACL. */ }
  }

  load(parentSessionId: string): SubagentEvent[] {
    const path = this.#path(parentSessionId);
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
    return bytes.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
      try {
        const candidate = JSON.parse(line) as Record<string, unknown>;
        if (candidate.protocol !== RECORD_PROTOCOL) throw new Error("record protocol mismatch");
        const event = subagentEventSchema.parse(candidate.event);
        if (event.parentSessionId !== parentSessionId) throw new Error("session identity mismatch");
        if (candidate.checksum !== checksum(JSON.stringify(event))) {
          throw new Error("record checksum mismatch");
        }
        return event;
      } catch (error) {
        throw new SubagentJournalCorruptionError(
          path,
          index + 1,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  append(candidate: SubagentEvent): void {
    const event = subagentEventSchema.parse(candidate);
    const serialized = JSON.stringify(event);
    const line = JSON.stringify({ protocol: RECORD_PROTOCOL, checksum: checksum(serialized), event });
    const descriptor = this.#descriptor(this.#path(event.parentSessionId));
    writeSync(descriptor, `${line}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  }

  close(): void {
    for (const descriptor of this.#descriptors.values()) closeSync(descriptor);
    this.#descriptors.clear();
  }

  #path(parentSessionId: string): string {
    return resolve(this.#root, `${createHash("sha256").update(parentSessionId).digest("hex")}.jsonl`);
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
