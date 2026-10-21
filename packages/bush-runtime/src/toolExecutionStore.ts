import { memoryCacheEntry, type CacheEntry } from './cacheMaintenance.js';
import { summarizeExecution, type ExecutionHistoryPage } from './executionHistory.js';
import { isAbsolute, resolve } from 'node:path';
import {
  BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
  BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL,
  agentToolActivity,
  terminalToolOutcome,
  toolExecutionError,
  returnedToolError,
  savedNextStepPrediction,
  WORKSPACE_REVIEW_TURN_LIMIT,
  parseSourceMemoReference,
  sourceMemoSchema,
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

export interface FileMemoLocator { number: number; sessionId: string; turnId: string; toolCallId: string; sourceNumber?: number }
type MemoIdentity = Omit<FileMemoLocator, 'number' | 'sourceNumber'>;

/** Small facts for loop guidance; no argument, result body or error prose. */
export interface ToolExecutionSignal {
  turnId: string;
  toolCallId: string;
  tool: string;
  outcome: 'returned' | 'failed' | 'cancelled';
  errorCode?: string;
}

export class ToolExecutionStore {
  readonly #coldWorkspaceRecords = new WeakSet<ToolExecutionRecord>();
  readonly #coldWorkspaceChanges = new WeakSet<object>();
  readonly #persistence?: ToolExecutionPersistence;
  readonly #now: () => string;
  readonly #records = new Map<string, ToolExecutionRecord[]>();
  readonly #bytes = new Map<string, number>();
  readonly #protected = new Set<string>();
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
      memoryCacheEntry('tool_executions', id, this.#persistence?.cacheEntries ? [] : rows, () => { this.#records.delete(id); this.#bytes.delete(id); }))];
  }

  fileMemoLocators(): FileMemoLocator[] { return [...this.#loadFileMemoReferences()]; }

  protect(sessionId: string, value: boolean) {
    if (value) this.#protected.add(sessionId); else { this.#protected.delete(sessionId); this.#trim(); }
  }

  #trim() {
    if (!this.#persistence) return;
    const idle = [...this.#records.keys()].filter(id => !this.#protected.has(id));
    let count = idle.length, bytes = idle.reduce((total, id) => total + (this.#bytes.get(id) ?? 0), 0);
    for (const id of idle) {
      if (count <= 24 && bytes <= 64 * 1024 * 1024) break;
      count--; bytes -= this.#bytes.get(id) ?? 0; this.#records.delete(id); this.#bytes.delete(id);
    }
  }

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
    const resultError = outcome.kind === 'returned' ? outcome.resultError ?? returnedToolError(toolCall.name, outcome.result) : undefined;
    const candidate = structuredClone(toolExecutionRecordSchema.parse({
      protocol: BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
      requestId: identity.requestId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      round: identity.round,
      ordinal: identity.ordinal,
      recordedAt: this.#now(),
      toolCall,
      display: identity.display,
      outcome: outcome.kind,
      execution: outcome.execution,
      actionManifest: outcome.actionManifest,
      ...(outcome.kind === "returned" ? { result: outcome.result } : {}),
      ...(resultError ? { resultError } : {}),
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
    if (this.#persistence && this.#records.has(identity.sessionId)) this.#bytes.set(identity.sessionId,
      (this.#bytes.get(identity.sessionId) ?? 0) + Buffer.byteLength(JSON.stringify(candidate)));
    this.#releaseOldWorkspacePayloads(records);
    this.#trim();
    return returned;
  }

  get(sessionId: string, turnId: string, toolCallId: string): ToolExecutionRecord | undefined {
    const record = this.#load(sessionId).find(
      (item) => item.turnId === turnId && item.toolCall.id === toolCallId,
    );
    return record ? structuredClone(this.#fullRecords(sessionId, [record])[0]) : undefined;
  }

  /** Project only explicit native artifacts; never clone image bytes or treat
   * paths in arguments, model prose or script output as file-read grants. */
  hasImageArtifact(sessionId: string, path: string): boolean {
    if (!isAbsolute(path)) return false;
    const key = imagePathKey(path);
    return this.#load(sessionId).some(record => {
      if (record.outcome !== 'returned' || toolExecutionError(record)) return false;
      const native = artifactObject(record.result);
      const result = typeof artifactObject(native.mcp).name === 'string' ? artifactObject(native.result) : native;
      if (native.isError === true || result.isError === true) return false;
      return [result.artifacts, artifactObject(result.structuredContent).artifacts].some(artifacts =>
        Array.isArray(artifacts) && artifacts.some(value => {
          const artifact = artifactObject(value);
          return artifact.type === 'image' && typeof artifact.path === 'string' &&
            isAbsolute(artifact.path) && imagePathKey(artifact.path) === key;
        }));
    });
  }

  listTurn(sessionId: string, turnId: string): ToolExecutionRecord[] {
    return this.#fullRecords(sessionId, this.#load(sessionId)
      .filter((record) => record.turnId === turnId))
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(record));
  }

  /** Completion order, including nested/async calls; never infer order from rounds. */
  latestSignalMarker(sessionId: string): { turnId: string; toolCallId: string } | null {
    const last = this.#load(sessionId).at(-1);
    return last ? { turnId: last.turnId, toolCallId: last.toolCall.id } : null;
  }

  signalsAfter(sessionId: string, after: { turnId: string; toolCallId: string } | null): ToolExecutionSignal[] {
    const rows = this.#load(sessionId);
    const boundary = after ? rows.findIndex(row => row.turnId === after.turnId && row.toolCall.id === after.toolCallId) : -1;
    // A missing activation receipt is not permission to recall an older task.
    // null is an explicit native selection before this session had any receipts.
    if (after && boundary < 0) return [];
    return rows.slice(boundary + 1).map(row => {
      const failure = toolExecutionError(row);
      return { turnId: row.turnId, toolCallId: row.toolCall.id, tool: row.toolCall.name,
        outcome: row.outcome === 'cancelled' ? 'cancelled' : failure ? 'failed' : row.outcome,
        ...(failure ? { errorCode: failure.code } : {}) };
    });
  }

  fork(sourceSessionId: string, sessionId: string, turnIds: Set<string>): void {
    if (sourceSessionId === sessionId || this.#load(sessionId).length) throw new Error('Tool history fork requires an empty destination.');
    const records = this.#load(sessionId);
    for (const source of this.#fullRecords(sourceSessionId, this.#load(sourceSessionId).filter(record => turnIds.has(record.turnId)))) {
      // Preserve historical evidence, without claiming the fork performed file
      // writes or granting it undo actions against the source workspace.
      const record = toolExecutionRecordSchema.parse({ ...structuredClone(source), sessionId, workspaceChanges: [] });
      if (record.modelText) record.modelText = record.modelText.replaceAll(`tool-result://${encodeURIComponent(sourceSessionId)}/`, `tool-result://${encodeURIComponent(sessionId)}/`);
      this.#persistence?.append(record); records.push(record);
    }
    this.#releaseOldWorkspacePayloads(records);
    if (this.#persistence && this.#records.has(sessionId)) this.#bytes.set(sessionId, Buffer.byteLength(JSON.stringify(records)));
    this.#trim();
  }

  /** Filter before cloning: a small tool-owned index must not copy unrelated logs. */
  listByTool(sessionId: string, toolName: string, turnId?: string): ToolExecutionRecord[] {
    return this.#fullRecords(sessionId, this.#load(sessionId).filter(record => record.toolCall.name === toolName && (turnId === undefined || record.turnId === turnId)))
      .map(record => structuredClone(record));
  }

  listTurnSummaries(sessionId: string, turnId: string): ToolExecutionSummary[] {
    return this.listTurnsSummaries(sessionId, new Set([turnId]));
  }

  listTurnsSummaries(sessionId: string, turnIds: ReadonlySet<string>): ToolExecutionSummary[] {
    return this.#load(sessionId)
      .filter((record) => turnIds.has(record.turnId))
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(toolExecutionSummary(record, this.#coldWorkspaceChanges)));
  }

  /** Reserve before returning the Tool result. Gaps after cancellation are never reused. */
  reserveFileMemoReference(identity: MemoIdentity): number {
    return this.#reserveMemoReference(identity, false).number;
  }

  reserveSourceMemoReference(identity: MemoIdentity): FileMemoLocator {
    return this.#reserveMemoReference(identity, true);
  }

  #reserveMemoReference(identity: MemoIdentity, source: boolean): FileMemoLocator {
    if (this.#persistence && (!this.#persistence.loadFileMemoReferences || !this.#persistence.appendFileMemoReference)) {
      throw new Error('File memo references require durable locator storage.');
    }
    const references = this.#loadFileMemoReferences();
    const existing = references.find(item => item.sessionId === identity.sessionId && item.turnId === identity.turnId && item.toolCallId === identity.toolCallId);
    if (existing) return { ...existing };
    const reference: FileMemoLocator = { ...identity, number: (references.at(-1)?.number ?? 0) + 1 };
    if (reference.number > 999_999_999) throw new Error('File reference number limit reached.');
    if (source) {
      // Persist reservations, including cancelled writes, and continue inherited
      // or legacy display numbers without rewriting their immutable references.
      let previous = 0;
      for (const item of references) if (item.sessionId === identity.sessionId) previous = Math.max(previous, item.sourceNumber ?? 0);
      for (const record of this.#load(identity.sessionId)) {
        if (record.toolCall.name !== 'remember_source' || record.outcome !== 'returned') continue;
        const memo = sourceMemoSchema.safeParse(record.result);
        if (memo.success) previous = Math.max(previous, parseSourceMemoReference(memo.data.reference)!);
      }
      reference.sourceNumber = previous + 1;
      if (reference.sourceNumber > 999_999_999) throw new Error('Source number limit reached.');
    }
    try { this.#persistence?.appendFileMemoReference?.(reference); }
    catch (error) { this.#fileMemoReferences = undefined; throw error; }
    references.push(reference);
    return { ...reference };
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
    const sourceNumbers = new Map<string, number>();
    for (const reference of references) {
      const identity = JSON.stringify([reference.sessionId, reference.turnId, reference.toolCallId]);
      if (!Number.isSafeInteger(reference.number) || reference.number <= previous || reference.number > 999_999_999
          || [reference.sessionId, reference.turnId, reference.toolCallId].some(value => typeof value !== 'string' || !value)
          || seen.has(identity)) throw new Error('File reference index is invalid.');
      if (reference.sourceNumber !== undefined) {
        if (!Number.isSafeInteger(reference.sourceNumber) || reference.sourceNumber <= (sourceNumbers.get(reference.sessionId) ?? 0)
            || reference.sourceNumber > 999_999_999) throw new Error('Source number index is invalid.');
        sourceNumbers.set(reference.sessionId, reference.sourceNumber);
      }
      previous = reference.number; seen.add(identity);
    }
    return this.#fileMemoReferences = structuredClone(references);
  }

  #load(sessionId: string): ToolExecutionRecord[] {
    const cached = this.#records.get(sessionId);
    if (cached) { this.#records.delete(sessionId); this.#records.set(sessionId, cached); return cached; }
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
    if (this.#persistence) this.#bytes.set(sessionId, Buffer.byteLength(JSON.stringify(loaded)));
    this.#trim();
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

function artifactObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function imagePathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toolExecutionSummary(record: ToolExecutionRecord, deferred?: WeakSet<object>): ToolExecutionSummary {
  const activity = agentToolActivity(record);
  const nextStepPrediction = record.outcome === 'returned' ? savedNextStepPrediction(record.toolCall, record.result, record.recordedAt) : undefined;
  const terminalOutcome = record.outcome === 'returned' ? terminalToolOutcome(record.toolCall.name, record.result) : undefined;
  const resultError = record.outcome === 'returned' ? toolExecutionError(record) : undefined;
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
    execution: record.execution,
    ...(activity ? { agentActivity: activity } : {}),
    ...(nextStepPrediction ? { nextStepPrediction } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    display: record.display,
    actionManifest: record.actionManifest,
    resultAvailable: Object.prototype.hasOwnProperty.call(record, "result"),
    ...(resultError ? { resultError } : {}),
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
