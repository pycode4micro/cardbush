import {
  BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
  BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL,
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
  load(sessionId: string): ToolExecutionRecord[];
  append(record: ToolExecutionRecord): void;
}

export class ToolExecutionStore {
  readonly #persistence?: ToolExecutionPersistence;
  readonly #now: () => string;
  readonly #records = new Map<string, ToolExecutionRecord[]>();

  constructor(options: {
    persistence?: ToolExecutionPersistence;
    now?: () => string;
  } = {}) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  record(
    toolCall: ToolCall,
    identity: ToolExecutionIdentity,
    outcome: ToolExecutionOutcome,
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
      if (JSON.stringify(existing) === JSON.stringify(candidate)) return existing;
      throw new Error(`Tool execution ${toolCall.id} already has a different record.`);
    }
    this.#persistence?.append(candidate);
    records.push(candidate);
    return structuredClone(candidate);
  }

  get(sessionId: string, turnId: string, toolCallId: string): ToolExecutionRecord | undefined {
    const record = this.#load(sessionId).find(
      (item) => item.turnId === turnId && item.toolCall.id === toolCallId,
    );
    return record ? structuredClone(record) : undefined;
  }

  listTurn(sessionId: string, turnId: string): ToolExecutionRecord[] {
    return this.#load(sessionId)
      .filter((record) => record.turnId === turnId)
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(record));
  }

  listTurnSummaries(sessionId: string, turnId: string): ToolExecutionSummary[] {
    return this.#load(sessionId)
      .filter((record) => record.turnId === turnId)
      .sort((left, right) => left.round - right.round || left.ordinal - right.ordinal)
      .map((record) => structuredClone(toolExecutionSummary(record)));
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
    this.#records.set(sessionId, loaded);
    return loaded;
  }
}

function toolExecutionSummary(record: ToolExecutionRecord): ToolExecutionSummary {
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
    workspaceChanges: record.workspaceChanges.map(({ metadata, ...change }) => ({
      ...change,
      detailAvailable: Object.keys(metadata).length > 0,
    })),
    error: record.error,
  };
}

function validateRecord(record: ToolExecutionRecord): void {
  const changeIds = record.workspaceChanges.map((change) => change.change_id);
  if (new Set(changeIds).size !== changeIds.length) {
    throw new Error("Tool execution contains duplicate Workspace Change identities.");
  }
}
