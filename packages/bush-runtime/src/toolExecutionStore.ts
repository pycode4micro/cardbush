import { memoryCacheEntry, type CacheEntry } from './cacheMaintenance.js';
import { summarizeExecution, type ExecutionHistoryPage } from './executionHistory.js';
import {
  BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
  BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL,
  WORKSPACE_REVIEW_TURN_LIMIT,
  toolExecutionRecordSchema,
  type ToolCall,
  type ToolExecutionRecord,
  type ToolExecutionSummary,
} from "@cardbush/bush-protocol";

import type {
  ToolExecutionIdentity,
  ToolExecutionOutcome,
} from "./toolExecutionCoordinator.js";

export interface ToolExecutionPersistence {
  cacheEntries?(): Promise<CacheEntry[]>;
  historySummaries?(sessionId: string, signal?: AbortSignal): Promise<ExecutionHistoryPage>;
  load(sessionId: string): ToolExecutionRecord[];
  append(record: ToolExecutionRecord): void;
  loadFileMemoReferences?(): FileMemoLocator[];
  appendFileMemoReference?(reference: FileMemoLocator): void;
}

export interface FileMemoLocator { number: number; sessionId: string; turnId: string; toolCallId: string }

export class ToolExecutionStore {
  readonly #coldWorkspaceRecords = new WeakSet<ToolExecutionRecord>();
  readonly #coldWorkspaceChanges = new WeakSet<object>();
  readonly #persistence?: ToolExecutionPersistence;
  readonly #now: () => string;
  readonly #records = new Map<string, ToolExecutionRecord[]>();
  #fileMemoReferences?: FileMemoLocator[];

  constructor(options: {
    persistence?: ToolExecutionPersistence;
    now?: () => string;
  } = {}) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async cacheEntries(): Promise<CacheEntry[]> {
    return [...await this.#persistence?.cacheEntries?.() ?? [], ...[...this.#records].map(([id, rows]) =>
      memoryCacheEntry('tool_executions', id, this.#persistence?.cacheEntries ? [] : rows, () => this.#records.delete(id)))];
  }

  fileMemoLocators(): FileMemoLocator[] { return [...this.#loadFileMemoReferences()]; }

  async historySummaries(sessionId: string, signal?: AbortSignal): Promise<ExecutionHistoryPage> {
    signal?.throwIfAborted();
    if (this.#persistence?.historySummaries) return this.#persistence.historySummaries(sessionId, signal);
    // In-memory hosts can project existing records without cloning large native results.
    return { entries: this.#load(sessionId).flatMap(record => {
      signal?.throwIfAborted();
      const entry = summarizeExecution(record);
      return entry ? [entry] : [];
    }), omitted: 0 };
  }

  record(
    toolCall: ToolCall,
    identity: ToolExecutionIdentity,
    outcome: ToolExecutionOutcome,
    modelText?: string,
  ): ToolExecutionRecord {
    const candidate = structuredClone(toolExecutionRecordSchema.parse({
      protocol: BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
      requestId: identity.requestId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      round: identity.round,
      ordinal: identity.ordinal,
      recordedAt: this.#now(),
      toolCall,
      outcome: outcome.kind,
      actionManifest: outcome.actionManifest,
      ...(outcome.kind === "returned" ? { result: outcome.result } : {}),
      ...(outcome.kind === "returned" && modelText !== undefined ? { modelText } : {}),
      workspaceChanges: outcome.workspaceChanges,
      ...(outcome.kind === "returned" ? {} : { error: outcome.error }),
    }));
    validateRecord(candidate);
    const records = this.#load(identity.sessionId);
    const existing = records.find(
      (record) =>
        record.turnId === identity.turnId && record.toolCall.id === toolCall.id,
    );
    if (existing) {
      const complete = this.#fullRecords(identity.sessionId, [existing])[0];
      if (JSON.stringify(complete) === JSON.stringify(candidate)) return structuredClone(complete);
      throw new Error(`Tool execution ${toolCall.id} already has a different record.`);
    }
    this.#persistence?.append(structuredClone(candidate));
    const returned = structuredClone(candidate);
    records.push(candidate);
    this.#releaseOldWorkspacePayloads(records);
    return returned;
  }

  get(sessionId: string, turnId: string, toolCallId: string): ToolExecutionRecord | undefined {
    const record = this.#load(sessionId).find(
      (item) => item.turnId === turnId && item.toolCall.id === toolCallId,
    );
    return record ? structuredClone(this.#fullRecords(sessionId, [record])[0]) : undefined;
  }

  listTurn(sessionId: string, turnId: string): ToolExecutionRecord[] {
    return this.#fullRecords(sessionId, this.#load(sessionId)
      .filter((record) => record.turnId === turnId))
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(record));
  }

  /** Filter before cloning: a small tool-owned index must not copy unrelated logs. */
  listByTool(sessionId: string, toolName: string): ToolExecutionRecord[] {
    return this.#fullRecords(sessionId, this.#load(sessionId).filter(record => record.toolCall.name === toolName))
      .map(record => structuredClone(record));
  }

  listTurnSummaries(sessionId: string, turnId: string): ToolExecutionSummary[] {
    return this.#load(sessionId)
      .filter((record) => record.turnId === turnId)
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(toolExecutionSummary(record, this.#coldWorkspaceChanges)));
  }

  /** Reserve before returning the Tool result. Gaps after cancellation are never reused. */
  reserveFileMemoReference(identity: Omit<FileMemoLocator, 'number'>): number {
    if (this.#persistence && (!this.#persistence.loadFileMemoReferences || !this.#persistence.appendFileMemoReference)) {
      throw new Error('File memo references require durable locator storage.');
    }
    const references = this.#loadFileMemoReferences();
    const existing = references.find(item => item.sessionId === identity.sessionId && item.turnId === identity.turnId && item.toolCallId === identity.toolCallId);
    if (existing) return existing.number;
    const reference = { ...identity, number: (references.at(-1)?.number ?? 0) + 1 };
    if (reference.number > 999_999_999) throw new Error('File reference number limit reached.');
    try { this.#persistence?.appendFileMemoReference?.(reference); }
    catch (error) { this.#fileMemoReferences = undefined; throw error; }
    references.push(reference);
    return reference.number;
  }

  getFileMemoReference(number: number): FileMemoLocator | undefined {
    const reference = this.#loadFileMemoReferences().find(item => item.number === number);
    return reference && { ...reference };
  }

  #loadFileMemoReferences(): FileMemoLocator[] {
    if (this.#fileMemoReferences) return this.#fileMemoReferences;
    const references = this.#persistence?.loadFileMemoReferences?.() ?? [];
    let previous = 0;
    const seen = new Set<string>();
    for (const reference of references) {
      const identity = JSON.stringify([reference.sessionId, reference.turnId, reference.toolCallId]);
      if (!Number.isSafeInteger(reference.number) || reference.number <= previous || reference.number > 999_999_999
          || [reference.sessionId, reference.turnId, reference.toolCallId].some(value => typeof value !== 'string' || !value)
          || seen.has(identity)) throw new Error('File reference index is invalid.');
      previous = reference.number; seen.add(identity);
    }
    return this.#fileMemoReferences = structuredClone(references);
  }

  #load(sessionId: string): ToolExecutionRecord[] {
    const cached = this.#records.get(sessionId);
    if (cached) return cached;
    const loaded = (this.#persistence?.load(sessionId) ?? []).map((record) => {
      const parsed = toolExecutionRecordSchema.parse(record);
      validateRecord(parsed);
      return parsed;
    });
    const identities = new Set<string>();
    for (const record of loaded) {
      const identity = JSON.stringify([record.turnId, record.toolCall.id]);
      if (identities.has(identity)) throw new Error("Duplicate persisted Tool execution identity.");
      identities.add(identity);
    }
    this.#releaseOldWorkspacePayloads(loaded);
    this.#records.set(sessionId, loaded);
    return loaded;
  }

  #releaseOldWorkspacePayloads(records: ToolExecutionRecord[]) {
    // The immutable journal remains the authority. Only evict cached undo/diff
    // payloads; a later explicit request for an old Tool still returns its facts.
    if (!this.#persistence) return;
    const turns = new Set([...new Set(records.map(record => record.turnId))].slice(-WORKSPACE_REVIEW_TURN_LIMIT));
    for (const record of records) {
      if (turns.has(record.turnId) || this.#coldWorkspaceRecords.has(record)) continue;
      for (const change of record.workspaceChanges) {
        if ('beforeContentBase64' in change.metadata || 'diff' in change.metadata) {
          const { beforeContentBase64: _before, diff: _diff, ...metadata } = change.metadata;
          change.metadata = metadata;
          this.#coldWorkspaceRecords.add(record);
          this.#coldWorkspaceChanges.add(change);
        }
      }
    }
  }

  #fullRecords(sessionId: string, records: ToolExecutionRecord[]): ToolExecutionRecord[] {
    if (!records.some(record => this.#coldWorkspaceRecords.has(record))) return records;
    const originals = new Map<string, ToolExecutionRecord>();
    for (const record of this.#persistence!.load(sessionId)) {
      const key = JSON.stringify([record.turnId, record.toolCall.id]);
      if (originals.has(key)) throw new Error('Duplicate persisted Tool execution identity.');
      originals.set(key, record);
    }
    return records.map(record => {
      if (!this.#coldWorkspaceRecords.has(record)) return record;
      const original = originals.get(JSON.stringify([record.turnId, record.toolCall.id]));
      if (!original) throw new Error('The original Tool execution is missing from its journal.');
      const parsed = toolExecutionRecordSchema.parse(original);
      validateRecord(parsed);
      return parsed;
    });
  }
}

function toolExecutionSummary(record: ToolExecutionRecord, deferred?: WeakSet<object>): ToolExecutionSummary {
  return {
    protocol: BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL,
    requestId: record.requestId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    round: record.round,
    ordinal: record.ordinal,
    recordedAt: record.recordedAt,
    toolCall: {
      protocol: record.toolCall.protocol,
      id: record.toolCall.id,
      name: record.toolCall.name,
    },
    outcome: record.outcome,
    actionManifest: record.actionManifest,
    resultAvailable: Object.prototype.hasOwnProperty.call(record, "result"),
    workspaceChanges: record.workspaceChanges.map(change => {
      const { metadata, ...summary } = change;
      return { ...summary, detailAvailable: Object.keys(metadata).length > 0 || deferred?.has(change) === true };
    }),
    error: record.error,
  };
}

function validateRecord(record: ToolExecutionRecord): void {
  const changeIds = record.workspaceChanges.map((change) => change.change_id);
  if (new Set(changeIds).size !== changeIds.length) {
    throw new Error("Tool execution contains duplicate Workspace Change identities.");
  }
}
