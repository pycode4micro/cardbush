import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  runtimeEventSchema,
  type RuntimeEvent,
} from "@cardbush/bush-protocol";

import type { RuntimeEventPersistence } from "./runtimeEventLog.js";

const RECORD_PROTOCOL = "bush.runtime_event_record.v1" as const;
const DURABILITY_BOUNDARIES = new Set<RuntimeEvent["kind"]>([
  "turn_accepted",
  "turn_started",
  "cache_chain_observed",
  "tool_running",
  "tool_completed",
  "tool_failed",
  "tool_cancelled",
  "permission_requested",
  "permission_answered",
  "permission_rejected",
  "permission_expired",
  "permission_cancelled",
  "replay_reset",
  "stream_resumed",
  "turn_terminal",
]);

export interface RuntimeEventJournalRecoveryIssue {
  code: "truncated_tail_removed";
  path: string;
  removedBytes: number;
}

export interface FileRuntimeEventPersistenceOptions {
  root: string;
  onRecoveryIssue?: (issue: RuntimeEventJournalRecoveryIssue) => void;
}

export class RuntimeEventJournalCorruptionError extends Error {
  readonly code = "runtime_event_journal_corrupt" as const;
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string) {
    super(message);
    this.name = "RuntimeEventJournalCorruptionError";
    this.path = path;
    this.line = line;
  }
}

export class FileRuntimeEventPersistence implements RuntimeEventPersistence {
  readonly #root: string;
  readonly #onRecoveryIssue?: FileRuntimeEventPersistenceOptions["onRecoveryIssue"];
  readonly #descriptors = new Map<string, number>();

  constructor(options: FileRuntimeEventPersistenceOptions) {
    const root = String(options.root || "").trim();
    if (!root) throw new Error("Runtime event persistence requires an explicit root.");
    if (!isAbsolute(root)) {
      throw new Error("Runtime event persistence root must be absolute.");
    }
    this.#root = resolve(root);
    this.#onRecoveryIssue = options.onRecoveryIssue;
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#root, 0o700);
    } catch {
      // Windows applies the current user's directory ACL instead of POSIX mode bits.
    }
  }

  load(sessionId: string, turnId: string): RuntimeEvent[] {
    const path = this.#path(sessionId, turnId);
    if (!existsSync(path)) return [];
    let bytes = readFileSync(path);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (bytes.length > 0 && lastNewline !== bytes.length - 1) {
      const retainedBytes = lastNewline >= 0 ? lastNewline + 1 : 0;
      const removedBytes = bytes.length - retainedBytes;
      truncateSync(path, retainedBytes);
      bytes = bytes.subarray(0, retainedBytes);
      this.#onRecoveryIssue?.({
        code: "truncated_tail_removed",
        path,
        removedBytes,
      });
    }
    const text = bytes.toString("utf8");
    if (!text) return [];
    return text
      .split("\n")
      .filter(Boolean)
      .map((line, index) => this.#decodeRecord(path, index + 1, line));
  }

  append(event: RuntimeEvent): void {
    const validated = runtimeEventSchema.parse(event);
    const path = this.#path(validated.sessionId, validated.turnId);
    const eventJson = JSON.stringify(validated);
    const record = JSON.stringify({
      protocol: RECORD_PROTOCOL,
      checksum: checksum(eventJson),
      event: validated,
    });
    const descriptor = this.#descriptor(path);
    writeSync(descriptor, `${record}\n`, undefined, "utf8");
    if (isDurabilityBoundary(validated.kind)) {
      fsyncSync(descriptor);
    }
    if (validated.kind === "turn_terminal") {
      closeSync(descriptor);
      this.#descriptors.delete(path);
    }
  }

  close(): void {
    for (const descriptor of this.#descriptors.values()) closeSync(descriptor);
    this.#descriptors.clear();
  }

  #decodeRecord(path: string, lineNumber: number, line: string): RuntimeEvent {
    try {
      const candidate = JSON.parse(line) as Record<string, unknown>;
      if (candidate.protocol !== RECORD_PROTOCOL) {
        throw new Error("record protocol mismatch");
      }
      const event = runtimeEventSchema.parse(candidate.event);
      const eventJson = JSON.stringify(event);
      if (candidate.checksum !== checksum(eventJson)) {
        throw new Error("record checksum mismatch");
      }
      return event;
    } catch (error) {
      throw new RuntimeEventJournalCorruptionError(
        path,
        lineNumber,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #path(sessionId: string, turnId: string): string {
    const identity = JSON.stringify([sessionId, turnId]);
    const key = createHash("sha256").update(identity).digest("hex");
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

function isDurabilityBoundary(kind: RuntimeEvent["kind"]): boolean {
  return DURABILITY_BOUNDARIES.has(kind);
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
