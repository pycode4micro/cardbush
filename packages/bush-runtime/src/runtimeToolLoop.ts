import {
  type ModelMessage,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
  type ToolCall,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type {
  InMemoryRuntimeEventLog,
  RuntimeEventIdentity,
} from "./runtimeEventLog.js";
import { RuntimePermissionBroker } from "./runtimePermissionBroker.js";
import {
  ToolExecutionCoordinator,
  type ToolExecutionIdentity,
  type ToolExecutionOutcome,
} from "./toolExecutionCoordinator.js";
import type { ToolRegistry } from "./toolRegistry.js";
import type { ToolExecutionStore } from "./toolExecutionStore.js";

export interface RuntimeToolLoopOptions {
  eventLog: InMemoryRuntimeEventLog;
  identity: RuntimeEventIdentity;
  registry: ToolRegistry;
  createPermissionId?: () => string;
  existingReceiptIds?: string[];
  executionStore?: ToolExecutionStore;
}

export interface RuntimeToolRoundResult {
  messages: ModelMessage[];
  receiptIds: string[];
}

export class RuntimeToolLoop {
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #identity: RuntimeEventIdentity;
  readonly #permissions: RuntimePermissionBroker;
  readonly #coordinator: ToolExecutionCoordinator;
  readonly #executionStore?: ToolExecutionStore;

  constructor(options: RuntimeToolLoopOptions) {
    this.#eventLog = options.eventLog;
    this.#identity = options.identity;
    this.#permissions = new RuntimePermissionBroker({
      createPermissionId: options.createPermissionId,
      onRequested: (permission) => {
        this.#eventLog.append(this.#identity, {
          kind: "permission_requested",
          payload: {
            permissionId: permission.permissionId,
            toolCallId: permission.toolCallId,
            reason: permission.reason,
            actions: permission.actions,
            resources: permission.resources,
          },
        });
      },
      onAnswered: (answer) => this.#appendPermissionAnswer(answer),
      onCancelled: (permission) => {
        this.#eventLog.append(this.#identity, {
          kind: "permission_cancelled",
          payload: permission,
        });
      },
    });
    this.#coordinator = new ToolExecutionCoordinator({
      registry: options.registry,
      permissions: this.#permissions,
      observer: {
        running: (toolCall, executionIdentity) => {
          this.#eventLog.append(this.#identity, {
            kind: "tool_running",
            payload: toolIdentity(toolCall, executionIdentity),
          });
        },
      },
      existingReceiptIds: options.existingReceiptIds,
    });
    this.#executionStore = options.executionStore;
  }

  hasPendingPermission(permissionId: string): boolean {
    return this.#permissions.pendingIds().includes(permissionId);
  }

  answerPermission(answer: RuntimePermissionAnswer): RuntimePermissionAnswer {
    return this.#permissions.answer(answer);
  }

  async execute(
    toolCalls: ToolCall[],
    input: {
      round: number;
      assistantMessageId: string;
      signal?: AbortSignal;
    },
  ): Promise<RuntimeToolRoundResult> {
    toolCalls.forEach((toolCall, ordinal) => {
      this.#eventLog.append(this.#identity, {
        kind: "tool_queued",
        payload: toolIdentity(toolCall, this.#executionIdentity(input, ordinal)),
      });
    });
    const messages: ModelMessage[] = [];
    const receiptIds: string[] = [];
    for (const [ordinal, toolCall] of toolCalls.entries()) {
      const executionIdentity = this.#executionIdentity(input, ordinal);
      const outcome = await this.#coordinator.execute(
        toolCall,
        executionIdentity,
        input.signal,
      );
      this.#executionStore?.record(toolCall, executionIdentity, outcome);
      this.#appendToolOutcome(toolCall, executionIdentity, outcome);
      receiptIds.push(...outcome.result.facts.map((fact) => fact.receipt_id));
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify(outcome.result),
      });
    }
    return { messages, receiptIds };
  }

  #executionIdentity(
    input: { round: number; assistantMessageId: string },
    ordinal: number,
  ): ToolExecutionIdentity {
    return {
      ...this.#identity,
      round: input.round,
      ordinal,
      assistantMessageId: input.assistantMessageId,
    };
  }

  #appendPermissionAnswer(
    answer: RuntimePermissionAnswer & { toolCallId: string },
  ): RuntimeEvent {
    if (answer.decision === "deny") {
      return this.#eventLog.append(this.#identity, {
        kind: "permission_rejected",
        payload: {
          permissionId: answer.permissionId,
          toolCallId: answer.toolCallId,
          reason: "user_rejected",
        },
      });
    }
    if (answer.decision === "cancel") {
      return this.#eventLog.append(this.#identity, {
        kind: "permission_cancelled",
        payload: {
          permissionId: answer.permissionId,
          toolCallId: answer.toolCallId,
          reason: "user_cancelled",
        },
      });
    }
    return this.#eventLog.append(this.#identity, {
      kind: "permission_answered",
      payload: {
        permissionId: answer.permissionId,
        toolCallId: answer.toolCallId,
        answerId: answer.answerId,
        grantedCapabilityIds: answer.grantedCapabilityIds,
      },
    });
  }

  #appendToolOutcome(
    toolCall: ToolCall,
    executionIdentity: ToolExecutionIdentity,
    outcome: ToolExecutionOutcome,
  ): RuntimeEvent {
    const payload = toolIdentity(toolCall, executionIdentity);
    if (outcome.kind === "cancelled") {
      return this.#eventLog.append(this.#identity, {
        kind: "tool_cancelled",
        payload: { ...payload, reason: outcome.reason },
      });
    }
    const references = factReferences(outcome.result);
    if (outcome.kind === "completed") {
      return this.#eventLog.append(this.#identity, {
        kind: "tool_completed",
        payload: { ...payload, ...references },
      });
    }
    const error = outcome.result.error ?? {
      code: "tool_execution_failed",
      message: "Tool execution failed without an error description.",
      details: {},
    };
    return this.#eventLog.append(this.#identity, {
      kind: "tool_failed",
      payload: {
        ...payload,
        ...references,
        error: { ...error, details: error.details ?? {} },
      },
    });
  }
}

function toolIdentity(
  toolCall: ToolCall,
  identity: ToolExecutionIdentity,
): {
  toolCallId: string;
  toolName: string;
  ordinal: number;
  assistantMessageId?: string;
} {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    ordinal: identity.ordinal,
    assistantMessageId: identity.assistantMessageId,
  };
}

function factReferences(result: ToolResult): {
  receiptIds: string[];
  executionFactIds: string[];
  artifactIds: string[];
  workspaceChangeIds: string[];
} {
  const receiptIds = result.facts.map((fact) => fact.receipt_id);
  return {
    receiptIds,
    executionFactIds: [...receiptIds],
    artifactIds: result.artifacts.map((artifact) => artifact.artifact_id),
    workspaceChangeIds: result.workspace_changes.map((change) => change.change_id),
  };
}
