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
  requestKey: string;
  primaryToolCallId: string;
  capabilityIds: string[];
  waiters: Map<string, PermissionWaiter>;
}

interface PermissionWaiter {
  resolve: (answer: RuntimePermissionAnswer) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export class RuntimePermissionBroker implements PermissionResolver {
  readonly #pending = new Map<string, PendingPermission>();
  readonly #pendingByRequest = new Map<string, string>();
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
    const requestKey = permissionRequestKey(request);
    const existingPermissionId = this.#pendingByRequest.get(requestKey);
    if (existingPermissionId) {
      const existing = this.#pending.get(existingPermissionId);
      if (existing) {
        return this.#addWaiter(existingPermissionId, existing, request.toolCallId, signal);
      }
      this.#pendingByRequest.delete(requestKey);
    }
    const permissionId = this.#createPermissionId();
    if (this.#pending.has(permissionId)) {
      throw new Error(`Permission ${permissionId} is already pending.`);
    }
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    const pending: PendingPermission = {
      requestKey,
      primaryToolCallId: request.toolCallId,
      capabilityIds: request.capabilityIds,
      waiters: new Map(),
    };
    this.#pending.set(permissionId, pending);
    this.#pendingByRequest.set(requestKey, permissionId);
    const answer = this.#addWaiter(permissionId, pending, request.toolCallId, signal);
    try {
      this.#onRequested?.({ ...request, permissionId });
    } catch (error) {
      this.#deletePending(permissionId, pending);
      for (const waiter of pending.waiters.values()) {
        waiter.removeAbortListener();
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      pending.waiters.clear();
    }
    return answer;
  }

  #addWaiter(
    permissionId: string,
    pending: PendingPermission,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<RuntimePermissionAnswer> {
    if (pending.waiters.has(toolCallId)) {
      throw new Error(`Tool call ${toolCallId} already awaits permission ${permissionId}.`);
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const current = this.#pending.get(permissionId);
        const waiter = current?.waiters.get(toolCallId);
        if (!current || !waiter) return;
        current.waiters.delete(toolCallId);
        waiter.removeAbortListener();
        if (current.waiters.size === 0) this.#deletePending(permissionId, current);
        this.#onCancelled?.({
          permissionId,
          toolCallId,
          reason: "turn_cancelled",
        });
        waiter.reject(abortError());
      };
      const removeAbortListener = () =>
        signal?.removeEventListener("abort", onAbort);
      pending.waiters.set(toolCallId, {
        resolve,
        reject,
        removeAbortListener,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
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
    this.#deletePending(answer.permissionId, pending);
    for (const waiter of pending.waiters.values()) {
      waiter.removeAbortListener();
      waiter.resolve(answer);
    }
    pending.waiters.clear();
    this.#onAnswered?.({ ...answer, toolCallId: pending.primaryToolCallId });
    return answer;
  }

  pendingIds(): string[] {
    return [...this.#pending.keys()];
  }

  #deletePending(permissionId: string, pending: PendingPermission): void {
    this.#pending.delete(permissionId);
    if (this.#pendingByRequest.get(pending.requestKey) === permissionId) {
      this.#pendingByRequest.delete(pending.requestKey);
    }
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
  const targets = uniqueTargets(input.targets);
  const capabilityIds = uniqueNonempty(input.capabilityIds);
  if (
    !reason ||
    !toolCallId ||
    actions.length === 0 ||
    targets.length === 0 ||
    capabilityIds.length === 0
  ) {
    throw new Error(
      "Permission requests require a reason, tool call, action, target, and capability.",
    );
  }
  return {
    reason,
    toolCallId,
    actions,
    targets,
    capabilityIds,
    ...(input.scope ? {
      scope: {
        mode: input.scope.mode,
        roots: uniqueNonempty(input.scope.roots),
      },
    } : {}),
  };
}

function uniqueNonempty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item));
}

function uniqueTargets(targets: ToolPermissionRequest["targets"]): ToolPermissionRequest["targets"] {
  const result = new Map<string, ToolPermissionRequest["targets"][number]>();
  for (const target of targets) {
    const value = target.value.trim();
    if (!value) continue;
    const label = target.label?.trim();
    const normalized = { kind: target.kind, value, ...(label ? { label } : {}) };
    result.set(`${normalized.kind}\u0000${normalized.value}`, normalized);
  }
  return [...result.values()];
}

function permissionRequestKey(
  request: ToolPermissionRequest & { toolCallId: string },
): string {
  return JSON.stringify({
    reason: request.reason,
    actions: [...request.actions].sort(),
    targets: request.targets
      .map((target) => ({ ...target }))
      .sort((left, right) => `${left.kind}:${left.value}`.localeCompare(`${right.kind}:${right.value}`)),
    capabilityIds: [...request.capabilityIds].sort(),
    scope: request.scope
      ? { mode: request.scope.mode, roots: [...request.scope.roots].sort() }
      : undefined,
  });
}
