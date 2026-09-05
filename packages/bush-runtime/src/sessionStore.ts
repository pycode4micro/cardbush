import { randomUUID } from "node:crypto";

import {
  BUSH_SESSION_EVENT_PROTOCOL,
  BUSH_SESSION_SNAPSHOT_PROTOCOL,
  committedTurnSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type CommittedTurn,
  type SessionEvent,
  type SessionSnapshot,
  type SessionSupersession,
} from "@cardbush/bush-protocol";

export interface SessionEventPersistence {
  load(sessionId: string): SessionEvent[];
  append(event: SessionEvent): void;
  listSessionIds?(): string[];
  remove?(sessionId: string): boolean;
}

export interface SessionStoreOptions {
  persistence?: SessionEventPersistence;
  createEventId?: () => string;
  now?: () => string;
}

export class SessionStore {
  readonly #persistence?: SessionEventPersistence;
  readonly #createEventId: () => string;
  readonly #now: () => string;
  readonly #events = new Map<string, SessionEvent[]>();

  constructor(options: SessionStoreOptions = {}) {
    this.#persistence = options.persistence;
    this.#createEventId = options.createEventId ?? (() => `session_event_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const events = this.#load(sessionId);
    return events.length === 0 ? undefined : projectSession(sessionId, events);
  }

  list(): SessionSnapshot[] {
    const identities = new Set([
      ...this.#events.keys(),
      ...(this.#persistence?.listSessionIds?.() ?? []),
    ]);
    return [...identities]
      .map((sessionId) => this.snapshot(sessionId))
      .filter((session): session is SessionSnapshot => session !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  ensureSession(
    sessionId: string,
    metadata: Record<string, unknown> = {},
  ): SessionSnapshot {
    const normalized = requireIdentity(sessionId, "sessionId");
    const existing = this.snapshot(normalized);
    if (existing) return existing;
    this.#append(normalized, {
      kind: "session_created",
      payload: Object.keys(metadata).length > 0 ? { metadata } : {},
    });
    return this.snapshot(normalized)!;
  }

  deleteSession(sessionId: string): boolean {
    const normalized = requireIdentity(sessionId, "sessionId");
    const exists = this.snapshot(normalized) !== undefined;
    if (!exists) return false;
    this.#events.delete(normalized);
    this.#persistence?.remove?.(normalized);
    return true;
  }

  updateMetadata(input: {
    sessionId: string;
    expectedRevision: number;
    metadata: Record<string, unknown>;
  }): SessionSnapshot {
    const sessionId = requireIdentity(input.sessionId, "sessionId");
    const before = this.snapshot(sessionId);
    if (!before) throw new Error(`Session ${sessionId} does not exist.`);
    if (before.revision !== input.expectedRevision) {
      throw new Error(
        `Session ${sessionId} revision ${before.revision} does not match ${input.expectedRevision}.`,
      );
    }
    this.#append(sessionId, {
      kind: "session_metadata_updated",
      payload: {
        expectedRevision: input.expectedRevision,
        metadata: structuredClone(input.metadata),
      },
    });
    return this.snapshot(sessionId)!;
  }

  commitTurn(sessionId: string, candidate: CommittedTurn): SessionSnapshot {
    const normalized = requireIdentity(sessionId, "sessionId");
    const turn = committedTurnSchema.parse(candidate);
    if (turn.contextSummary) {
      throw new Error("A new Turn cannot be committed with a context summary.");
    }
    const before = this.ensureSession(normalized);
    const existing = before.turns.find((item) => item.turnId === turn.turnId);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(turn)) return before;
      throw new Error(`Turn ${turn.turnId} is already committed with different facts.`);
    }
    const expectedSequence = (before.turns.at(-1)?.turnSequence ?? 0) + 1;
    if (turn.turnSequence !== expectedSequence) {
      throw new Error(
        `Turn ${turn.turnId} sequence ${turn.turnSequence} does not follow ${expectedSequence - 1}.`,
      );
    }
    validateCommittedTurn(turn);
    const knownMessageIds = new Set(
      before.turns.flatMap((item) => item.messages.map((message) => message.messageId)),
    );
    for (const message of turn.messages) {
      if (knownMessageIds.has(message.messageId)) {
        throw new Error(`Message ${message.messageId} already exists in Session ${normalized}.`);
      }
    }
    const effective = projectSessionSupersession(before, turn.supersession);
    validateConversation([
      ...before.turns
        .flatMap((item) => item.messages)
        .filter((message) => !effective.supersededMessageIds.includes(message.messageId))
        .map((message) => message.message),
      ...turn.messages.map((message) => message.message),
    ]);
    this.#append(normalized, { kind: "turn_committed", payload: turn });
    return this.snapshot(normalized)!;
  }

  supersedeMessages(input: {
    sessionId: string;
    messageIds: string[];
    reason: string;
    replacementTurnId?: string;
  }): SessionSnapshot {
    const sessionId = requireIdentity(input.sessionId, "sessionId");
    const before = this.snapshot(sessionId);
    if (!before) throw new Error(`Session ${sessionId} does not exist.`);
    const messageIds = [...new Set(input.messageIds.map((id) => requireIdentity(id, "messageId")))];
    if (messageIds.length === 0) throw new Error("At least one messageId is required.");
    const known = new Set(
      before.turns.flatMap((turn) => turn.messages.map((message) => message.messageId)),
    );
    const alreadySuperseded = new Set(before.supersededMessageIds);
    for (const messageId of messageIds) {
      if (!known.has(messageId)) throw new Error(`Message ${messageId} does not exist.`);
      if (alreadySuperseded.has(messageId)) {
        throw new Error(`Message ${messageId} is already superseded.`);
      }
    }
    this.#append(sessionId, {
      kind: "messages_superseded",
      payload: {
        messageIds,
        reason: requireIdentity(input.reason, "reason"),
        ...(input.replacementTurnId
          ? { replacementTurnId: requireIdentity(input.replacementTurnId, "replacementTurnId") }
          : {}),
      },
    });
    return this.snapshot(sessionId)!;
  }

  summarizeTurns(input: {
    sessionId: string;
    expectedRevision: number;
    summaries: Array<{ turnId: string; summary: string }>;
  }): SessionSnapshot {
    const sessionId = requireIdentity(input.sessionId, "sessionId");
    const before = this.snapshot(sessionId);
    if (!before) throw new Error(`Session ${sessionId} does not exist.`);
    if (before.revision !== input.expectedRevision) {
      throw new Error(
        `Session ${sessionId} revision ${before.revision} does not match ${input.expectedRevision}.`,
      );
    }
    const summaries = input.summaries.map((item) => ({
      turnId: requireIdentity(item.turnId, "turnId"),
      summary: requireIdentity(item.summary, "summary"),
    }));
    const ids = new Set<string>();
    const turns = new Map(before.turns.map((turn) => [turn.turnId, turn]));
    for (const item of summaries) {
      if (ids.has(item.turnId)) throw new Error(`Turn ${item.turnId} occurs more than once.`);
      ids.add(item.turnId);
      const turn = turns.get(item.turnId);
      if (!turn) throw new Error(`Turn ${item.turnId} does not exist.`);
      if (turn.contextSummary) {
        throw new Error(`Turn ${item.turnId} already has a context summary.`);
      }
    }
    this.#append(sessionId, {
      kind: "turn_context_summarized",
      payload: { expectedRevision: input.expectedRevision, summaries },
    });
    return this.snapshot(sessionId)!;
  }

  #load(sessionId: string): SessionEvent[] {
    const cached = this.#events.get(sessionId);
    if (cached) return cached;
    const loaded = (this.#persistence?.load(sessionId) ?? []).map((event) =>
      sessionEventSchema.parse(event),
    );
    if (loaded.length > 0) projectSession(sessionId, loaded);
    this.#events.set(sessionId, loaded);
    return loaded;
  }

  #append(
    sessionId: string,
    input: Pick<Extract<SessionEvent, { kind: SessionEvent["kind"] }>, "kind" | "payload">,
  ): SessionEvent {
    const events = this.#load(sessionId);
    const event = sessionEventSchema.parse({
      protocol: BUSH_SESSION_EVENT_PROTOCOL,
      eventId: this.#createEventId(),
      sequence: events.length + 1,
      sessionId,
      createdAt: this.#now(),
      ...input,
    });
    this.#persistence?.append(event);
    events.push(event);
    return event;
  }
}

export function projectSession(
  sessionId: string,
  candidates: SessionEvent[],
): SessionSnapshot {
  const events = candidates.map((event) => sessionEventSchema.parse(event));
  if (events.length === 0) throw new Error(`Session ${sessionId} has no events.`);
  const eventIds = new Set<string>();
  const turns: CommittedTurn[] = [];
  const turnIds = new Set<string>();
  const messageIds = new Set<string>();
  const superseded = new Set<string>();
  let metadata: Record<string, unknown> | undefined;
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) throw new Error("Session event identity mismatch.");
    if (event.sequence !== index + 1) throw new Error("Session event sequence is not contiguous.");
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate Session event ${event.eventId}.`);
    eventIds.add(event.eventId);
    if (index === 0 && event.kind !== "session_created") {
      throw new Error("The first Session event must be session_created.");
    }
    if (event.kind === "session_created") {
      metadata = event.payload.metadata
        ? structuredClone(event.payload.metadata)
        : undefined;
    }
    if (index > 0 && event.kind === "session_created") {
      throw new Error("Session may only be created once.");
    }
    if (event.kind === "turn_committed") {
      const turn = event.payload;
      validateCommittedTurn(turn);
      if (turn.supersession) {
        addSupersededMessages(messageIds, superseded, turn.supersession.messageIds);
      }
      if (turn.turnSequence !== turns.length + 1) {
        throw new Error("Committed Turn sequence is not contiguous.");
      }
      if (turnIds.has(turn.turnId)) throw new Error(`Duplicate Turn ${turn.turnId}.`);
      turnIds.add(turn.turnId);
      for (const message of turn.messages) {
        if (messageIds.has(message.messageId)) {
          throw new Error(`Duplicate message ${message.messageId}.`);
        }
        messageIds.add(message.messageId);
      }
      turns.push(turn);
    }
    if (event.kind === "messages_superseded") {
      addSupersededMessages(messageIds, superseded, event.payload.messageIds);
    }
    if (event.kind === "turn_context_summarized") {
      if (event.payload.expectedRevision !== index) {
        throw new Error("Turn context summary expected revision does not match history.");
      }
      const localIds = new Set<string>();
      for (const item of event.payload.summaries) {
        if (localIds.has(item.turnId)) {
          throw new Error(`Turn ${item.turnId} occurs more than once in a context summary event.`);
        }
        localIds.add(item.turnId);
        const turn = turns.find((candidate) => candidate.turnId === item.turnId);
        if (!turn) throw new Error(`Cannot summarize unknown Turn ${item.turnId}.`);
        if (turn.contextSummary) {
          throw new Error(`Turn ${item.turnId} was summarized more than once.`);
        }
        turn.contextSummary = item.summary;
      }
    }
    if (event.kind === "session_metadata_updated") {
      if (event.payload.expectedRevision !== index) {
        throw new Error("Session metadata update expected revision does not match history.");
      }
      metadata = structuredClone(event.payload.metadata);
    }
  }
  return sessionSnapshotSchema.parse({
    protocol: BUSH_SESSION_SNAPSHOT_PROTOCOL,
    sessionId,
    revision: events.length,
    createdAt: events[0].createdAt,
    updatedAt: events.at(-1)!.createdAt,
    turns,
    supersededMessageIds: [...superseded],
    ...(metadata ? { metadata } : {}),
  });
}

export function projectSessionSupersession(
  session: SessionSnapshot,
  supersession?: SessionSupersession,
): SessionSnapshot {
  if (!supersession) return session;
  const known = new Set(session.turns.flatMap((turn) =>
    turn.messages.map((message) => message.messageId),
  ));
  const superseded = new Set(session.supersededMessageIds);
  addSupersededMessages(known, superseded, supersession.messageIds);
  return { ...session, supersededMessageIds: [...superseded] };
}

function addSupersededMessages(known: Set<string>, superseded: Set<string>, ids: string[]): void {
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Cannot supersede unknown message ${id}.`);
    if (superseded.has(id)) throw new Error(`Message ${id} was superseded more than once.`);
    superseded.add(id);
  }
}

export function validateCommittedTurn(turn: CommittedTurn): void {
  const messageIds = new Set<string>();
  for (const [index, message] of turn.messages.entries()) {
    if (message.turnId !== turn.turnId) throw new Error("Message Turn identity mismatch.");
    if (message.turnSequence !== turn.turnSequence) {
      throw new Error("Message Turn sequence mismatch.");
    }
    if (message.messageIndex !== index) throw new Error("Message indexes must be contiguous.");
    if (messageIds.has(message.messageId)) throw new Error(`Duplicate message ${message.messageId}.`);
    messageIds.add(message.messageId);
  }
  if (turn.contextCheckpoint) {
    if (turn.contextCheckpoint.inputMessageCount >= turn.messages.length) {
      throw new Error("Turn context checkpoint must point into generated Turn messages.");
    }
    const boundaryIndex = turn.messages.findIndex((message) =>
      message.messageId === turn.contextCheckpoint!.throughMessageId
    );
    if (boundaryIndex < turn.contextCheckpoint.inputMessageCount) {
      throw new Error("Turn context checkpoint boundary must be a generated Turn message.");
    }
  }
  validateConversation(turn.messages.map((message) => message.message));
}

export function validateConversation(
  messages: Array<CommittedTurn["messages"][number]["message"]>,
): void {
  const pending = new Set<string>();
  const seenCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size > 0) throw new Error("Assistant message arrived before pending tool results.");
      for (const call of message.toolCalls) {
        if (seenCalls.has(call.id)) throw new Error(`Duplicate tool call ${call.id}.`);
        seenCalls.add(call.id);
        pending.add(call.id);
      }
      continue;
    }
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) {
        throw new Error(`Tool result ${message.toolCallId} has no pending call.`);
      }
      continue;
    }
    if (pending.size > 0) throw new Error("Conversation continued before pending tool results.");
  }
  if (pending.size > 0) throw new Error("Committed conversation has pending tool results.");
}

function requireIdentity(value: string, name: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
