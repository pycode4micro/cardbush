import {
  BUSH_ACTION_MANIFEST_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  toolResultSchema,
  type ActionManifest,
  type RuntimePermissionAnswer,
  type ToolCall,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { PermissionResolver, ToolRegistry } from "./toolRegistry.js";

export interface ToolExecutionIdentity {
  requestId: string;
  sessionId: string;
  turnId: string;
  round: number;
  ordinal: number;
  assistantMessageId?: string;
}

export interface ToolExecutionObserver {
  running?: (toolCall: ToolCall, identity: ToolExecutionIdentity) => void;
}

export type ToolExecutionOutcome =
  | {
      kind: "completed" | "failed";
      result: ToolResult;
      actionManifest?: ActionManifest;
    }
  | {
      kind: "cancelled";
      reason: string;
      result: ToolResult;
      actionManifest?: ActionManifest;
    };

export interface ToolExecutionCoordinatorOptions {
  registry: ToolRegistry;
  permissions: PermissionResolver;
  observer?: ToolExecutionObserver;
  existingReceiptIds?: string[];
}

export class ToolExecutionCoordinator {
  readonly #registry: ToolRegistry;
  readonly #permissions: PermissionResolver;
  readonly #observer: ToolExecutionObserver;
  readonly #receiptIds: Set<string>;

  constructor(options: ToolExecutionCoordinatorOptions) {
    this.#registry = options.registry;
    this.#permissions = options.permissions;
    this.#observer = options.observer ?? {};
    this.#receiptIds = new Set(options.existingReceiptIds ?? []);
  }

  async execute(
    toolCall: ToolCall,
    identity: ToolExecutionIdentity,
    signal?: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const registration = this.#registry.resolve(toolCall.name);
    if (!registration) {
      return failedResult(
        toolCall.id,
        "tool_not_registered",
        `Tool ${toolCall.name} is not registered in this Runtime host.`,
      );
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(toolCall.argumentsText);
    } catch (error) {
      return failedResult(
        toolCall.id,
        "tool_arguments_invalid_json",
        error instanceof Error ? error.message : String(error),
      );
    }

    let input: unknown;
    try {
      input = registration.decodeInput(parsedArguments);
    } catch (error) {
      return failedResult(
        toolCall.id,
        "tool_arguments_schema_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }

    const actionManifest: ActionManifest = {
      protocol: BUSH_ACTION_MANIFEST_PROTOCOL,
      manifest_id: manifestId(identity, toolCall.id),
      ...registration.manifest,
    };
    let capabilityIds: string[] = [];
    if (registration.authorize) {
      let admission;
      try {
        admission = await registration.authorize({
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          toolCall,
          input,
          actionManifest,
          signal,
        });
      } catch (error) {
        return failedResult(
          toolCall.id,
          "tool_admission_exception",
          error instanceof Error ? error.message : String(error),
          actionManifest,
        );
      }
      if (admission.kind === "deny") {
        return failedResult(
          toolCall.id,
          admission.code,
          admission.message,
          actionManifest,
          admission.details,
        );
      }
      if (admission.kind === "ask") {
        let answer: RuntimePermissionAnswer;
        try {
          answer = await this.#permissions.request(
            { ...admission.request, toolCallId: toolCall.id },
            signal,
          );
        } catch (error) {
          if (isAbortError(error)) {
            return cancelledResult(
              toolCall.id,
              "permission_request_cancelled",
              actionManifest,
            );
          }
          return failedResult(
            toolCall.id,
            "permission_request_failed",
            error instanceof Error ? error.message : String(error),
            actionManifest,
          );
        }
        if (answer.decision === "deny") {
          return failedResult(
            toolCall.id,
            "permission_rejected",
            "The requested permission was rejected.",
            actionManifest,
          );
        }
        if (answer.decision === "cancel") {
          return cancelledResult(
            toolCall.id,
            "permission_request_cancelled",
            actionManifest,
          );
        }
        capabilityIds = [...answer.grantedCapabilityIds];
      } else {
        capabilityIds = [...(admission.capabilityIds ?? [])];
      }
    }

    if (signal?.aborted) {
      return cancelledResult(toolCall.id, "turn_cancelled", actionManifest);
    }
    this.#observer.running?.(toolCall, identity);
    let candidate: ToolResult;
    try {
      candidate = toolResultSchema.parse(
        await registration.execute({
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          toolCall,
          input,
          actionManifest,
          capabilityIds,
          signal,
        }),
      );
    } catch (error) {
      if (isAbortError(error)) {
        return cancelledResult(toolCall.id, "tool_execution_cancelled", actionManifest);
      }
      return failedResult(
        toolCall.id,
        "tool_execution_exception",
        error instanceof Error ? error.message : String(error),
        actionManifest,
      );
    }

    try {
      assertJsonValue(candidate);
    } catch (error) {
      return failedResult(
        toolCall.id,
        "tool_result_not_json_serializable",
        error instanceof Error ? error.message : String(error),
        actionManifest,
      );
    }

    const protocolError = this.#validateResult(candidate, toolCall, actionManifest);
    if (protocolError) {
      return failedResult(
        toolCall.id,
        protocolError.code,
        protocolError.message,
        actionManifest,
      );
    }
    candidate.facts.forEach((fact) => this.#receiptIds.add(fact.receipt_id));
    return {
      kind: candidate.success ? "completed" : "failed",
      result: candidate,
      actionManifest,
    };
  }

  #validateResult(
    result: ToolResult,
    toolCall: ToolCall,
    manifest: ActionManifest,
  ): { code: string; message: string } | undefined {
    if (result.tool_call_id !== toolCall.id) {
      return {
        code: "tool_result_identity_mismatch",
        message: `Tool result belongs to ${result.tool_call_id}, expected ${toolCall.id}.`,
      };
    }
    if (result.facts.length === 0) {
      return {
        code: "execution_fact_missing",
        message: "Executed tools must return at least one Execution Fact.",
      };
    }
    const localIds = new Set<string>();
    for (const fact of result.facts) {
      if (fact.action_manifest_id !== manifest.manifest_id) {
        return {
          code: "execution_fact_manifest_mismatch",
          message: `Execution Fact ${fact.receipt_id} does not reference the admitted Action Manifest.`,
        };
      }
      if (localIds.has(fact.receipt_id) || this.#receiptIds.has(fact.receipt_id)) {
        return {
          code: "execution_fact_identity_conflict",
          message: `Execution Fact receipt ${fact.receipt_id} is not unique in this Turn.`,
        };
      }
      localIds.add(fact.receipt_id);
    }
    return undefined;
  }
}

function manifestId(identity: ToolExecutionIdentity, toolCallId: string): string {
  return `attempt:${identity.turnId}:${identity.round}:${toolCallId}`;
}

function failedResult(
  toolCallId: string,
  code: string,
  message: string,
  actionManifest?: ActionManifest,
  details: Record<string, unknown> = {},
): ToolExecutionOutcome {
  return {
    kind: "failed",
    actionManifest,
    result: {
      protocol: BUSH_TOOL_RESULT_PROTOCOL,
      tool_call_id: toolCallId,
      success: false,
      output: null,
      facts: [],
      error: { code, message, details },
    },
  };
}

function cancelledResult(
  toolCallId: string,
  reason: string,
  actionManifest?: ActionManifest,
): ToolExecutionOutcome {
  return {
    kind: "cancelled",
    reason,
    actionManifest,
    result: {
      protocol: BUSH_TOOL_RESULT_PROTOCOL,
      tool_call_id: toolCallId,
      success: false,
      output: null,
      facts: [],
      error: { code: reason, message: "Tool execution was cancelled.", details: {} },
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertJsonValue(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool results require finite numbers.");
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Tool results cannot contain ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw new Error("Tool results cannot contain cycles.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertJsonValue(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Tool results must contain only plain JSON objects.");
    }
    Object.values(value as Record<string, unknown>).forEach((item) =>
      assertJsonValue(item, ancestors),
    );
  }
  ancestors.delete(value);
}
