import {
  BUSH_ACTION_MANIFEST_PROTOCOL,
  type ActionManifest,
  type RuntimePermissionAnswer,
  type ToolCall,
  type ToolErrorKind,
  type RuntimeToolError,
  type WorkspaceChange,
} from "@cardbush/bush-protocol";

import type { PermissionResolver, ToolRegistry } from "./toolRegistry.js";
import type { ToolHandlerContext } from "./toolRegistry.js";
import { BUSH_TOOL_CALL_PROTOCOL } from "@cardbush/bush-protocol";
import { settleAtAbort } from "./abortSettlement.js";

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
      kind: "returned";
      result: unknown;
      workspaceChanges: WorkspaceChange[];
      actionManifest?: ActionManifest;
    }
  | {
      kind: "failed" | "cancelled";
      error: RuntimeToolError;
      workspaceChanges: WorkspaceChange[];
      actionManifest?: ActionManifest;
    };

export interface ToolExecutionCoordinatorOptions {
  registry: ToolRegistry;
  permissions: PermissionResolver;
  observer?: ToolExecutionObserver;
  capabilities?: RuntimeCapabilityStore;
  capabilitySessionId?: string;
}

export interface RuntimeCapabilityStore {
  hasAll(sessionId: string, capabilityIds: string[]): boolean;
  grant(sessionId: string, capabilityIds: string[]): void;
}

export class ToolExecutionCoordinator {
  readonly #registry: ToolRegistry;
  readonly #permissions: PermissionResolver;
  readonly #observer: ToolExecutionObserver;
  readonly #capabilities?: RuntimeCapabilityStore;
  readonly #capabilitySessionId?: string;

  constructor(options: ToolExecutionCoordinatorOptions) {
    this.#registry = options.registry;
    this.#permissions = options.permissions;
    this.#observer = options.observer ?? {};
    this.#capabilities = options.capabilities;
    this.#capabilitySessionId = options.capabilitySessionId?.trim() || undefined;
  }

  async execute(
    toolCall: ToolCall,
    identity: ToolExecutionIdentity,
    signal?: AbortSignal,
    turn?: ToolHandlerContext["turn"],
  ): Promise<ToolExecutionOutcome> {
    if (
      turn &&
      !turn.request.tools.some((definition) => definition.name === toolCall.name)
    ) {
      return failedResult(
        "tool_not_exposed",
        `Tool ${toolCall.name} is not exposed to this Turn.`,
      );
    }
    const registration = this.#registry.resolve(toolCall.name);
    if (!registration) {
      return failedResult(
        "tool_not_registered",
        `Tool ${toolCall.name} is not registered in this Runtime host.`,
      );
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(toolCall.argumentsText);
    } catch (error) {
      return failedResult(
        "tool_arguments_invalid_json",
        errorMessage(error),
        undefined,
        {},
        "protocol",
      );
    }

    let input: unknown;
    try {
      input = registration.decodeInput(parsedArguments);
    } catch (error) {
      return failedResult(
        "tool_arguments_schema_invalid",
        errorMessage(error),
        undefined,
        {},
        "protocol",
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
        admission = await settleAtAbort(
          Promise.resolve(registration.authorize({
            requestId: identity.requestId,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            toolCall,
            input,
            actionManifest,
            signal,
            turn,
          })),
          signal,
          "Tool admission was cancelled.",
        );
      } catch (error) {
        if (isAbortError(error)) {
          return cancelledResult("tool_admission_cancelled", actionManifest);
        }
        return failedResult(
          errorCode(error, "tool_admission_exception"),
          errorMessage(error),
          actionManifest,
          errorDetails(error),
          errorCode(error, "") ? "tool" : "runtime",
        );
      }
      if (admission.kind === "deny") {
        return failedResult(
          admission.code,
          admission.message,
          actionManifest,
          admission.details,
          "permission",
        );
      }
      if (admission.kind === "ask") {
        const fullControl = turn?.request.permissionMode === "all_free";
        const capabilitySessionId = this.#capabilitySessionId ?? identity.sessionId;
        if (fullControl) {
          capabilityIds = [...admission.request.capabilityIds];
        } else if (this.#capabilities?.hasAll(capabilitySessionId, admission.request.capabilityIds)) {
          capabilityIds = [...admission.request.capabilityIds];
        } else {
          let answer: RuntimePermissionAnswer;
          try {
            answer = await this.#permissions.request(
              { ...admission.request, toolCallId: toolCall.id },
              signal,
            );
          } catch (error) {
            if (isAbortError(error)) {
              return cancelledResult(
                "permission_request_cancelled",
                actionManifest,
              );
            }
            return failedResult(
              "permission_request_failed",
              errorMessage(error),
              actionManifest,
              {},
              "permission",
            );
          }
          if (answer.decision === "deny") {
            return failedResult(
              "permission_rejected",
              "The requested permission was rejected.",
              actionManifest,
              {},
              "permission",
            );
          }
          if (answer.decision === "cancel") {
            return cancelledResult(
              "permission_request_cancelled",
              actionManifest,
            );
          }
          capabilityIds = [...answer.grantedCapabilityIds];
          if (answer.decision === "allow_session") {
            this.#capabilities?.grant(capabilitySessionId, capabilityIds);
          }
        }
      } else {
        capabilityIds = [...(admission.capabilityIds ?? [])];
      }
    }

    if (signal?.aborted) {
      return cancelledResult("turn_cancelled", actionManifest);
    }
    this.#observer.running?.(toolCall, identity);
    let nativeResult: unknown;
    const workspaceChanges: WorkspaceChange[] = [];
    try {
      let nestedOrdinal = 0;
      nativeResult = await settleAtAbort(
        Promise.resolve(registration.execute({
          requestId: identity.requestId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          toolCall,
          input,
          actionManifest,
          capabilityIds,
          signal,
          turn,
          invokeTool: async (name, input) => {
            const nested = await this.execute({
              protocol: BUSH_TOOL_CALL_PROTOCOL,
              id: `${toolCall.id}:child:${nestedOrdinal}`,
              name,
              argumentsText: JSON.stringify(input),
            }, {
              ...identity,
              ordinal: identity.ordinal * 1000 + (++nestedOrdinal),
            }, signal, turn);
            if (nested.kind === "returned") return nested.result;
            throw Object.assign(new Error(nested.error.message), {
              code: nested.error.code,
              details: nested.error.details,
            });
          },
          recordWorkspaceChange: (change) => workspaceChanges.push(change),
        })),
        signal,
        "Tool execution was cancelled.",
      );
    } catch (error) {
      if (isAbortError(error)) {
        return cancelledResult("tool_execution_cancelled", actionManifest);
      }
      return failedResult(
        errorCode(error, "tool_execution_exception"),
        errorMessage(error),
        actionManifest,
        errorDetails(error),
        "tool",
      );
    }

    let stableResult: unknown;
    let stableWorkspaceChanges: WorkspaceChange[];
    try {
      stableResult = snapshotJsonValue(nativeResult);
      stableWorkspaceChanges = workspaceChanges.map(
        (change) => snapshotJsonValue(change) as WorkspaceChange,
      );
    } catch (error) {
      return failedResult(
        "tool_native_result_not_json_serializable",
        errorMessage(error),
        actionManifest,
        {},
        "protocol",
      );
    }

    return {
      kind: "returned",
      result: stableResult,
      workspaceChanges: stableWorkspaceChanges,
      actionManifest,
    };
  }
}

function manifestId(identity: ToolExecutionIdentity, toolCallId: string): string {
  return `attempt:${identity.turnId}:${identity.round}:${toolCallId}`;
}

function failedResult(
  code: string,
  message: string,
  actionManifest?: ActionManifest,
  details: Record<string, unknown> = {},
  kind: ToolErrorKind = "runtime",
): ToolExecutionOutcome {
  const error = runtimeError(kind, code, message, details);
  return {
    kind: "failed",
    actionManifest,
    workspaceChanges: [],
    error,
  };
}

function cancelledResult(
  reason: string,
  actionManifest?: ActionManifest,
): ToolExecutionOutcome {
  return {
    kind: "cancelled",
    actionManifest,
    workspaceChanges: [],
    error: runtimeError("cancelled", reason, "Tool execution was cancelled.", {}),
  };
}

function runtimeError(
  kind: ToolErrorKind,
  code: string,
  message: string,
  details: Record<string, unknown>,
): RuntimeToolError {
  let stableDetails: Record<string, unknown>;
  try {
    stableDetails = snapshotJsonValue(details) as Record<string, unknown>;
  } catch (error) {
    stableDetails = {
      detailsSerializationError: errorMessage(error),
    };
  }
  return { kind, code, message, details: stableDetails };
}

function errorCode(error: unknown, fallback: string): string {
  try {
    if (error && typeof error === "object" && "code" in error) {
      const candidate = String(Reflect.get(error, "code") ?? "").trim();
      if (candidate) return candidate;
    }
  } catch {
    // A thrown value is untrusted. Fall back to the Runtime-owned code.
  }
  return fallback;
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const details: Record<string, unknown> = {};
  try {
    const declared = Reflect.get(error, "details");
    if (declared && typeof declared === "object" && !Array.isArray(declared)) {
      Object.assign(details, snapshotJsonValue(declared));
    }
  } catch (cause) {
    details.detailsSerializationError = errorMessage(cause);
  }
  for (const key of ["name", "path", "syscall"] as const) {
    try {
      const value = Reflect.get(error, key);
      if (typeof value === "string") details[key] = value;
    } catch {
      // Ignore hostile accessors on thrown values.
    }
  }
  return details;
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message;
    return String(error);
  } catch {
    return "Unknown Tool error.";
  }
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
    if (Object.is(value, -0)) throw new Error("Tool results cannot contain negative zero.");
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Tool results cannot contain ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw new Error("Tool results cannot contain cycles.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new Error("Tool result arrays cannot contain symbol properties.");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("Tool result arrays cannot contain sparse entries.");
      }
      assertJsonDataProperty(value, String(index), ancestors);
    }
    if (keys.some((key) => key !== "length" && !isCanonicalArrayIndex(key, value.length))) {
      throw new Error("Tool result arrays cannot contain custom properties.");
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Tool results must contain only plain JSON objects.");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new Error("Tool result objects cannot contain symbol properties.");
      }
      assertJsonDataProperty(value, key, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertJsonDataProperty(
  owner: object,
  key: string,
  ancestors: Set<object>,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Tool results require enumerable data properties.");
  }
  assertJsonValue(descriptor.value, ancestors);
}

function isCanonicalArrayIndex(key: string | symbol, length: number): boolean {
  if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function snapshotJsonValue(value: unknown): unknown {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}
