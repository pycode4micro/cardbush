import {
  type ModelMessage,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
  type ToolCall,
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
import { ModelImageInputError, ModelImageStore } from "./modelImageStore.js";

export interface RuntimeToolLoopOptions {
  eventLog: InMemoryRuntimeEventLog;
  identity: RuntimeEventIdentity;
  registry: ToolRegistry;
  createPermissionId?: () => string;
  executionStore?: ToolExecutionStore;
  modelImages?: ModelImageStore;
  capabilities?: RuntimeCapabilityStore;
  capabilitySessionId?: string;
  permissionEventIdentity?: RuntimeEventIdentity;
  permissionSource?: {
    sourceSessionId: string;
    sourceTurnId: string;
    parentSessionId: string;
    parentTurnId: string;
    subagentTaskId?: string;
    permissionRouting: "user" | "parent";
  };
}

export interface RuntimeToolRoundResult {
  messages: ModelMessage[];
}

const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000;
const TOOL_MESSAGE_OVERHEAD_TOKENS = 64;
const MODEL_IMAGE_INPUT_ESTIMATED_TOKENS = 1_024;

export class RuntimeToolLoop {
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #identity: RuntimeEventIdentity;
  readonly #permissions: RuntimePermissionBroker;
  readonly #coordinator: ToolExecutionCoordinator;
  readonly #executionStore?: ToolExecutionStore;
  readonly #registry: ToolRegistry;
  readonly #modelImages: ModelImageStore;
  readonly #permissionEventIdentity: RuntimeEventIdentity;
  readonly #permissionSource?: RuntimeToolLoopOptions["permissionSource"];
  readonly #activeToolControllers = new Map<
    string,
    { controller: AbortController; toolName: string }
  >();

  constructor(options: RuntimeToolLoopOptions) {
    this.#eventLog = options.eventLog;
    this.#identity = options.identity;
    this.#registry = options.registry;
    this.#modelImages = options.modelImages ?? new ModelImageStore();
    this.#permissionEventIdentity = options.permissionEventIdentity ?? options.identity;
    this.#permissionSource = options.permissionSource;
    this.#permissions = new RuntimePermissionBroker({
      createPermissionId: options.createPermissionId,
      onRequested: (permission) => {
        this.#cancelActiveDesktopControls(permission.toolCallId);
        this.#eventLog.append(this.#permissionEventIdentity, {
          kind: "permission_requested",
          payload: {
            permissionId: permission.permissionId,
            toolCallId: permission.toolCallId,
            reason: permission.reason,
            actions: permission.actions,
            targets: permission.targets,
            requestedCapabilityIds: permission.capabilityIds,
            scope: permission.scope,
            ...this.#permissionSource,
          },
        });
      },
      onAnswered: (answer) => this.#appendPermissionAnswer(answer),
      onCancelled: (permission) => {
        this.#eventLog.append(this.#permissionEventIdentity, {
          kind: "permission_cancelled",
          payload: { ...permission, ...this.#permissionSource },
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
          if (
            this.#permissions.pendingIds().length > 0 &&
            this.#registry.resolve(toolCall.name)?.manifest.effect_kind === "desktop_control"
          ) {
            this.cancelTool(toolCall.id);
          }
        },
      },
      capabilities: options.capabilities,
      capabilitySessionId: options.capabilitySessionId,
    });
    this.#executionStore = options.executionStore;
  }

  hasPendingPermission(permissionId: string): boolean {
    return this.#permissions.pendingIds().includes(permissionId);
  }

  answerPermission(answer: RuntimePermissionAnswer): RuntimePermissionAnswer {
    return this.#permissions.answer(answer);
  }

  matches(sessionId: string, turnId: string): boolean {
    return this.#identity.sessionId === sessionId && this.#identity.turnId === turnId;
  }

  cancelTool(toolCallId: string): boolean {
    const active = this.#activeToolControllers.get(toolCallId);
    if (!active || active.controller.signal.aborted) return false;
    active.controller.abort(new DOMException("Tool control was cancelled.", "AbortError"));
    return true;
  }

  #cancelActiveDesktopControls(excludedToolCallId: string): void {
    for (const [toolCallId, active] of this.#activeToolControllers) {
      if (toolCallId === excludedToolCallId) continue;
      if (this.#registry.resolve(active.toolName)?.manifest.effect_kind !== "desktop_control") {
        continue;
      }
      this.cancelTool(toolCallId);
    }
  }

  async execute(
    toolCalls: ToolCall[],
    input: {
      round: number;
      assistantMessageId: string;
      signal?: AbortSignal;
      request?: ModelRequest;
      contextMessages?: ModelMessage[];
      modelContextIngressBudgetTokens?: number;
    },
  ): Promise<RuntimeToolRoundResult> {
    toolCalls.forEach((toolCall, ordinal) => {
      this.#eventLog.append(this.#identity, {
        kind: "tool_queued",
        payload: toolIdentity(toolCall, this.#executionIdentity(input, ordinal)),
      });
    });
    const toolMessages: ModelMessage[] = [];
    const imageObservations: ToolImageObservation[][] = [];
    const executeOne = async (toolCall: ToolCall, ordinal: number) => {
      const executionIdentity = this.#executionIdentity(input, ordinal);
      const controller = new AbortController();
      const detachAbort = forwardAbort(input.signal, controller);
      if (this.#activeToolControllers.has(toolCall.id)) {
        detachAbort();
        throw new Error(`Tool call ${toolCall.id} is already active.`);
      }
      this.#activeToolControllers.set(toolCall.id, {
        controller,
        toolName: toolCall.name,
      });
      if (this.#hasConcurrentPermissionAdmission(toolCall, toolCalls)) {
        controller.abort(new DOMException(
          "Desktop control was deferred because another concurrent Tool may request permission.",
          "AbortError",
        ));
      }
      try {
        const outcome = await this.#coordinator.execute(
          toolCall,
          executionIdentity,
          controller.signal,
          input.request && input.contextMessages
            ? { request: input.request, contextMessages: input.contextMessages }
            : undefined,
        );
        // Snapshot before the next sequential Tool can remove or overwrite the source.
        // Keep the native Tool outcome untouched: image delivery is a separate observation.
        imageObservations[ordinal] = outcome.kind === "returned"
          ? await snapshotToolImages(outcome.result, toolCall.id, this.#modelImages, controller.signal)
          : [];
        this.#executionStore?.record(toolCall, executionIdentity, outcome);
        this.#appendToolOutcome(toolCall, executionIdentity, outcome);
        return outcome;
      } finally {
        this.#activeToolControllers.delete(toolCall.id);
        detachAbort();
      }
    };
    const outcomes = await executeByChannel(
      toolCalls,
      executeOne,
      (toolCall) => this.#registry.executionChannel(toolCall.name),
      (toolCall) => this.#registry.isParallelSafe(toolCall.name),
    );
    const nativeResults = outcomes.map((outcome) =>
      outcome.kind === "returned" ? outcome.result : { runtimeError: outcome.error }
    );
    const modelResults = nativeResults.map((result, ordinal) =>
      modelFacingNativeToolResult(result, toolCalls[ordinal]!.name)
    );
    const ingressBudget = Number.isInteger(input.modelContextIngressBudgetTokens) &&
        Number(input.modelContextIngressBudgetTokens) >= 0
      ? Number(input.modelContextIngressBudgetTokens)
      : undefined;
    const minimumResultChars = modelResults.reduce<number>((total, result, ordinal) =>
      total + serializeNativeToolResult(projectNativeToolResult(
        result,
        this.#identity.sessionId,
        this.#identity.turnId,
        toolCalls[ordinal]!.id,
        0,
      )).length, 0);
    const imageCandidateCount = nativeResults.flatMap(nativeImageArtifacts)
      .filter(isModelInputImageArtifact)
      .slice(0, 4)
      .length;
    const structuralTokenReserve = toolCalls.length * TOOL_MESSAGE_OVERHEAD_TOKENS;
    const availablePayloadTokens = ingressBudget === undefined
      ? undefined
      : Math.max(0, ingressBudget - structuralTokenReserve);
    const maxModelImages = availablePayloadTokens === undefined
      ? 4
      : Math.min(
          imageCandidateCount,
          Math.floor(
            Math.max(0, availablePayloadTokens - minimumResultChars) /
              MODEL_IMAGE_INPUT_ESTIMATED_TOKENS,
          ),
        );
    const maxTotalResultChars = availablePayloadTokens === undefined
      ? undefined
      : Math.max(
          minimumResultChars,
          availablePayloadTokens - maxModelImages * MODEL_IMAGE_INPUT_ESTIMATED_TOKENS,
        );
    const projectedResults = projectNativeToolResults(
      modelResults,
      toolCalls,
      this.#identity.sessionId,
      this.#identity.turnId,
      maxTotalResultChars,
    );
    for (const [ordinal, projectedResult] of projectedResults.entries()) {
      const toolCall = toolCalls[ordinal]!;
      toolMessages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: serializeNativeToolResult(projectedResult),
      });
    }
    const imageFollowup = toolImageFollowup(imageObservations.flat(), maxModelImages);
    return {
      messages: [...toolMessages, ...(imageFollowup ? [imageFollowup] : [])],
    };
  }

  #hasConcurrentPermissionAdmission(toolCall: ToolCall, toolCalls: ToolCall[]): boolean {
    const registration = this.#registry.resolve(toolCall.name);
    if (registration?.manifest.effect_kind !== "desktop_control") return false;
    return toolCalls.some((candidate) => {
      if (candidate.id === toolCall.id) return false;
      const candidateRegistration = this.#registry.resolve(candidate.name);
      if (!candidateRegistration?.authorize) return false;
      const sameChannel = this.#registry.executionChannel(candidate.name) ===
        this.#registry.executionChannel(toolCall.name);
      return !sameChannel || (
        this.#registry.isParallelSafe(candidate.name) &&
        this.#registry.isParallelSafe(toolCall.name)
      );
    });
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
      return this.#eventLog.append(this.#permissionEventIdentity, {
        kind: "permission_rejected",
        payload: {
          permissionId: answer.permissionId,
          toolCallId: answer.toolCallId,
          reason: "user_rejected",
          ...this.#permissionSource,
        },
      });
    }
    if (answer.decision === "cancel") {
      return this.#eventLog.append(this.#permissionEventIdentity, {
        kind: "permission_cancelled",
        payload: {
          permissionId: answer.permissionId,
          toolCallId: answer.toolCallId,
          reason: "user_cancelled",
          ...this.#permissionSource,
        },
      });
    }
    return this.#eventLog.append(this.#permissionEventIdentity, {
      kind: "permission_answered",
      payload: {
        permissionId: answer.permissionId,
        toolCallId: answer.toolCallId,
        answerId: answer.answerId,
        grantedCapabilityIds: answer.grantedCapabilityIds,
        ...this.#permissionSource,
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
        payload: { ...payload, reason: outcome.error.code },
      });
    }
    if (outcome.kind === "returned") {
      return this.#eventLog.append(this.#identity, {
        kind: "tool_returned",
        payload,
      });
    }
    return this.#eventLog.append(this.#identity, {
      kind: "tool_failed",
      payload: {
        ...payload,
        error: outcome.error,
      },
    });
  }
}

function projectNativeToolResult(
  result: unknown,
  sessionId: string,
  turnId: string,
  toolCallId: string,
  maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS,
): unknown {
  const serialized = serializeNativeToolResult(result);
  if (serialized.length <= maxChars) return result;
  const locator = `tool-result://${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/${encodeURIComponent(toolCallId)}`;
  const receipt = {
    archived: true,
    locator,
    originalChars: serialized.length,
    preview: "",
  };
  const receiptChars = serializeNativeToolResult(receipt).length;
  if (receiptChars >= serialized.length) return result;
  if (maxChars <= receiptChars) return receipt;
  let lower = 0;
  let upper = Math.min(serialized.length, maxChars - receiptChars);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = { ...receipt, preview: serialized.slice(0, middle) };
    if (serializeNativeToolResult(candidate).length <= maxChars) lower = middle;
    else upper = middle - 1;
  }
  return { ...receipt, preview: serialized.slice(0, lower) };
}

function projectNativeToolResults(
  results: unknown[],
  toolCalls: ToolCall[],
  sessionId: string,
  turnId: string,
  maxTotalChars?: number,
): unknown[] {
  const desired = results.map((result, index) => projectNativeToolResult(
    result,
    sessionId,
    turnId,
    toolCalls[index]!.id,
  ));
  if (maxTotalChars === undefined) return desired;
  const desiredChars = desired.map((result) => serializeNativeToolResult(result).length);
  if (desiredChars.reduce((total, chars) => total + chars, 0) <= maxTotalChars) {
    return desired;
  }
  const minimum = results.map((result, index) => projectNativeToolResult(
    result,
    sessionId,
    turnId,
    toolCalls[index]!.id,
    0,
  ));
  const allocations = minimum.map((result) => serializeNativeToolResult(result).length);
  let remaining = Math.max(
    0,
    maxTotalChars - allocations.reduce((total, chars) => total + chars, 0),
  );
  while (remaining > 0) {
    const active = allocations
      .map((allocated, index) => ({ index, needed: desiredChars[index]! - allocated }))
      .filter((entry) => entry.needed > 0);
    if (active.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / active.length));
    let distributed = 0;
    for (const entry of active) {
      const added = Math.min(entry.needed, share, remaining - distributed);
      allocations[entry.index] += added;
      distributed += added;
      if (distributed >= remaining) break;
    }
    if (distributed === 0) break;
    remaining -= distributed;
  }
  return results.map((result, index) => projectNativeToolResult(
    result,
    sessionId,
    turnId,
    toolCalls[index]!.id,
    allocations[index],
  ));
}

function serializeNativeToolResult(result: unknown): string {
  return JSON.stringify(result) ?? "null";
}

function modelFacingNativeToolResult(result: unknown, toolName: string): unknown {
  if (toolName !== "inject_image_input" || !result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  // In particular, do not replace a failed injection's recoverable runtimeError with an empty receipt.
  if ((result as Record<string, unknown>).queued !== true) return result;
  const attachedImages = nativeImageArtifacts(result).filter(isModelInputImageArtifact).length;
  return {
    queued: (result as Record<string, unknown>).queued === true,
    attached_images: attachedImages,
  };
}

type ToolImageObservation = {
  image: { url: string; detail?: "low" | "high" };
} | {
  error: { toolCallId: string; code: string; message: string };
};

async function snapshotToolImages(
  result: unknown,
  toolCallId: string,
  store: ModelImageStore,
  signal: AbortSignal,
): Promise<ToolImageObservation[]> {
  const observations: ToolImageObservation[] = [];
  for (const artifact of nativeImageArtifacts(result).filter(isModelInputImageArtifact).slice(0, 4)) {
    try {
      const url = await store.snapshot(artifact.modelInputUrl ?? artifact.path ?? artifact.uri!, signal);
      const detail = artifact.detail;
      observations.push({ image: { url, ...(detail === "low" || detail === "high" ? { detail } : {}) } });
    } catch (error) {
      observations.push({ error: {
        toolCallId,
        code: error instanceof ModelImageInputError ? error.code : "image_input_unavailable",
        message: error instanceof Error ? error.message : "Tool image could not be attached. Inject a complete image file again.",
      } });
    }
  }
  return observations;
}

function toolImageFollowup(observations: ToolImageObservation[], maxImages = 4): ModelMessage | undefined {
  const selected = observations.slice(0, Math.max(0, maxImages));
  const images = selected.flatMap((item) => "image" in item ? [item.image] : []);
  const errors = selected.flatMap((item) => "error" in item ? [item.error] : []);
  if (!images.length && !errors.length) return undefined;
  return {
    role: "user",
    name: "tool_image_observation",
    visibility: "internal",
    content: JSON.stringify({ source: "tool_output", attachedImages: images.length, ...(errors.length ? { imageInputErrors: errors } : {}) }),
    ...(images.length ? { images } : {}),
  };
}

function isModelInputImageArtifact(
  artifact: ReturnType<typeof nativeImageArtifacts>[number],
): boolean {
  return artifact.type === "image" &&
    artifact.modelInput === true &&
    (
      typeof artifact.path === "string" && artifact.path.trim().length > 0 ||
      typeof artifact.uri === "string" && artifact.uri.trim().length > 0
    );
}

function nativeImageArtifacts(result: unknown): Array<{
  type: string;
  path?: string;
  uri?: string;
  modelInput?: boolean;
  modelInputUrl?: string;
  detail?: unknown;
}> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const value = result as Record<string, unknown>;
  const structured = value.structuredContent && typeof value.structuredContent === "object"
    ? value.structuredContent as Record<string, unknown>
    : value;
  if (!Array.isArray(structured.artifacts)) return [];
  return structured.artifacts.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const artifact = candidate as Record<string, unknown>;
    const metadata = artifact.metadata && typeof artifact.metadata === "object"
      ? artifact.metadata as Record<string, unknown>
      : {};
    return [{
      type: String(artifact.type ?? ""),
      ...(typeof artifact.path === "string" ? { path: artifact.path } : {}),
      ...(typeof artifact.uri === "string" ? { uri: artifact.uri } : {}),
      modelInput: metadata.model_input === true,
      ...(typeof metadata.model_input_url === "string" ? { modelInputUrl: metadata.model_input_url } : {}),
      detail: metadata.detail,
    }];
  });
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

function forwardAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function executeByChannel<TInput, TOutput>(
  values: TInput[],
  execute: (value: TInput, index: number) => Promise<TOutput>,
  channelFor: (value: TInput) => string,
  parallelSafe: (value: TInput) => boolean,
): Promise<TOutput[]> {
  const channels = new Map<string, Array<{ value: TInput; index: number }>>();
  values.forEach((value, index) => {
    const channel = channelFor(value);
    const entries = channels.get(channel) ?? [];
    entries.push({ value, index });
    channels.set(channel, entries);
  });
  const output: TOutput[] = new Array(values.length);
  await Promise.all([...channels.values()].map(async (entries) => {
    if (entries.every(({ value }) => parallelSafe(value))) {
      const results = await Promise.all(
        entries.map(({ value, index }) => execute(value, index)),
      );
      entries.forEach(({ index }, resultIndex) => {
        output[index] = results[resultIndex]!;
      });
      return;
    }
    for (const { value, index } of entries) {
      output[index] = await execute(value, index);
    }
  }));
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
