import {
  BUSH_RUNTIME_CHECKPOINT_PROTOCOL,
  BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL,
  runtimeCheckpointSchema,
  type ModelMessage,
  type ModelRequest,
  type CacheChainState,
  type RuntimeCheckpoint,
  type RuntimeRecoveryInspection,
  type RuntimeSessionCommitCheckpoint,
} from "@cardbush/bush-protocol";

import type { RuntimeCheckpointStore } from "./runtimeCheckpointStore.js";
import type {
  InMemoryRuntimeEventLog,
  RuntimeEventIdentity,
} from "./runtimeEventLog.js";

const UNSAFE_POST_CHECKPOINT_EVENTS = new Set([
  "tool_running",
  "tool_completed",
  "tool_failed",
  "tool_cancelled",
  "permission_requested",
  "permission_answered",
  "permission_rejected",
  "permission_expired",
  "permission_cancelled",
]);

export interface RuntimeRecoveryCoordinatorOptions {
  eventLog: InMemoryRuntimeEventLog;
  checkpoints: RuntimeCheckpointStore;
  now?: () => string;
}

export class RuntimeRecoveryCoordinator {
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #checkpoints: RuntimeCheckpointStore;
  readonly #now: () => string;

  constructor(options: RuntimeRecoveryCoordinatorOptions) {
    this.#eventLog = options.eventLog;
    this.#checkpoints = options.checkpoints;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  save(input: {
    request: ModelRequest;
    messages: ModelMessage[];
    nextRound: number;
    completedReceiptIds: string[];
    cacheChainState: CacheChainState;
    sessionCommit?: RuntimeSessionCommitCheckpoint;
  }): RuntimeCheckpoint {
    const events = this.#eventLog.replay(
      input.request.sessionId,
      input.request.turnId,
    );
    const cursor = events.at(-1);
    if (!cursor) throw new Error("Cannot checkpoint a Turn without Runtime events.");
    if (cursor.kind === "turn_terminal") {
      throw new Error("Cannot checkpoint a terminal Turn.");
    }
    const checkpoint = runtimeCheckpointSchema.parse({
      protocol: BUSH_RUNTIME_CHECKPOINT_PROTOCOL,
      request: { ...input.request, messages: input.messages },
      nextRound: input.nextRound,
      lastEventSequence: cursor.sequence,
      lastEventId: cursor.eventId,
      completedReceiptIds: [...new Set(input.completedReceiptIds)],
      cacheChainState: input.cacheChainState,
      sessionCommit: input.sessionCommit,
      createdAt: this.#now(),
    });
    this.#checkpoints.save(checkpoint);
    return checkpoint;
  }

  remove(sessionId: string, turnId: string): void {
    this.#checkpoints.remove(sessionId, turnId);
  }

  orphanedCheckpoints(): RuntimeCheckpoint[] {
    return this.#checkpoints.list().filter((checkpoint) =>
      this.#eventLog.replay(
        checkpoint.request.sessionId,
        checkpoint.request.turnId,
      ).at(-1)?.kind !== "turn_terminal",
    );
  }

  inspect(sessionId: string, turnId: string): RuntimeRecoveryInspection {
    return this.#inspectState(sessionId, turnId).inspection;
  }

  #inspectState(
    sessionId: string,
    turnId: string,
  ): { inspection: RuntimeRecoveryInspection; checkpoint?: RuntimeCheckpoint } {
    const events = this.#eventLog.replay(sessionId, turnId);
    const terminal = events.at(-1)?.kind === "turn_terminal";
    const checkpoint = this.#checkpoints.load(sessionId, turnId);
    if (terminal) {
      return {
        inspection: inspection(sessionId, turnId, "terminal", "turn_already_terminal"),
      };
    }
    if (!checkpoint) {
      return {
        inspection: inspection(sessionId, turnId, "none", "checkpoint_not_found"),
      };
    }
    const cursor = events.find(
      (event) => event.sequence === checkpoint.lastEventSequence,
    );
    if (!cursor || cursor.eventId !== checkpoint.lastEventId) {
      return {
        inspection: inspection(
          sessionId,
          turnId,
          "blocked",
          "checkpoint_event_cursor_mismatch",
          checkpoint,
        ),
        checkpoint,
      };
    }
    const eventsAfterCheckpoint = events.filter(
      (event) => event.sequence > checkpoint.lastEventSequence,
    );
    const unsafe = eventsAfterCheckpoint.find((event) =>
      UNSAFE_POST_CHECKPOINT_EVENTS.has(event.kind),
    );
    if (unsafe) {
      return {
        inspection: inspection(
          sessionId,
          turnId,
          "blocked",
          `post_checkpoint_${unsafe.kind}`,
          checkpoint,
          eventsAfterCheckpoint.map((event) => event.eventId),
        ),
        checkpoint,
      };
    }
    return {
      inspection: inspection(
        sessionId,
        turnId,
        "resumable",
        "stable_checkpoint_available",
        checkpoint,
        eventsAfterCheckpoint.map((event) => event.eventId),
      ),
      checkpoint,
    };
  }

  prepareResume(
    sessionId: string,
    turnId: string,
  ): {
    identity: RuntimeEventIdentity;
    checkpoint: RuntimeCheckpoint;
    nextRound: number;
  } {
    const state = this.#inspectState(sessionId, turnId);
    if (state.inspection.status !== "resumable" || !state.checkpoint) {
      throw new Error(
        `Turn ${turnId} is not resumable: ${state.inspection.reason}.`,
      );
    }
    const identity: RuntimeEventIdentity = {
      requestId: state.checkpoint.request.requestId,
      sessionId,
      turnId,
    };
    if (state.inspection.eventsAfterCheckpoint.length > 0) {
      this.#eventLog.append(identity, {
        kind: "replay_reset",
        payload: {
          reason: "runtime_recovery_resume",
          supersededEventIds: state.inspection.eventsAfterCheckpoint,
        },
      });
    }
    this.#eventLog.append(identity, {
      kind: "stream_resumed",
      payload: {
        afterSequence: state.checkpoint.lastEventSequence,
        lastEventId: state.checkpoint.lastEventId,
      },
    });
    return {
      identity,
      checkpoint: state.checkpoint,
      nextRound: state.checkpoint.nextRound,
    };
  }
}

function inspection(
  sessionId: string,
  turnId: string,
  status: RuntimeRecoveryInspection["status"],
  reason: string,
  checkpoint?: RuntimeCheckpoint,
  eventsAfterCheckpoint: string[] = [],
): RuntimeRecoveryInspection {
  return {
    protocol: BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL,
    sessionId,
    turnId,
    status,
    reason,
    ...(checkpoint
      ? {
          checkpointSequence: checkpoint.lastEventSequence,
          nextRound: checkpoint.nextRound,
        }
      : {}),
    eventsAfterCheckpoint,
  };
}
