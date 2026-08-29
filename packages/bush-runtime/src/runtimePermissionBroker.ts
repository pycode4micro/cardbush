import {
  runtimePermissionAnswerSchema,
  type RuntimePermissionAnswer,
} from "@cardbush/bush-protocol";

import type {
  PermissionResolver,
  ToolPermissionRequest,
} from "./toolRegistry.js";

export interface RuntimePermissionBrokerOptions {
  createPermissionId?: () => string;
  onRequested?: (
    request: ToolPermissionRequest & {
      permissionId: string;
      toolCallId: string;
    },
  ) => void;
  onAnswered?: (answer: RuntimePermissionAnswer & { toolCallId: string }) => void;
  onCancelled?: (input: {
    permissionId: string;
    toolCallId: string;
    reason: string;
  }) => void;
}

interface PendingPermission {
  toolCallId: string;
  capabilityIds: string[];
  resolve: (answer: RuntimePermissionAnswer) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class RuntimePermissionBroker implements PermissionResolver {
  readonly #pending = new Map<string, PendingPermission>();
  readonly #createPermissionId: () => string;
  readonly #onRequested?: RuntimePermissionBrokerOptions["onRequested"];
  readonly #onAnswered?: RuntimePermissionBrokerOptions["onAnswered"];
  readonly #onCancelled?: RuntimePermissionBrokerOptions["onCancelled"];

  constructor(options: RuntimePermissionBrokerOptions = {}) {
    this.#createPermissionId =
      options.createPermissionId ?? (() => crypto.randomUUID());
    this.#onRequested = options.onRequested;
    this.#onAnswered = options.onAnswered;
    this.#onCancelled = options.onCancelled;
  }

  request(
    input: ToolPermissionRequest & { toolCallId: string },
    signal?: AbortSignal,
  ): Promise<RuntimePermissionAnswer> {
    const request = normalizeRequest(input);
    const permissionId = this.#createPermissionId();
    if (this.#pending.has(permissionId)) {
      throw new Error(`Permission ${permissionId} is already pending.`);
    }
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const pending = this.#pending.get(permissionId);
        if (!pending) return;
        this.#pending.delete(permissionId);
        pending.removeAbortListener();
        this.#onCancelled?.({
          permissionId,
          toolCallId: pending.toolCallId,
          reason: "turn_cancelled",
        });
        pending.reject(abortError());
      };
      const removeAbortListener = () =>
        signal?.removeEventListener("abort", onAbort);
      this.#pending.set(permissionId, {
        toolCallId: request.toolCallId,
        capabilityIds: request.capabilityIds,
        resolve,
        reject,
        removeAbortListener,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#onRequested?.({ ...request, permissionId });
      } catch (error) {
        this.#pending.delete(permissionId);
        removeAbortListener();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  answer(candidate: unknown): RuntimePermissionAnswer {
    const answer = runtimePermissionAnswerSchema.parse(candidate);
    const pending = this.#pending.get(answer.permissionId);
    if (!pending) {
      throw new Error(`Permission ${answer.permissionId} is not pending.`);
    }
    if (
      (answer.decision === "allow_once" || answer.decision === "allow_session") &&
      !sameSet(answer.grantedCapabilityIds, pending.capabilityIds)
    ) {
      throw new Error(
        `Permission ${answer.permissionId} must grant exactly the requested capabilities.`,
      );
    }
    this.#pending.delete(answer.permissionId);
    pending.removeAbortListener();
    pending.resolve(answer);
    this.#onAnswered?.({ ...answer, toolCallId: pending.toolCallId });
    return answer;
  }

  pendingIds(): string[] {
    return [...this.#pending.keys()];
  }
}

function abortError(): Error {
  const error = new Error("Permission request was cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeRequest(
  input: ToolPermissionRequest & { toolCallId: string },
): ToolPermissionRequest & { toolCallId: string } {
  const reason = input.reason.trim();
  const toolCallId = input.toolCallId.trim();
  const actions = uniqueNonempty(input.actions);
  const resources = uniqueNonempty(input.resources);
  const capabilityIds = uniqueNonempty(input.capabilityIds);
  if (
    !reason ||
    !toolCallId ||
    actions.length === 0 ||
    resources.length === 0 ||
    capabilityIds.length === 0
  ) {
    throw new Error(
      "Permission requests require a reason, tool call, action, and resource.",
    );
  }
  return { reason, toolCallId, actions, resources, capabilityIds };
}

function uniqueNonempty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}
