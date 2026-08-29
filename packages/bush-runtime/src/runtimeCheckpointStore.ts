import {
  runtimeCheckpointSchema,
  type RuntimeCheckpoint,
} from "@cardbush/bush-protocol";

export interface RuntimeCheckpointStore {
  load(sessionId: string, turnId: string): RuntimeCheckpoint | undefined;
  save(checkpoint: RuntimeCheckpoint): void;
  remove(sessionId: string, turnId: string): void;
}

export class InMemoryRuntimeCheckpointStore implements RuntimeCheckpointStore {
  readonly #checkpoints = new Map<string, RuntimeCheckpoint>();

  load(sessionId: string, turnId: string): RuntimeCheckpoint | undefined {
    const checkpoint = this.#checkpoints.get(key(sessionId, turnId));
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  save(candidate: RuntimeCheckpoint): void {
    const checkpoint = runtimeCheckpointSchema.parse(candidate);
    this.#checkpoints.set(
      key(checkpoint.request.sessionId, checkpoint.request.turnId),
      structuredClone(checkpoint),
    );
  }

  remove(sessionId: string, turnId: string): void {
    this.#checkpoints.delete(key(sessionId, turnId));
  }
}

function key(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}
