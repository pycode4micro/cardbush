import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  runtimeCheckpointSchema,
  type RuntimeCheckpoint,
} from "@cardbush/bush-protocol";

import type { RuntimeCheckpointStore } from "./runtimeCheckpointStore.js";

const RECORD_PROTOCOL = "bush.runtime_checkpoint_record.v1" as const;

export class RuntimeCheckpointCorruptionError extends Error {
  readonly code = "runtime_checkpoint_corrupt" as const;
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "RuntimeCheckpointCorruptionError";
    this.path = path;
  }
}

export class FileRuntimeCheckpointStore implements RuntimeCheckpointStore {
  readonly #root: string;

  constructor(root: string) {
    const normalized = String(root || "").trim();
    if (!normalized) throw new Error("Runtime checkpoints require an explicit root.");
    if (!isAbsolute(normalized)) {
      throw new Error("Runtime checkpoint root must be absolute.");
    }
    this.#root = resolve(normalized);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.#root, 0o700);
    } catch {
      // Windows applies the current user's directory ACL instead of POSIX mode bits.
    }
  }

  load(sessionId: string, turnId: string): RuntimeCheckpoint | undefined {
    const path = this.#path(sessionId, turnId);
    if (!existsSync(path)) return undefined;
    return this.#read(path, sessionId, turnId);
  }

  list(): RuntimeCheckpoint[] {
    return readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.#read(resolve(this.#root, entry.name)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  #read(path: string, sessionId?: string, turnId?: string): RuntimeCheckpoint {
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (record.protocol !== RECORD_PROTOCOL) {
        throw new Error("checkpoint record protocol mismatch");
      }
      const persistedCheckpointJson = JSON.stringify(record.checkpoint);
      if (record.checksum !== checksum(persistedCheckpointJson)) {
        throw new Error("checkpoint checksum mismatch");
      }
      const checkpoint = runtimeCheckpointSchema.parse(record.checkpoint);
      if ((sessionId && checkpoint.request.sessionId !== sessionId) ||
          (turnId && checkpoint.request.turnId !== turnId)) {
        throw new Error("checkpoint identity mismatch");
      }
      return checkpoint;
    } catch (error) {
      throw new RuntimeCheckpointCorruptionError(
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  save(candidate: RuntimeCheckpoint): void {
    const checkpoint = runtimeCheckpointSchema.parse(candidate);
    const path = this.#path(
      checkpoint.request.sessionId,
      checkpoint.request.turnId,
    );
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const checkpointJson = JSON.stringify(checkpoint);
    const record = JSON.stringify({
      protocol: RECORD_PROTOCOL,
      checksum: checksum(checkpointJson),
      checkpoint,
    });
    const descriptor = openSync(temporaryPath, "wx", 0o600);
    try {
      writeSync(descriptor, record, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  remove(sessionId: string, turnId: string): void {
    rmSync(this.#path(sessionId, turnId), { force: true });
  }

  #path(sessionId: string, turnId: string): string {
    const identity = JSON.stringify([sessionId, turnId]);
    const key = createHash("sha256").update(identity).digest("hex");
    return resolve(this.#root, `${key}.json`);
  }
}

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
