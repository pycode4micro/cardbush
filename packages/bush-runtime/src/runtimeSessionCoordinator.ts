import {
  BUSH_MODEL_REQUEST_PROTOCOL,
  modelRequestSchema,
  runtimeSessionTurnRequestSchema,
  type ContextSnapshot,
  type CacheChainState,
  type ModelMessage,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimeSessionCommitCheckpoint,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
  type SessionSupersession,
  type TurnContextCheckpoint,
} from "@cardbush/bush-protocol";
import { isDeepStrictEqual } from "node:util";

import {
  assembleContext,
  projectActiveTurnContext,
  type AssembleContextInput,
} from "./contextAssembler.js";
import { SessionStore, projectSessionSupersession, validateConversation } from "./sessionStore.js";

export interface GeneratedMessageFact {
  messageId: string;
  createdAt: string;
  message: ModelMessage;
}

export interface SessionUsageFact {
  model?: string;
  contextWindowTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  lastRequestInputTokens?: number;
  lastRequestOutputTokens?: number;
  lastRequestCachedInputTokens?: number;
}

export type TurnTerminalPayload = Extract<
  RuntimeEvent,
  { kind: "turn_terminal" }
>["payload"];

export type TurnFinalizedObserver = (
  payload: TurnTerminalPayload,
  generatedMessages: GeneratedMessageFact[],
  usage: SessionUsageFact,
  cacheChainState: CacheChainState,
  activeContextCheckpoint?: TurnContextCheckpoint,
) => void;

export interface PreparedSessionTurn {
  modelRequest: ModelRequest;
  sessionCommit: RuntimeSessionCommitCheckpoint;
  cacheChainState?: CacheChainState;
}

export class RuntimeSessionCoordinator {
  readonly #store: SessionStore;
  readonly #now: () => string;
  readonly #activeSessions = new Map<string, string>();
  readonly #activeSupersessions = new Map<string, SessionSupersession>();

  constructor(options: { store?: SessionStore; now?: () => string } = {}) {
    this.#store = options.store ?? new SessionStore();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    return this.#store.snapshot(sessionId);
  }

  list(): SessionSnapshot[] {
    return this.#store.list();
  }

  create(sessionId: string, metadata: Record<string, unknown> = {}): SessionSnapshot {
    return this.#store.ensureSession(sessionId, metadata);
  }

  updateMetadata(input: {
    sessionId: string;
    expectedRevision: number;
    metadata: Record<string, unknown>;
  }): SessionSnapshot {
    if (this.#activeSessions.has(input.sessionId)) {
      throw new Error("Session metadata cannot change while its Turn is active.");
    }
    return this.#store.updateMetadata(input);
  }

  supersedeMessages(input: {
    sessionId: string;
    messageIds: string[];
    reason: string;
    replacementTurnId?: string;
  }): SessionSnapshot {
    if (this.#activeSessions.has(input.sessionId)) {
      throw new Error("Session messages cannot change while its Turn is active.");
    }
    return this.#store.supersedeMessages(input);
  }

  contextCompactionState(sessionId: string): {
    revision: number;
    unsummarizedTurnIds: string[];
    totalTurns: number;
  } {
    const session = this.#contextSession(sessionId);
    const superseded = new Set(session.supersededMessageIds);
    return {
      revision: session.revision,
      unsummarizedTurnIds: session.turns
        .filter((turn) =>
          !turn.contextSummary &&
          turn.messages.some((message) => !superseded.has(message.messageId)),
        )
        .map((turn) => turn.turnId),
      totalTurns: session.turns.length,
    };
  }

  summarizeContext(input: {
    sessionId: string;
    activeTurnId: string;
    expectedRevision: number;
    summaries: Array<{ turnId: string; summary: string }>;
  }): SessionSnapshot {
    if (this.#activeSessions.get(input.sessionId) !== input.activeTurnId) {
      throw new Error("Context summaries may only be committed by the active Turn.");
    }
    const state = this.contextCompactionState(input.sessionId);
    const expectedIds = state.unsummarizedTurnIds;
    const receivedIds = input.summaries.map((item) => item.turnId);
    if (
      input.expectedRevision !== state.revision ||
      JSON.stringify(receivedIds) !== JSON.stringify(expectedIds)
    ) {
      throw new Error(
        "Context checkpoint is stale or does not summarize every unsummarized preceding Turn in order.",
      );
    }
    if (input.summaries.length === 0) return this.#store.ensureSession(input.sessionId);
    return this.#store.summarizeTurns(input);
  }

  rebuildActiveContext(input: {
    sessionId: string;
    prefix: ModelMessage[];
    current: ModelMessage[];
    maxSummaryTurns?: number;
    supersession?: SessionSupersession;
  }): ContextSnapshot {
    return assembleContext({
      session: this.#contextSession(input.sessionId, input.supersession),
      prefix: input.prefix,
      current: input.current,
      maxSummaryTurns: input.maxSummaryTurns,
    });
  }

  delete(sessionId: string): boolean {
    if (this.#activeSessions.has(sessionId)) {
      throw new Error("An active Session cannot be deleted.");
    }
    return this.#store.deleteSession(sessionId);
  }

  assemble(
    input: Omit<AssembleContextInput, "session"> & { sessionId: string },
  ): ContextSnapshot {
    return assembleContext({
      session: this.#store.ensureSession(input.sessionId),
      prefix: input.prefix,
      current: input.current,
      throughTurnSequence: input.throughTurnSequence,
      maxChars: input.maxChars,
      maxSummaryTurns: input.maxSummaryTurns,
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
    const session = this.#store.ensureSession(request.sessionId, request.sessionMetadata);
    if (session.turns.some((turn) => turn.turnId === request.turnId)) {
      throw new Error(`Turn ${request.turnId} already exists in Session history.`);
    }
    if (request.supersession && request.supersession.expectedRevision !== session.revision) {
      throw new Error("Session changed before the replacement Turn was admitted. Refresh and retry the edit.");
    }
    const supersession = request.supersession ? {
      messageIds: request.supersession.messageIds,
      reason: request.supersession.reason,
    } : undefined;
    const context = assembleContext({
      session: projectSessionSupersession(session, supersession),
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
      cacheChainState: session.turns.at(-1)?.cacheChainState,
      sessionCommit: {
        turnSequence: (session.turns.at(-1)?.turnSequence ?? 0) + 1,
        createdAt,
        initialMessageCount: modelRequest.messages.length,
        prefixMessages: request.prefixMessages,
        inputMessages: request.inputMessages.map((item) => ({
          messageId: item.messageId,
          createdAt: item.createdAt ?? createdAt,
          message: item.message,
          ...(item.metadata ? { metadata: item.metadata } : {}),
        })),
        generatedMessages: [],
        usage: {},
        ...(supersession ? { supersession } : {}),
      },
    };
    this.#activeSessions.set(request.sessionId, request.turnId);
    if (supersession) this.#activeSupersessions.set(request.sessionId, supersession);
    return prepared;
  }

  abandon(sessionId: string, turnId: string): void {
    if (this.#activeSessions.get(sessionId) === turnId) {
      this.#activeSessions.delete(sessionId);
      this.#activeSupersessions.delete(sessionId);
    }
  }

  finalizer(
    request: ModelRequest,
    checkpoint: RuntimeSessionCommitCheckpoint,
  ): TurnFinalizedObserver {
    validateSessionCheckpoint(request, checkpoint);
    const activeTurnId = this.#activeSessions.get(request.sessionId);
    if (activeTurnId && activeTurnId !== request.turnId) {
      throw new Error(`Session ${request.sessionId} already has active Turn ${activeTurnId}.`);
    }
    this.#activeSessions.set(request.sessionId, request.turnId);
    if (checkpoint.supersession) {
      this.#activeSupersessions.set(request.sessionId, checkpoint.supersession);
    }
    return (
      payload,
      generatedMessages,
      usage,
      cacheChainState,
      activeContextCheckpoint,
    ) => {
      try {
        const inputMessages = checkpoint.inputMessages.map((item, index) => ({
          messageId: item.messageId,
          turnId: request.turnId,
          turnSequence: checkpoint.turnSequence,
          messageIndex: index,
          createdAt: item.createdAt,
          message: item.message,
          ...(item.metadata ? { metadata: item.metadata } : {}),
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
          cacheChainState,
          ...(checkpoint.supersession ? { supersession: checkpoint.supersession } : {}),
          ...(activeContextCheckpoint
            ? { contextCheckpoint: activeContextCheckpoint }
            : {}),
        });
      } finally {
        this.abandon(request.sessionId, request.turnId);
      }
    };
  }

  #contextSession(
    sessionId: string,
    supersession = this.#activeSupersessions.get(sessionId),
  ): SessionSnapshot {
    return projectSessionSupersession(this.#store.ensureSession(sessionId), supersession);
  }
}

function validateSessionCheckpoint(
  request: ModelRequest,
  checkpoint: RuntimeSessionCommitCheckpoint,
): void {
  if (checkpoint.initialMessageCount < checkpoint.prefixMessages.length + checkpoint.inputMessages.length) {
    throw new Error("Session checkpoint initial message boundary is smaller than its fixed inputs.");
  }
  if (!isDeepStrictEqual(
    request.messages.slice(0, checkpoint.prefixMessages.length),
    checkpoint.prefixMessages,
  )) {
    throw new Error("Session checkpoint fixed prefix does not match the model request.");
  }
  const messageIds = new Set<string>();
  for (const item of [...checkpoint.inputMessages, ...checkpoint.generatedMessages]) {
    if (messageIds.has(item.messageId)) {
      throw new Error(`Session checkpoint contains duplicate message ${item.messageId}.`);
    }
    messageIds.add(item.messageId);
  }
  validateConversation([
    ...checkpoint.inputMessages.map((item) => item.message),
    ...checkpoint.generatedMessages.map((item) => item.message),
  ]);
  const projectedCurrent = projectActiveTurnContext({
    turnId: request.turnId,
    inputMessages: checkpoint.inputMessages,
    generatedMessages: checkpoint.generatedMessages,
    checkpoint: checkpoint.activeContextCheckpoint,
    includeResumeInstruction: true,
  });
  if (!containsMessageSubsequence(request.messages, projectedCurrent)) {
    throw new Error(
      `Session checkpoint current-Turn projection does not match the model request (${projectedCurrent.map(messageProjectionLabel).join(",")} not in ${request.messages.map(messageProjectionLabel).join(",")}).`,
    );
  }
}

function messageProjectionLabel(message: ModelMessage): string {
  return `${message.role}:${"name" in message ? message.name ?? "" : ""}:${message.content.length}`;
}

function containsMessageSubsequence(
  messages: ModelMessage[],
  expected: ModelMessage[],
): boolean {
  if (expected.length === 0) return true;
  for (let start = 0; start <= messages.length - expected.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (!isDeepStrictEqual(messages[start + offset], expected[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
