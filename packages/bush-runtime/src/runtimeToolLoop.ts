import {
  type ModelMessage,
  type ModelRequest,
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
  type RuntimeCapabilityStore,
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
  capabilities?: RuntimeCapabilityStore;
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
  readonly #registry: ToolRegistry;

  constructor(options: RuntimeToolLoopOptions) {
    this.#eventLog = options.eventLog;
    this.#identity = options.identity;
    this.#registry = options.registry;
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
            requestedCapabilityIds: permission.capabilityIds,
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
      capabilities: options.capabilities,
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
      request?: ModelRequest;
      contextMessages?: ModelMessage[];
    },
  ): Promise<RuntimeToolRoundResult> {
    toolCalls.forEach((toolCall, ordinal) => {
      this.#eventLog.append(this.#identity, {
        kind: "tool_queued",
        payload: toolIdentity(toolCall, this.#executionIdentity(input, ordinal)),
      });
    });
    const toolMessages: ModelMessage[] = [];
    const guidanceMessages: ModelMessage[] = [];
    const receiptIds: string[] = [];
    const executeOne = async (toolCall: ToolCall, ordinal: number) => {
      const executionIdentity = this.#executionIdentity(input, ordinal);
      const outcome = await this.#coordinator.execute(
        toolCall,
        executionIdentity,
        input.signal,
        input.request && input.contextMessages
          ? { request: input.request, contextMessages: input.contextMessages }
          : undefined,
      );
      this.#executionStore?.record(toolCall, executionIdentity, outcome);
      this.#appendToolOutcome(toolCall, executionIdentity, outcome);
      return outcome;
    };
    const outcomes = toolCalls.every((toolCall) =>
      this.#registry.isParallelSafe(toolCall.name),
    )
      ? await Promise.all(toolCalls.map(executeOne))
      : await sequential(toolCalls, executeOne);
    for (const [ordinal, outcome] of outcomes.entries()) {
      const toolCall = toolCalls[ordinal]!;
      receiptIds.push(...outcome.result.facts.map((fact) => fact.receipt_id));
      toolMessages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: JSON.stringify(projectToolResult(
          { ...outcome.result, guidance: [] },
          this.#identity.sessionId,
          this.#identity.turnId,
          toolCall.id,
        )),
      });
      guidanceMessages.push(...outcome.result.guidance);
    }
    const imageFollowup = toolImageFollowup(outcomes.map((outcome) => outcome.result));
    return {
      messages: [...toolMessages, ...(imageFollowup ? [imageFollowup] : []), ...guidanceMessages],
      receiptIds,
    };
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

function projectToolResult(
  result: ToolResult,
  sessionId: string,
  turnId: string,
  toolCallId: string,
  maxChars = 16_000,
): ToolResult {
  const serialized = JSON.stringify(result);
  if (serialized.length <= maxChars) return result;
  const locator = `tool-result://${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/${encodeURIComponent(toolCallId)}`;
  return {
    ...result,
    output: {
      archived: true,
      locator,
      originalChars: serialized.length,
      preview: JSON.stringify(result.output).slice(0, Math.max(2_000, maxChars - 6_000)),
      note: "The complete authoritative Tool result is archived. Use ked_read_temp_object with the locator for exact excerpts.",
    },
  };
}

function toolImageFollowup(results: ToolResult[]): ModelMessage | undefined {
  const images = results.flatMap((result) => result.artifacts)
    .filter((artifact) =>
      artifact.type === "image" &&
      artifact.metadata?.model_input === true &&
      (
        typeof artifact.path === "string" && artifact.path.trim().length > 0 ||
        typeof artifact.uri === "string" && artifact.uri.trim().length > 0
      ),
    )
    .slice(0, 4)
    .map((artifact): { url: string; detail?: "auto" | "low" | "high" } => {
      const detail = artifact.metadata?.detail;
      return {
        url: artifact.path ?? artifact.uri!,
        ...(detail === "low" || detail === "high" ? { detail } : {}),
      };
    });
  if (!images.length) return undefined;
  return {
    role: "user",
    name: "tool_image_observation",
    content: [
      "Visual observations produced by the preceding Tool are attached.",
      "Inspect their pixels before making visual claims or deciding the next visual action.",
    ].join(" "),
    images,
  };
}

async function sequential<TInput, TOutput>(
  values: TInput[],
  execute: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output: TOutput[] = [];
  for (const [index, value] of values.entries()) {
    output.push(await execute(value, index));
  }
  return output;
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
