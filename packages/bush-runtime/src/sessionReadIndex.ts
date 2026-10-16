import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import {
  BUSH_SESSION_SNAPSHOT_PROTOCOL, sessionEventSchema, sessionMessageExcerpt, sessionSummarySchema,
  type SessionEvent, type SessionSummary, type SessionHistoryRequest, type SessionHistoryPage,
} from '@cardbush/bush-protocol';
import { boundedJournalLines } from './boundedJournalLines.js';
import { validateCommittedTurn, validateCheckpointCoverage, addSupersededMessages, historyCursorError } from './sessionStore.js';

export type StoredHistoryPage = Omit<SessionHistoryPage, 'toolExecutions' | 'contextCompactions'>;
type TurnLocation = { turnId: string; sequence: number; createdAt: string; start: number; end: number; contextSummary?: string };
type Excerpt = { id: string; role: 'user' | 'assistant'; text: string };
type Index = {
  version: 1; through: number; mtimeMs: number; prefix: string; summary: SessionSummary;
  historyRevision: number; turns: TurnLocation[]; excerpts: Excerpt[]; superseded: string[]; eventIds: string[]; messageIds: string[];
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Disposable excerpts and byte offsets. Canonical records are always checked when read. */
export class SessionReadIndex {
  readonly #cache = new Map<string, Index>();
  readonly #bytes = new Map<string, number>();
  readonly #pending = new Map<string, Promise<Index | undefined>>();

  forget(journal: string) { this.#cache.delete(journal); this.#bytes.delete(journal); }
  clear() { this.#cache.clear(); this.#bytes.clear(); }

  async summary(journal: string, signal?: AbortSignal): Promise<SessionSummary | undefined> {
    const index = await this.#read(journal, signal);
    return index && structuredClone(index.summary);
  }

  async page(journal: string, input: SessionHistoryRequest, signal?: AbortSignal): Promise<StoredHistoryPage | undefined> {
    const index = await this.#read(journal, signal);
    if (!index) return undefined;
    if (index.summary.sessionId !== input.sessionId) throw Error('Session index identity mismatch.');
    if (input.cursor && input.cursor.historyRevision !== index.historyRevision) throw historyCursorError();
    const end = input.cursor ? index.turns.findIndex(turn => turn.sequence >= input.cursor!.beforeTurnSequence) : index.turns.length;
    if (end < 0 || (input.cursor && end === index.turns.length)) throw historyCursorError();
    const start = Math.max(0, end - input.limit), locations = index.turns.slice(start, end);
    const file = await open(journal, 'r');
    try {
      const turns = [];
      for (const location of locations) {
        signal?.throwIfAborted();
        const bytes = Buffer.alloc(location.end - location.start);
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const read = await file.read(bytes, offset, bytes.length - offset, location.start + offset);
          if (!read.bytesRead) throw historyCursorError();
          offset += read.bytesRead;
        }
        const event = decodeSessionRecord(bytes.toString('utf8'), input.sessionId);
        if (event.kind !== 'turn_committed' || event.payload.turnId !== location.turnId || event.payload.turnSequence !== location.sequence) throw historyCursorError();
        const turn = event.payload;
        validateCommittedTurn(turn);
        turns.push({ ...turn, ...(location.contextSummary ? { contextSummary: location.contextSummary } : {}) });
      }
      // Append-only writes preserve offsets. Replacement/truncation invalidates this page.
      const current = await file.stat();
      if (current.size < index.through || (current.size === index.through && current.mtimeMs !== index.mtimeMs)) throw historyCursorError();
      const selectedIds = new Set(turns.flatMap(turn => turn.messages.map(message => message.messageId)));
      const summary = structuredClone(index.summary);
      return { summary, historyRevision: index.historyRevision, beforeCreatedAt: index.turns[end]?.createdAt,
        nextCursor: start > 0 ? { beforeTurnSequence: locations[0]!.sequence, historyRevision: index.historyRevision } : null,
        snapshot: { protocol: BUSH_SESSION_SNAPSHOT_PROTOCOL, sessionId: summary.sessionId, revision: summary.revision,
          createdAt: summary.createdAt, updatedAt: summary.updatedAt, metadata: summary.metadata, turns,
          supersededMessageIds: index.superseded.filter(id => selectedIds.has(id)) } };
    } finally { await file.close(); }
  }

  #read(journal: string, signal?: AbortSignal): Promise<Index | undefined> {
    const prior = this.#pending.get(journal);
    const task = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() => this.#load(journal, signal));
    this.#pending.set(journal, task);
    return task.finally(() => { if (this.#pending.get(journal) === task) this.#pending.delete(journal); });
  }

  async #load(journal: string, signal?: AbortSignal): Promise<Index | undefined> {
    signal?.throwIfAborted();
    const source = await stat(journal).catch(error => { if (!missing(error)) throw error; });
    if (!source) { this.forget(journal); return undefined; }
    const sidecar = journal + '.session-index';
    let index = this.#cache.get(journal);
    if (index && index.through === source.size && index.mtimeMs === source.mtimeMs) {
      this.#remember(journal, index); return index;
    }
    if (!index) {
      try {
        const saved = JSON.parse(await readFile(sidecar, 'utf8'));
        if (saved.checksum === digest(JSON.stringify(saved.index)) && validIndex(saved.index, journal)) index = saved.index;
      } catch { signal?.throwIfAborted(); } // The derived cache must never block the canonical journal.
    }
    if (index && (index.through > source.size || (index.through === source.size && index.mtimeMs !== source.mtimeMs) ||
      index.prefix !== await prefixHash(journal, index.through))) index = undefined;
    if (index?.through === source.size && index.mtimeMs === source.mtimeMs) { this.#remember(journal, index); return index; }
    // Never mutate a cached index that an earlier page read still owns.
    index = index ? structuredClone(index) : undefined;
    const ids = { events: new Set(index?.eventIds), messages: new Set(index?.messageIds),
      turns: new Set(index?.turns.map(turn => turn.turnId)), superseded: new Set(index?.superseded) };
    for await (const line of boundedJournalLines(journal, { start: index?.through ?? 0, end: source.size, maxBytes: Number.MAX_SAFE_INTEGER, signal })) {
      signal?.throwIfAborted();
      if (!line.text?.trim()) continue;
      const event = decodeSessionRecord(line.text, index?.summary.sessionId);
      if (!index) {
        if (event.kind !== 'session_created' || event.sequence !== 1 || !journal.endsWith(digest(event.sessionId) + '.jsonl')) throw Error('Session journal identity mismatch.');
        index = { version: 1, through: 0, mtimeMs: 0, prefix: '', historyRevision: 0, turns: [], excerpts: [], superseded: [], eventIds: [], messageIds: [],
          summary: { sessionId: event.sessionId, revision: 0, createdAt: event.createdAt, updatedAt: event.createdAt,
            turnCount: 0, firstUserText: '', preview: '' } };
      }
      applyEvent(index, event, line.start, line.end, ids);
    }
    if (!index) return undefined;
    const superseded = new Set(index.superseded);
    index.excerpts = index.excerpts.filter(entry => !superseded.has(entry.id));
    index.summary.firstUserText = index.excerpts.find(entry => entry.role === 'user')?.text ?? '';
    index.summary.preview = [...index.excerpts].reverse().find(entry => entry.role === 'assistant')?.text ?? '';
    index.mtimeMs = source.mtimeMs;
    index.prefix = await prefixHash(journal, index.through);
    signal?.throwIfAborted();
    // A concurrently deleted journal must not be recreated by an index writer.
    const stillExists = await stat(journal).catch(error => { if (!missing(error)) throw error; });
    if (!stillExists) { this.forget(journal); return undefined; }
    const temporary = `${sidecar}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ index, checksum: digest(JSON.stringify(index)) }), { flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(temporary, sidecar);
    } catch { signal?.throwIfAborted(); }
    finally { await unlink(temporary).catch(() => {}); }
    this.#remember(journal, index);
    return index;
  }

  #remember(journal: string, index: Index) {
    if (this.#cache.get(journal) !== index) this.#bytes.set(journal, Buffer.byteLength(JSON.stringify(index)));
    this.#cache.delete(journal); this.#cache.set(journal, index);
    let bytes = [...this.#bytes.values()].reduce((a, b) => a + b, 0);
    while (this.#cache.size > 24 || bytes > 16 * 1024 * 1024) {
      const first = this.#cache.keys().next().value!; bytes -= this.#bytes.get(first) ?? 0; this.forget(first);
    }
  }
}

export function decodeSessionRecord(text: string, sessionId?: string): SessionEvent {
  const record = JSON.parse(text);
  if (record.protocol !== 'bush.session_event_record.v1' || record.checksum !== digest(JSON.stringify(record.event))) throw Error('Session journal checksum mismatch.');
  const event = sessionEventSchema.parse(record.event);
  if (sessionId !== undefined && event.sessionId !== sessionId) throw Error('Session journal identity mismatch.');
  return event;
}

function applyEvent(index: Index, event: SessionEvent, start: number, end: number,
  ids: { events: Set<string>; messages: Set<string>; turns: Set<string>; superseded: Set<string> }) {
  if (event.sequence !== index.summary.revision + 1) throw Error('Session journal sequence is not contiguous.');
  if (ids.events.has(event.eventId)) throw Error('Duplicate session event identity.');
  ids.events.add(event.eventId); index.eventIds.push(event.eventId);
  if ((event.kind === 'session_metadata_updated' || event.kind === 'turn_context_summarized') &&
      event.payload.expectedRevision !== index.summary.revision) throw Error('Session expected revision mismatch.');
  const supersede = (messageIds: string[]) => {
    addSupersededMessages(ids.messages, ids.superseded, messageIds);
    index.superseded.push(...messageIds); index.historyRevision = event.sequence;
  };
  if (event.kind === 'session_created' && index.summary.revision !== 0) throw Error('Session may only be created once.');
  if (event.kind === 'session_created' || event.kind === 'session_metadata_updated') {
    if (event.payload.metadata) index.summary.metadata = event.payload.metadata; else delete index.summary.metadata;
  }
  if (event.kind === 'turn_committed') {
    const turn = event.payload;
    validateCommittedTurn(turn);
    validateCheckpointCoverage(turn, ids.turns);
    if (turn.supersession) supersede(turn.supersession.messageIds);
    if (turn.turnSequence !== index.turns.length + 1 || ids.turns.has(turn.turnId)) throw Error('Session turn sequence mismatch.');
    ids.turns.add(turn.turnId);
    for (const message of turn.messages) {
      if (ids.messages.has(message.messageId)) throw Error('Duplicate session message identity.');
      ids.messages.add(message.messageId); index.messageIds.push(message.messageId);
    }
    index.turns.push({ turnId: turn.turnId, sequence: turn.turnSequence, createdAt: turn.createdAt, start, end });
    index.excerpts.push(...turn.messages.flatMap(sessionMessageExcerpt));
    index.summary.turnCount = index.turns.length;
    index.summary.latestTurn = { turnId: turn.turnId, turnSequence: turn.turnSequence, status: turn.status,
      reason: turn.reason, completedAt: turn.completedAt, ...(turn.planWaiting ? { planWaiting: turn.planWaiting } : {}) };
  }
  if (event.kind === 'messages_superseded') supersede(event.payload.messageIds);
  if (event.kind === 'turn_context_summarized') {
    for (const summary of event.payload.summaries) {
      const turn = index.turns.find(turn => turn.turnId === summary.turnId);
      if (!turn || turn.contextSummary) throw Error('Invalid session context summary.');
      turn.contextSummary = summary.summary;
    }
  }
  index.summary.revision = event.sequence; index.summary.updatedAt = event.createdAt; index.through = end;
}

function validIndex(index: Index | undefined, journal: string): index is Index {
  return !!index && index.version === 1 && sessionSummarySchema.safeParse(index.summary).success &&
    journal.endsWith(digest(index.summary.sessionId) + '.jsonl') && Number.isSafeInteger(index.through) && index.through > 0 &&
    Number.isFinite(index.mtimeMs) && typeof index.prefix === 'string' && Number.isSafeInteger(index.historyRevision) && index.historyRevision >= 0 &&
    Array.isArray(index.turns) && index.turns.length === index.summary.turnCount && index.turns.every((turn, i) =>
      typeof turn.turnId === 'string' && typeof turn.createdAt === 'string' && turn.sequence === i + 1 && Number.isSafeInteger(turn.start) && Number.isSafeInteger(turn.end) &&
      turn.start >= 0 && turn.end > turn.start && turn.end <= index.through && (i === 0 || turn.start >= index.turns[i - 1]!.end) &&
      (turn.contextSummary === undefined || typeof turn.contextSummary === 'string')) &&
    Array.isArray(index.superseded) && index.superseded.every(id => typeof id === 'string') &&
    Array.isArray(index.eventIds) && index.eventIds.length === index.summary.revision && index.eventIds.every(id => typeof id === 'string') &&
    Array.isArray(index.messageIds) && index.messageIds.every(id => typeof id === 'string') &&
    Array.isArray(index.excerpts) && index.excerpts.every(entry => typeof entry.id === 'string' &&
      (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.length <= (entry.role === 'user' ? 4000 : 512));
}

async function prefixHash(path: string, through: number) {
  const file = await open(path, 'r');
  try { const bytes = Buffer.alloc(Math.min(4096, through)); const read = await file.read(bytes, 0, bytes.length, 0); return digest(bytes.subarray(0, read.bytesRead)); }
  finally { await file.close(); }
}
