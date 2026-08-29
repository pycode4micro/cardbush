import {
  BUSH_MODEL_REQUEST_PROTOCOL,
  modelRequestSchema,
  runtimeSessionTurnRequestSchema,
  type ContextSnapshot,
  type ModelMessage,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeSessionCommitCheckpoint,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import { assembleContext, type AssembleContextInput } from "./contextAssembler.js";
import { SessionStore } from "./sessionStore.js";

export interface GeneratedMessageFact {
  messageId: string;
  createdAt: string;
  message: ModelMessage;
}

export interface SessionUsageFact {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export type TurnTerminalPayload = Extract<
  RuntimeEvent,
  { kind: "turn_terminal" }
>["payload"];

export type TurnFinalizedObserver = (
  payload: TurnTerminalPayload,
  generatedMessages: GeneratedMessageFact[],
  usage: SessionUsageFact,
) => void;

export interface PreparedSessionTurn {
  modelRequest: ModelRequest;
  sessionCommit: RuntimeSessionCommitCheckpoint;
}

export class RuntimeSessionCoordinator {
  readonly #store: SessionStore;
  readonly #now: () => string;
  readonly #activeSessions = new Map<string, string>();

  constructor(options: { store?: SessionStore; now?: () => string } = {}) {
    this.#store = options.store ?? new SessionStore();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    return this.#store.snapshot(sessionId);
  }

  assemble(
    input: Omit<AssembleContextInput, "session"> & { sessionId: string },
  ): ContextSnapshot {
    return assembleContext({
      session: this.#store.ensureSession(input.sessionId),
      prefix: input.prefix,
      current: input.current,
      throughTurnSequence: input.throughTurnSequence,
    });
  }

  prepare(candidate: RuntimeSessionTurnRequest): PreparedSessionTurn {
    const request = runtimeSessionTurnRequestSchema.parse(candidate);
    const activeTurnId = this.#activeSessions.get(request.sessionId);
    if (activeTurnId) {
      throw new Error(
        `Session ${request.sessionId} already has active Turn ${activeTurnId}.`,
      );
    }
    const session = this.#store.ensureSession(request.sessionId);
    if (session.turns.some((turn) => turn.turnId === request.turnId)) {
      throw new Error(`Turn ${request.turnId} already exists in Session history.`);
    }
    const context = assembleContext({
      session,
      prefix: request.prefixMessages,
      current: request.inputMessages.map((item) => item.message),
    });
    const modelRequest = modelRequestSchema.parse({
      ...request,
      protocol: BUSH_MODEL_REQUEST_PROTOCOL,
      messages: context.messages,
    });
    const createdAt = this.#now();
    const prepared = {
      modelRequest,
      sessionCommit: {
        turnSequence: (session.turns.at(-1)?.turnSequence ?? 0) + 1,
        createdAt,
        initialMessageCount: modelRequest.messages.length,
        inputMessages: request.inputMessages.map((item) => ({
          messageId: item.messageId,
          createdAt: item.createdAt ?? createdAt,
          message: item.message,
        })),
        generatedMessages: [],
        usage: {},
      },
    };
    this.#activeSessions.set(request.sessionId, request.turnId);
    return prepared;
  }

  abandon(sessionId: string, turnId: string): void {
    if (this.#activeSessions.get(sessionId) === turnId) {
      this.#activeSessions.delete(sessionId);
    }
  }

  finalizer(
    request: ModelRequest,
    checkpoint: RuntimeSessionCommitCheckpoint,
  ): TurnFinalizedObserver {
    validateSessionCheckpoint(request, checkpoint);
    return (payload, generatedMessages, usage) => {
      try {
        const inputMessages = checkpoint.inputMessages.map((item, index) => ({
          messageId: item.messageId,
          turnId: request.turnId,
          turnSequence: checkpoint.turnSequence,
          messageIndex: index,
          createdAt: item.createdAt,
          message: item.message,
        }));
        const generated = generatedMessages.map((item, index) => ({
          messageId: item.messageId,
          turnId: request.turnId,
          turnSequence: checkpoint.turnSequence,
          messageIndex: inputMessages.length + index,
          createdAt: item.createdAt,
          message: item.message,
        }));
        this.#store.commitTurn(request.sessionId, {
          turnId: request.turnId,
          turnSequence: checkpoint.turnSequence,
          createdAt: checkpoint.createdAt,
          completedAt: this.#now(),
          status: payload.status,
          reason: payload.reason,
          messages: [...inputMessages, ...generated],
          usage,
        });
      } finally {
        this.abandon(request.sessionId, request.turnId);
      }
    };
  }
}

function validateSessionCheckpoint(
  request: ModelRequest,
  checkpoint: RuntimeSessionCommitCheckpoint,
): void {
  if (
    request.messages.length !==
    checkpoint.initialMessageCount + checkpoint.generatedMessages.length
  ) {
    throw new Error("Session checkpoint message boundary does not match the model request.");
  }
  const suffix = request.messages.slice(checkpoint.initialMessageCount);
  const generated = checkpoint.generatedMessages.map((item) => item.message);
  if (JSON.stringify(suffix) !== JSON.stringify(generated)) {
    throw new Error("Session checkpoint generated messages do not match the request suffix.");
  }
}
