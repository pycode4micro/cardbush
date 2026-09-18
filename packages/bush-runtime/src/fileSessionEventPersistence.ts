import { createHash } from "node:crypto";
import { boundedJournalLines } from './boundedJournalLines.js';
import { cacheFiles } from './cacheMaintenance.js';
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

import type { SessionEventPersistence, SessionMetadataEntry } from "./sessionStore.js";

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
  readonly #metadata = new Map<string, { size: number; mtimeMs: number; entry: SessionMetadataEntry }>();

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
    this.#metadata.delete(path);
  }

  async listMetadata(skip: Set<string>, signal?: AbortSignal): Promise<SessionMetadataEntry[]> {
    const ignored = new Set([...skip].map(id => this.#path(id)));
    const entries: SessionMetadataEntry[] = [];
    const files = await cacheFiles(this.#root, name => /^[a-f0-9]{64}\.jsonl$/.test(name));
    const paths = new Set(files.map(file => file.path));
    for (const key of this.#metadata.keys()) if (!paths.has(key)) this.#metadata.delete(key);
    for (const file of files) {
      const path = file.path;
      signal?.throwIfAborted();
      if (ignored.has(path)) continue;
      const source = { size: file.bytes, mtimeMs: file.mtimeMs };
      const cached = this.#metadata.get(path);
      if (cached?.size === source.size && cached.mtimeMs === source.mtimeMs) { entries.push(structuredClone(cached.entry)); continue; }
      let entry: SessionMetadataEntry | undefined;
      let lineNumber = 0;
      for await (const line of boundedJournalLines(path, { end: source.size, maxBytes: 1024 * 1024, signal,
        skip: prefix => prefix.includes(',"payload":') && !/"kind":"session_(?:created|metadata_updated)"/.test(prefix.split(',"payload":')[0]!),
      })) {
        lineNumber++;
        // The serialized envelope precedes payload; never parse large committed Turns just to find their project.
        const envelope = line.prefix.split(',"payload":')[0]!;
        if (!/"kind":"session_(?:created|metadata_updated)"/.test(envelope)) continue;
        if (!line.text) throw new SessionJournalCorruptionError(path, lineNumber, 'Session metadata is too large to inspect.');
        const raw = JSON.parse(line.text);
        const sessionId = raw.event?.sessionId;
        if (typeof sessionId !== 'string' || this.#path(sessionId) !== path) throw new SessionJournalCorruptionError(path, lineNumber, 'session identity mismatch');
        const event = this.#decode(path, lineNumber, line.text, sessionId);
        if (event.kind === 'session_created' || event.kind === 'session_metadata_updated') entry = { sessionId, metadata: event.payload.metadata ?? {} };
      }
      if (entry) { this.#metadata.set(path, { size: source.size, mtimeMs: source.mtimeMs, entry }); entries.push(structuredClone(entry)); }
    }
    return entries;
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
    this.#metadata.delete(path);
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
    this.#metadata.clear();
  }

  #decode(path: string, line: number, value: string, sessionId: string): SessionEvent {
    try {
      const record = JSON.parse(value) as Record<string, unknown>;
      if (record.protocol !== RECORD_PROTOCOL) throw new Error("record protocol mismatch");
      const persistedEventJson = JSON.stringify(record.event);
      if (record.checksum !== checksum(persistedEventJson)) {
        throw new Error("record checksum mismatch");
      }
      const event = sessionEventSchema.parse(record.event);
      if (event.sessionId !== sessionId) throw new Error("session identity mismatch");
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
