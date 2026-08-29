import {
  BUSH_TOOL_EXECUTION_RECORD_PROTOCOL,
  toolExecutionRecordSchema,
  type ToolCall,
  type ToolExecutionRecord,
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
    const candidate = toolExecutionRecordSchema.parse({
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
      result: outcome.result,
    });
    validateRecord(candidate);
    const records = this.#load(identity.sessionId);
    const existing = records.find(
      (record) =>
        record.turnId === identity.turnId && record.toolCall.id === toolCall.id,
    );
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(candidate)) return existing;
      throw new Error(`Tool execution ${toolCall.id} already has different facts.`);
    }
    const receiptIds = new Set(
      records.flatMap((record) => record.result.facts.map((fact) => fact.receipt_id)),
    );
    for (const fact of candidate.result.facts) {
      if (receiptIds.has(fact.receipt_id)) {
        throw new Error(`Execution Fact ${fact.receipt_id} already exists.`);
      }
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

  #load(sessionId: string): ToolExecutionRecord[] {
    const cached = this.#records.get(sessionId);
    if (cached) return cached;
    const loaded = (this.#persistence?.load(sessionId) ?? []).map((record) => {
      const parsed = toolExecutionRecordSchema.parse(record);
      validateRecord(parsed);
      return parsed;
    });
    const identities = new Set<string>();
    const receipts = new Set<string>();
    for (const record of loaded) {
      const identity = JSON.stringify([record.turnId, record.toolCall.id]);
      if (identities.has(identity)) throw new Error("Duplicate persisted Tool execution identity.");
      identities.add(identity);
      for (const fact of record.result.facts) {
        if (receipts.has(fact.receipt_id)) {
          throw new Error(`Duplicate persisted Execution Fact ${fact.receipt_id}.`);
        }
        receipts.add(fact.receipt_id);
      }
    }
    this.#records.set(sessionId, loaded);
    return loaded;
  }
}

function validateRecord(record: ToolExecutionRecord): void {
  if (record.result.tool_call_id !== record.toolCall.id) {
    throw new Error("Tool execution result identity mismatch.");
  }
  const artifactIds = record.result.artifacts.map((artifact) => artifact.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("Tool execution contains duplicate Artifact identities.");
  }
  const changeIds = record.result.workspace_changes.map((change) => change.change_id);
  if (new Set(changeIds).size !== changeIds.length) {
    throw new Error("Tool execution contains duplicate Workspace Change identities.");
  }
}
