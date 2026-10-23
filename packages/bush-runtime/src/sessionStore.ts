import { authoredPromptContent } from '@cardbush/bush-protocol';
import { randomUUID } from "node:crypto";
import { summarizeSession, type SessionSummary, type SessionHistoryRequest } from '@cardbush/bush-protocol';
import { turnContextSummaryUpdateSchema, type TurnContextSummaryUpdate } from '@cardbush/bush-protocol';
import type { StoredHistoryPage } from './sessionReadIndex.js';
import { preparedToolHandoffReceipt } from './preparedToolHandoff.js';
import { validateToolHandoff, isRecordedToolHandoff, findRecordedToolHandoff } from './recordedToolHandoff.js';

import {
  BUSH_SESSION_EVENT_PROTOCOL,
  BUSH_SESSION_SNAPSHOT_PROTOCOL,
  committedTurnSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  sessionModelContractSchema,
  type SessionModelContract,
  type CommittedTurn,
  type SessionEvent,
  type SessionSnapshot,
  type SessionSupersession,
  type RuntimeUserPrompt,
  type RuntimeUserPromptsRequest,
} from "@cardbush/bush-protocol";

export interface SessionEventPersistence {
  load(sessionId: string): SessionEvent[];
  append(event: SessionEvent): void;
  listSessionIds?(): string[];
  remove?(sessionId: string): boolean;
  listMetadata?(skip: Set<string>, signal?: AbortSignal): Promise<SessionMetadataEntry[]>;
  listSummaries?(signal?: AbortSignal): Promise<SessionSummary[]>;
  historyPage?(input: SessionHistoryRequest, signal?: AbortSignal): Promise<StoredHistoryPage | undefined>;
}

export interface SessionMetadataEntry { sessionId: string; metadata: Record<string, unknown> }

export function historyCursorError() {
  return Object.assign(new Error('Session history changed. Refresh the conversation before loading earlier turns.'), { code: 'session_history_changed' });
}

export interface SessionStoreOptions {
  persistence?: SessionEventPersistence;
  createEventId?: () => string;
  now?: () => string;
  idleCacheLimit?: number;
  idleCacheBytes?: number;
}

export class SessionStore {
  readonly #persistence?: SessionEventPersistence;
  readonly #createEventId: () => string;
  readonly #now: () => string;
  readonly #events = new Map<string, SessionEvent[]>();
  readonly #bytes = new Map<string, number>();
  readonly #protected = new Set<string>();
  readonly #idleCacheLimit: number;
  readonly #idleCacheBytes: number;

  constructor(options: SessionStoreOptions = {}) {
    this.#persistence = options.persistence;
    this.#createEventId = options.createEventId ?? (() => `session_event_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idleCacheLimit = options.idleCacheLimit ?? 24;
    this.#idleCacheBytes = options.idleCacheBytes ?? 64 * 1024 * 1024;
  }

  protect(sessionId: string, value: boolean) {
    if (value) this.#protected.add(sessionId); else { this.#protected.delete(sessionId); this.#trimCache(); }
  }

  async listSummaries(signal?: AbortSignal): Promise<SessionSummary[]> {
    signal?.throwIfAborted();
    const summaries = this.#persistence?.listSummaries ? await this.#persistence.listSummaries(signal) : this.list().map(summarizeSession);
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId));
  }

  async historyPage(input: SessionHistoryRequest, signal?: AbortSignal): Promise<StoredHistoryPage | undefined> {
    signal?.throwIfAborted();
    if (this.#persistence?.historyPage) return this.#persistence.historyPage(input, signal);
    const snapshot = this.snapshot(input.sessionId);
    if (!snapshot) return undefined;
    const historyRevision = this.#load(input.sessionId).filter(event => event.kind === 'messages_superseded' ||
      (event.kind === 'turn_committed' && event.payload.supersession)).at(-1)?.sequence ?? 0;
    if (input.cursor && input.cursor.historyRevision !== historyRevision) throw historyCursorError();
    const end = input.cursor ? snapshot.turns.findIndex(turn => turn.turnSequence >= input.cursor!.beforeTurnSequence) : snapshot.turns.length;
    if (end < 0) throw historyCursorError();
    const start = Math.max(0, end - input.limit), turns = snapshot.turns.slice(start, end);
    return { summary: summarizeSession(snapshot), snapshot: { ...snapshot, turns }, historyRevision, beforeCreatedAt: snapshot.turns[end]?.createdAt,
      nextCursor: start > 0 ? { beforeTurnSequence: turns[0]!.turnSequence, historyRevision } : null };
  }

  snapshot(sessionId: string): SessionSnapshot | undefined {
    const events = this.#load(sessionId);
    return events.length === 0 ? undefined : projectSession(sessionId, events);
  }

  modelContract(sessionId: string): SessionModelContract | undefined {
    const events = this.#load(sessionId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'model_contract_updated') return structuredClone(event.payload.contract);
      if (event.kind === 'model_contract_bound') return structuredClone(event.payload);
    }
    return undefined;
  }

  bindModelContract(sessionId: string, contract: SessionModelContract): SessionModelContract {
    const existing = this.modelContract(sessionId);
    if (existing) return existing;
    if (!this.hasSession(sessionId)) throw new Error('Cannot bind an unknown session.');
    const payload = sessionModelContractSchema.parse(contract);
    this.#append(sessionId, { kind: 'model_contract_bound', payload });
    return structuredClone(payload);
  }

  upgradeModelContract(sessionId: string, expectedVersion: string, candidate: SessionModelContract): SessionModelContract {
    const existing = this.modelContract(sessionId), contract = sessionModelContractSchema.parse(candidate);
    if (!existing || existing.version !== expectedVersion || contract.policyId !== existing.policyId || contract.version === expectedVersion) {
      throw new Error('Model policy migration does not match the current bound version.');
    }
    this.#append(sessionId, { kind: 'model_contract_updated', payload: { expectedVersion, contract } });
    return structuredClone(contract);
  }

  hasSession(sessionId: string): boolean {
    return this.#load(sessionId).length > 0;
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

  async listMetadata(signal?: AbortSignal): Promise<SessionMetadataEntry[]> {
    signal?.throwIfAborted();
    const metadata = (sessionId: string, events: SessionEvent[]) => {
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.kind === 'session_created' || event.kind === 'session_metadata_updated') {
          return { sessionId, metadata: structuredClone(event.payload.metadata ?? {}) };
        }
      }
      return undefined;
    };
    const known = new Set(this.#events.keys());
    const entries = [...this.#events].flatMap(([id, events]) => {
      const entry = metadata(id, events);
      return entry ? [entry] : [];
    });
    if (this.#persistence?.listMetadata) entries.push(...await this.#persistence.listMetadata(known, signal));
    else for (const id of this.#persistence?.listSessionIds?.() ?? []) {
      signal?.throwIfAborted();
      if (!known.has(id)) {
        const entry = metadata(id, this.#load(id));
        if (entry) entries.push(entry);
      }
    }
    return entries;
  }

  listUserPrompts(input: RuntimeUserPromptsRequest): RuntimeUserPrompt[] {
    const since = Date.parse(input.since), until = Date.parse(input.until);
    const identities = new Set([...this.#events.keys(), ...(this.#persistence?.listSessionIds?.() ?? [])]);
    const prompts: RuntimeUserPrompt[] = [];
    for (const sessionId of identities) {
      // Read the validated journal in place; do not clone/transport assistant
      // payloads or rebuild a second store of conversation facts.
      const events = this.#load(sessionId);
      let metadata: Record<string, unknown> | undefined;
      const superseded = new Set<string>();
      for (const event of events) {
        if (event.kind === 'session_created' || event.kind === 'session_metadata_updated') metadata = event.payload.metadata;
        if (event.kind === 'messages_superseded') event.payload.messageIds.forEach(id => superseded.add(id));
        if (event.kind === 'turn_committed') event.payload.supersession?.messageIds.forEach(id => superseded.add(id));
      }
      if (metadata?.agentRole === 'child' || metadata?.hidden === true || metadata?.automationId || metadata?.automationRunId) continue;
      for (const event of events) {
        if (event.kind !== 'turn_committed') continue;
        for (const item of event.payload.messages) {
          const time = Date.parse(item.createdAt);
          if (!Number.isFinite(time) || time < since || time > until || superseded.has(item.messageId)) continue;
          if (item.message.role !== 'user' || item.message.visibility === 'internal' ||
            (item.message.name && item.message.name !== 'goal_request')) continue;
          const content = authoredPromptContent(item.message.content, item.metadata);
          if (!content.trim()) continue;
          prompts.push({ sessionId, messageId: item.messageId, createdAt: item.createdAt,
            content: content.slice(0, 4000), truncated: content.length > 4000 });
        }
      }
    }
    return prompts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.sessionId.localeCompare(b.sessionId) || a.messageId.localeCompare(b.messageId)).slice(0, input.limit);
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
    this.#bytes.delete(normalized);
    this.#persistence?.remove?.(normalized);
    return true;
  }

  /** Fork committed history only, into a separately created workspace/session. */
  fork(sourceSessionId: string, sessionId: string): SessionSnapshot {
    if (sourceSessionId === sessionId) throw new Error('Fork requires a different session.');
    const source = this.snapshot(sourceSessionId), target = this.snapshot(sessionId);
    if (!source || !target) throw new Error('Fork source or destination does not exist.');
    if (target.turns.length || target.metadata?.forkSourceSessionId || this.modelContract(sessionId)) throw new Error('Fork destination must be empty.');
    const rebase = (text: string) => text.replaceAll(`tool-result://${encodeURIComponent(sourceSessionId)}/`, `tool-result://${encodeURIComponent(sessionId)}/`);
    const standaloneSuperseded = new Set(source.supersededMessageIds);
    try {
      const contract = this.modelContract(sourceSessionId);
      if (contract) this.bindModelContract(sessionId, contract);
      for (const sourceTurn of source.turns) {
        const turn = structuredClone(sourceTurn);
        // Turn-level supersessions are replayed with the committed Turn itself.
        turn.supersession?.messageIds.forEach(id => standaloneSuperseded.delete(id));
        delete turn.cacheChainState;
        delete turn.usage.lastRequestInputBasis;
        if (turn.contextSummary) turn.contextSummary = rebase(turn.contextSummary);
        if (turn.contextCheckpoint && 'summary' in turn.contextCheckpoint) turn.contextCheckpoint.summary = rebase(turn.contextCheckpoint.summary);
        for (const item of turn.messages) {
          if (item.message.role === 'tool') item.message.content = rebase(item.message.content);
          if (item.message.role === 'assistant') {
            delete item.message.providerReplay;
            item.message.content = rebase(item.message.content);
            for (const call of item.message.toolCalls) {
              if (call.name === 'checkpoint_context') call.argumentsText = rebase(call.argumentsText);
              if (call.name === 'summary_for_user') {
                let args;
                try { args = JSON.parse(call.argumentsText); } catch { continue; }
                if (typeof args.tool_summary === 'string') {
                  args.tool_summary = rebase(args.tool_summary);
                  call.argumentsText = JSON.stringify(args);
                  const receipt = turn.messages.find(fact => fact.message.role === 'tool' && fact.message.toolCallId === call.id);
                  if (receipt?.message.role === 'tool') {
                    let result;
                    try { result = JSON.parse(receipt.message.content); } catch { continue; }
                    if (result.context_handoff?.status === 'prepared') receipt.message.content = JSON.stringify({ ...result, ...preparedToolHandoffReceipt(args.tool_summary) });
                  }
                }
              }
            }
          }
        }
        if (turn.contextToolHandoff && isRecordedToolHandoff(turn.contextToolHandoff)) {
          // Archive locators were rebased above; bind to the fork's new facts.
          const handoff = findRecordedToolHandoff(turn);
          if (!handoff) throw new Error('Cannot rebase recorded tool handoff.');
          turn.contextToolHandoff = handoff;
        }
        this.#append(sessionId, { kind: 'turn_committed', payload: turn });
      }
      if (standaloneSuperseded.size) this.#append(sessionId, { kind: 'messages_superseded',
        payload: { messageIds: [...standaloneSuperseded], reason: 'Preserved fork history' } });
      const current = this.snapshot(sessionId)!;
      return this.updateMetadata({ sessionId, expectedRevision: current.revision,
        metadata: { ...target.metadata, forkSourceSessionId: sourceSessionId, forkSourceRevision: source.revision } });
    } catch (error) {
      // A failed projection must not prevent removing the partially copied fork.
      this.#persistence?.remove?.(sessionId);
      this.#events.delete(sessionId);
      this.#bytes.delete(sessionId);
      throw error;
    }
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
    if (turn.contextSummary || turn.contextToolHandoff) {
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
    validateCheckpointCoverage(turn, new Set(before.turns.map(item => item.turnId)),
      turn.contextCheckpoint?.projectionVersion === 'exchange_v1' && turn.contextCheckpoint.coveredMessageIds?.length
        ? before.turns.flatMap(item => item.messages) : []);
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
    summaries: TurnContextSummaryUpdate[];
  }): SessionSnapshot {
    const sessionId = requireIdentity(input.sessionId, "sessionId");
    const before = this.snapshot(sessionId);
    if (!before) throw new Error(`Session ${sessionId} does not exist.`);
    if (before.revision !== input.expectedRevision) {
      throw new Error(
        `Session ${sessionId} revision ${before.revision} does not match ${input.expectedRevision}.`,
      );
    }
    const summaries = input.summaries.map(item => turnContextSummaryUpdateSchema.parse(item));
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
      if ('toolHandoff' in item) {
        if (turn.contextToolHandoff || turn.messages.some(fact => before.supersededMessageIds.includes(fact.messageId))) {
          throw new Error('Prepared handoff source is already projected or was superseded.');
        }
        validateToolHandoff(turn, item.toolHandoff);
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
    if (cached) { this.#events.delete(sessionId); this.#events.set(sessionId, cached); return cached; }
    const loaded = (this.#persistence?.load(sessionId) ?? []).map((event) =>
      sessionEventSchema.parse(event),
    );
    if (loaded.length > 0) projectSession(sessionId, loaded);
    this.#events.set(sessionId, loaded);
    if (this.#persistence) this.#bytes.set(sessionId, Buffer.byteLength(JSON.stringify(loaded)));
    this.#trimCache();
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
    if (this.#persistence && this.#events.has(sessionId)) {
      this.#bytes.set(sessionId, (this.#bytes.get(sessionId) ?? 0) + Buffer.byteLength(JSON.stringify(event)));
      this.#trimCache();
    }
    return event;
  }

  #trimCache() {
    // In-memory stores own the source itself, so only durable facts may be evicted.
    if (!this.#persistence) return;
    const idle = [...this.#events.keys()].filter(id => !this.#protected.has(id));
    let bytes = idle.reduce((sum, id) => sum + (this.#bytes.get(id) ?? 0), 0), count = idle.length;
    for (const id of idle) {
      if (count <= this.#idleCacheLimit && bytes <= this.#idleCacheBytes) break;
      bytes -= this.#bytes.get(id) ?? 0; count--;
      this.#events.delete(id); this.#bytes.delete(id);
    }
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
  let modelContractBound: SessionModelContract | undefined;
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
    if (event.kind === 'model_contract_bound') {
      if (modelContractBound) throw new Error('Session model contract may only be bound once.');
      modelContractBound = event.payload;
    }
    if (event.kind === 'model_contract_updated') {
      const { expectedVersion, contract } = event.payload;
      if (!modelContractBound || modelContractBound.version !== expectedVersion ||
        modelContractBound.policyId !== contract.policyId || contract.version === expectedVersion) {
        throw new Error('Model policy migration does not match the bound contract.');
      }
      modelContractBound = contract;
    }
    if (event.kind === "turn_committed") {
      const turn = event.payload;
      validateCommittedTurn(turn);
      validateCheckpointCoverage(turn, turnIds, turn.contextCheckpoint?.projectionVersion === 'exchange_v1' &&
        turn.contextCheckpoint.coveredMessageIds?.length ? turns.flatMap(item => item.messages) : []);
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
        if ('toolHandoff' in item) {
          if (turn.contextToolHandoff || turn.messages.some(fact => superseded.has(fact.messageId))) {
            throw new Error('Prepared handoff source is already projected or was superseded.');
          }
          validateToolHandoff(turn, item.toolHandoff);
          turn.contextToolHandoff = item.toolHandoff;
        } else {
          turn.contextSummary = item.summary;
          delete turn.contextToolHandoff;
        }
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

export function addSupersededMessages(known: Set<string>, superseded: Set<string>, ids: string[]): void {
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`Cannot supersede unknown message ${id}.`);
    if (superseded.has(id)) throw new Error(`Message ${id} was superseded more than once.`);
    superseded.add(id);
  }
}

export function validateCommittedTurn(turn: CommittedTurn): void {
  if (turn.contextToolHandoff) validateToolHandoff(turn, turn.contextToolHandoff);
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
    if (turn.contextCheckpoint.projectionVersion === "exchange_v1") {
      const [assistantId, receiptId] = turn.contextCheckpoint.exchangeMessageIds;
      const assistant = turn.messages[boundaryIndex - 1];
      const receipt = turn.messages[boundaryIndex];
      if (boundaryIndex - 1 < turn.contextCheckpoint.inputMessageCount ||
        assistant?.messageId !== assistantId || receipt?.messageId !== receiptId ||
        assistant.message.role !== "assistant" || assistant.message.toolCalls.length !== 1 ||
        assistant.message.toolCalls[0]!.name !== "checkpoint_context" || receipt.message.role !== "tool" ||
        receipt.message.toolCallId !== assistant.message.toolCalls[0]!.id) {
        throw new Error("Turn context checkpoint must reference a complete checkpoint_context exchange.");
      }
      if (turn.contextCheckpoint.coveredTurnIds.includes(turn.turnId)) {
        throw new Error("Turn context checkpoint cannot cover its own Turn.");
      }
      const retained = turn.contextCheckpoint.retainedMessageIds ?? [];
      const available = new Map(turn.messages.slice(turn.contextCheckpoint.inputMessageCount, boundaryIndex - 1)
        .map(item => [item.messageId, item.message]));
      if (new Set(retained).size !== retained.length || retained.some(id => !available.has(id))) {
        throw new Error('Context checkpoint retained facts must be unique generated messages before its exchange.');
      }
      validateConversation(retained.map(id => available.get(id)!));
    }
  }
  validateConversation(turn.messages.map((message) => message.message));
}

export function validateCheckpointCoverage(turn: CommittedTurn, priorTurnIds: Set<string>,
  priorMessages?: CommittedTurn['messages'], priorMessageIds?: ReadonlySet<string>): void {
  if (turn.contextCheckpoint?.projectionVersion !== "exchange_v1") return;
  const ids = turn.contextCheckpoint.coveredTurnIds;
  if (new Set(ids).size !== ids.length || ids.some(id => !priorTurnIds.has(id))) {
    throw new Error("Context checkpoint coverage must contain unique preceding Turn identities.");
  }
  const partial = turn.contextCheckpoint.coveredMessageIds ?? [];
  if (!partial.length) return;
  const known = new Set(priorMessages?.map(message => message.messageId) ?? priorMessageIds ?? []);
  if (new Set(partial).size !== partial.length || partial.some(id => !known.has(id))) {
    throw new Error('Context checkpoint partial coverage must contain unique preceding message identities.');
  }
  const covered = new Set(partial);
  if (priorMessages) validateConversation(priorMessages.filter(message => !covered.has(message.messageId)).map(message => message.message));
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
