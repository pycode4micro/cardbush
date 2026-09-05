import {
  type ModelMessage,
  type ModelRequest,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import { createHash } from "node:crypto";
import type { ToolRegistry } from "./toolRegistry.js";

export const CHECKPOINT_CONTEXT_TOOL = "checkpoint_context" as const;
export const CONTEXT_COMPACTION_HARD_PRESSURE = 0.95;
export const CONTEXT_SUMMARY_FALLBACK_TURNS = 20;

const CONTEXT_MAINTENANCE_TARGET_RATIO = 0.98;
const CONTEXT_MAINTENANCE_RESERVE_MAX_TOKENS = 2_048;
const CONTEXT_MAINTENANCE_RESERVE_MIN_TOKENS = 128;
const CONTEXT_MAINTENANCE_TOOL_RESULT_MIN_CHARS = 4_096;
const CONTEXT_MAINTENANCE_TOOL_RESULT_HEAD_CHARS = 1_024;
const CONTEXT_MAINTENANCE_TOOL_RESULT_TAIL_CHARS = 512;

export interface ActiveTurnCheckpointInput {
  turnId: string;
  throughMessageId: string;
  summary: string;
}

export interface ContextCheckpointInput {
  sessionRevision: number;
  summaries: Array<{ turnId: string; summary: string }>;
  activeTurn?: ActiveTurnCheckpointInput;
}

export interface ContextCompactionState {
  revision: number;
  unsummarizedTurnIds: string[];
  totalTurns: number;
  activeTurn?: {
    turnId: string;
    throughMessageId: string;
  };
}

export interface ContextPressure {
  estimatedPromptTokens: number;
  measurement: "provider" | "fallback_estimate";
  fallbackPromptTokens: number;
  fallbackScale: number;
  reservedOutputTokens: number;
  usableInputTokens: number;
  ratio: number;
}

export interface ContextCompactionMaintenanceProjection {
  messages: ModelMessage[];
  removedChars: number;
  omittedReasoningMessages: number;
  compactedToolResults: number;
}

export function resolveContextOutputTokens(
  contextWindowTokens: number,
  configuredOutputTokens?: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error("contextWindowTokens must be a positive integer.");
  }
  if (
    configuredOutputTokens !== undefined &&
    (!Number.isInteger(configuredOutputTokens) || configuredOutputTokens <= 0)
  ) {
    throw new Error("maxOutputTokens must be a positive integer when provided.");
  }
  const resolved = configuredOutputTokens ?? Math.min(
    8_192,
    Math.max(1_024, Math.trunc(contextWindowTokens * 0.1)),
  );
  if (resolved >= contextWindowTokens) {
    throw new Error(
      `Invalid model token limits: maxOutputTokens (${resolved}) must be less than contextWindowTokens (${contextWindowTokens}).`,
    );
  }
  return resolved;
}

export function contextMaintenanceInputReserveTokens(usableInputTokens: number): number {
  return Math.min(
    CONTEXT_MAINTENANCE_RESERVE_MAX_TOKENS,
    Math.max(
      CONTEXT_MAINTENANCE_RESERVE_MIN_TOKENS,
      Math.trunc(usableInputTokens * 0.01),
    ),
  );
}

/**
 * The 95% threshold remains the normal trigger. A request is compacted a little
 * earlier only when its configured maximum response could otherwise consume
 * the space required to issue the mandatory checkpoint on the next boundary.
 */
export function requiresContextCompactionBeforeRound(pressure: ContextPressure): boolean {
  return pressure.ratio >= CONTEXT_COMPACTION_HARD_PRESSURE ||
    pressure.estimatedPromptTokens +
      pressure.reservedOutputTokens +
      contextMaintenanceInputReserveTokens(pressure.usableInputTokens) >=
        pressure.usableInputTokens;
}

/**
 * Total model-visible budget for every Tool result produced by one response.
 * Native results remain in ToolExecutionStore; this only bounds the projection
 * appended to the next model request.
 */
export function contextToolIngressTokenBudget(input: {
  pressure?: ContextPressure;
  actualInputTokens?: number;
  actualOutputTokens?: number;
}): number | undefined {
  const pressure = input.pressure;
  if (!pressure) return undefined;
  const actualInputTokens = Number.isInteger(input.actualInputTokens) &&
      Number(input.actualInputTokens) >= 0
    ? Number(input.actualInputTokens)
    : pressure.estimatedPromptTokens;
  const actualOutputTokens = Number.isInteger(input.actualOutputTokens) &&
      Number(input.actualOutputTokens) >= 0
    ? Number(input.actualOutputTokens)
    : pressure.reservedOutputTokens;
  const occupiedTokens = Math.max(
    pressure.estimatedPromptTokens,
    actualInputTokens,
  ) + actualOutputTokens;
  return Math.max(
    0,
    pressure.usableInputTokens -
      occupiedTokens -
      contextMaintenanceInputReserveTokens(pressure.usableInputTokens),
  );
}

/**
 * Compatibility escape hatch for an already-oversized persisted context. New
 * rounds are kept below this state by contextToolIngressTokenBudget. This
 * projection is request-only: canonical messages and Tool records are never
 * rewritten. It omits hidden reasoning first, then shortens only as many large
 * Tool results as needed while retaining their durable locators.
 */
export function projectContextCompactionMaintenanceMessages(input: {
  messages: ModelMessage[];
  sessionId: string;
  turnId: string;
  pressure: ContextPressure;
}): ContextCompactionMaintenanceProjection {
  const messages = [...input.messages];
  const targetRemovedChars = contextMaintenanceTargetRemovedChars(input.pressure);
  let removedChars = 0;
  let omittedReasoningMessages = 0;
  let compactedToolResults = 0;

  for (
    let index = messages.length - 1;
    index >= 0 && removedChars < targetRemovedChars;
    index -= 1
  ) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.reasoningContent) continue;
    const { reasoningContent: _reasoningContent, ...projected } = message;
    const saved = serializedMessageChars(message) - serializedMessageChars(projected);
    if (saved <= 0) continue;
    messages[index] = projected;
    removedChars += saved;
    omittedReasoningMessages += 1;
  }

  for (
    let index = messages.length - 1;
    index >= 0 && removedChars < targetRemovedChars;
    index -= 1
  ) {
    const message = messages[index]!;
    if (
      message.role !== "tool" ||
      message.content.length < CONTEXT_MAINTENANCE_TOOL_RESULT_MIN_CHARS ||
      isContextMaintenanceReceipt(message.content)
    ) {
      continue;
    }
    const projected: ModelMessage = {
      ...message,
      content: contextMaintenanceToolResultReceipt(
        message.content,
        input.sessionId,
        input.turnId,
        message.toolCallId,
      ),
    };
    const saved = serializedMessageChars(message) - serializedMessageChars(projected);
    if (saved <= 0) continue;
    messages[index] = projected;
    removedChars += saved;
    compactedToolResults += 1;
  }

  return {
    messages,
    removedChars,
    omittedReasoningMessages,
    compactedToolResults,
  };
}

export function registerContextCompactionTool(
  registry: ToolRegistry,
  apply: (input: {
    sessionId: string;
    activeTurnId: string;
    checkpoint: unknown;
  }) => { session: SessionSnapshot; checkpoint: ContextCheckpointInput },
): void {
  registry.register({
    definition: {
      name: CHECKPOINT_CONTEXT_TOOL,
      description: [
        "Replace every explicitly requested context segment with concise semantic summaries.",
        "Never call this Tool proactively or decide that compaction is needed yourself.",
        "Call it alone only when an explicit user-role context_pressure message requires compaction.",
        "The Runtime may request preceding Turn summaries, one cumulative active-Turn checkpoint, or both.",
        "Return only summary text: summaries is an ordered array of strings; active_summary is one string (empty when not requested). Runtime binds all revision numbers, Turn IDs and message boundaries.",
        "Preserve why the work happened, inspected scope, conclusions, changes, verification, important artifacts or identifiers, external side effects, unresolved work, and the exact next action; omit ordinary Tool-call order and logs.",
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summaries", "active_summary"],
        properties: {
          summaries: {
            type: "array",
            description: "One nonempty summary string per requested preceding Turn, in notice order. Empty array when none.",
            items: { type: "string", minLength: 1, maxLength: 6000 },
          },
          active_summary: {
            type: "string",
            maxLength: 6000,
            description: "Cumulative facts and next action for the requested current-Turn portion. Empty string when not requested.",
          },
        },
      },
    },
    manifest: {
      effect_kind: "runtime_state",
      operation: "context.checkpoint",
      risk: "low",
      owner: "runtime",
      dispatch_scope: "session",
      mutating: false,
    },
    parallelSafe: false,
    visibleToChild: true,
    // Authorization is session-scoped and must be checked before binding the text.
    decodeInput: (value) => value,
    execute: (context) => {
      const { session, checkpoint } = apply({
        sessionId: context.sessionId,
        activeTurnId: context.turnId,
        checkpoint: context.input,
      });
      return checkpointResult(checkpoint, session);
    },
  });
}

export class ContextCheckpointInputError extends Error {
  readonly received: string;
  constructor(readonly field: string, readonly expected: string, value: unknown) {
    const received = checkpointValueShape(value);
    super(`checkpoint_context ${field}: expected ${expected}; received ${received}.`);
    this.name = "ContextCheckpointInputError";
    this.received = received;
  }
}

function checkpointValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === "string") return `string (${value.length} characters)`;
  if (typeof value === "number") return `number (${value})`;
  return typeof value;
}

function checkpointObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContextCheckpointInputError(field, "an object", value);
  }
  return value as Record<string, unknown>;
}

function checkpointSummary(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 6000) {
    throw new ContextCheckpointInputError(field, "a nonempty summary string of at most 6000 characters", value);
  }
  return value.trim();
}

/** Decode old saved tool catalogs without silently overriding their identity claims. */
export function decodeContextCheckpointInput(value: unknown): ContextCheckpointInput {
  const candidate = checkpointObject(value, "input");
  const sessionRevision = Number(candidate.session_revision);
  if (!Number.isInteger(sessionRevision) || sessionRevision < 1) {
    throw new ContextCheckpointInputError("session_revision", "a positive integer", candidate.session_revision);
  }
  if (!Array.isArray(candidate.summaries)) {
    throw new ContextCheckpointInputError("summaries", "an array", candidate.summaries);
  }
  const summaries = candidate.summaries.map((value, index) => {
    const entry = checkpointObject(value, `summaries[${index}]`);
    return {
      turnId: checkpointIdentity(entry.turn_id, `summaries[${index}].turn_id`),
      summary: checkpointSummary(entry.summary, `summaries[${index}].summary`),
    };
  });
  const activeTurn = decodeActiveTurnCheckpoint(candidate.active_turn);
  if (summaries.length === 0 && !activeTurn) {
    throw new ContextCheckpointInputError("input", "requested preceding summaries or active_turn", value);
  }
  return {
    sessionRevision,
    summaries,
    ...(activeTurn ? { activeTurn } : {}),
  };
}

function decodeActiveTurnCheckpoint(value: unknown): ActiveTurnCheckpointInput | undefined {
  if (value === undefined) return undefined;
  const candidate = checkpointObject(value, "active_turn");
  return {
    turnId: checkpointIdentity(candidate.turn_id, "active_turn.turn_id"),
    throughMessageId: checkpointIdentity(candidate.through_message_id, "active_turn.through_message_id"),
    summary: checkpointSummary(candidate.summary, "active_turn.summary"),
  };
}

function checkpointIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ContextCheckpointInputError(field, "a nonempty identity string", value);
  }
  return value.trim();
}

/** Only the runtime authorization supplies persisted identities in the new format. */
export function bindContextCheckpointInput(
  value: unknown,
  authorized: ContextCompactionState,
): ContextCheckpointInput {
  const candidate = checkpointObject(value, "input");
  if ("session_revision" in candidate && !("active_summary" in candidate)) {
    const legacy = decodeContextCheckpointInput(candidate);
    if (legacy.sessionRevision !== authorized.revision) {
      throw new ContextCheckpointInputError("session_revision", `authorized revision ${authorized.revision}`, candidate.session_revision);
    }
    if (legacy.summaries.length !== authorized.unsummarizedTurnIds.length) {
      throw new ContextCheckpointInputError("summaries", `exactly ${authorized.unsummarizedTurnIds.length} requested summaries`, candidate.summaries);
    }
    legacy.summaries.forEach((entry, index) => {
      if (entry.turnId !== authorized.unsummarizedTurnIds[index]) {
        throw new ContextCheckpointInputError(`summaries[${index}].turn_id`, "the authorized Turn at this index", entry.turnId);
      }
    });
    if (Boolean(legacy.activeTurn) !== Boolean(authorized.activeTurn)) {
      throw new ContextCheckpointInputError("active_turn", authorized.activeTurn ? "the authorized active-Turn object" : "no active-Turn segment", candidate.active_turn);
    }
    if (legacy.activeTurn && authorized.activeTurn) {
      if (legacy.activeTurn.turnId !== authorized.activeTurn.turnId) {
        throw new ContextCheckpointInputError("active_turn.turn_id", "the authorized active Turn ID", legacy.activeTurn.turnId);
      }
      if (legacy.activeTurn.throughMessageId !== authorized.activeTurn.throughMessageId) {
        throw new ContextCheckpointInputError("active_turn.through_message_id", "the authorized active message boundary", legacy.activeTurn.throughMessageId);
      }
    }
    return legacy;
  }
  for (const key of Object.keys(candidate)) {
    if (key !== "summaries" && key !== "active_summary") {
      throw new ContextCheckpointInputError("input", "only summaries and active_summary (no identity fields)", candidate);
    }
  }
  if (!Array.isArray(candidate.summaries) || candidate.summaries.length !== authorized.unsummarizedTurnIds.length) {
    throw new ContextCheckpointInputError("summaries", `exactly ${authorized.unsummarizedTurnIds.length} summary strings in notice order`, candidate.summaries);
  }
  const summaries = candidate.summaries.map((summary, index) => ({
    turnId: authorized.unsummarizedTurnIds[index]!,
    summary: checkpointSummary(summary, `summaries[${index}]`),
  }));
  const activeTurn = authorized.activeTurn ? {
    ...authorized.activeTurn,
    summary: checkpointSummary(candidate.active_summary, "active_summary"),
  } : undefined;
  if (!activeTurn && candidate.active_summary !== undefined && candidate.active_summary !== "") {
    throw new ContextCheckpointInputError("active_summary", "an empty string because no active segment is authorized", candidate.active_summary);
  }
  return { sessionRevision: authorized.revision, summaries, ...(activeTurn ? { activeTurn } : {}) };
}

export function contextCheckpointFailure(error: unknown, argumentsText: string) {
  const message = error instanceof ContextCheckpointInputError ? error.message
    : error instanceof SyntaxError ? "checkpoint_context input: expected valid JSON."
    : error instanceof Error ? error.message.slice(0, 512) : "Context checkpoint could not be applied.";
  return {
    message,
    diagnostics: {
      code: error instanceof ContextCheckpointInputError ? "checkpoint_input_invalid"
        : error instanceof SyntaxError ? "checkpoint_json_invalid" : "checkpoint_apply_failed",
      ...(error instanceof ContextCheckpointInputError ? {
        field: error.field, expected: error.expected, received: error.received,
      } : {}),
      argumentsChars: argumentsText.length,
      argumentsSha256: createHash("sha256").update(argumentsText).digest("hex"),
    },
  };
}

export function estimateContextPressure(
  request: ModelRequest,
  messages: ModelMessage[],
  providerInputTokens?: number,
  fallbackCalibration: {
    scale?: number;
    minimumInputTokens?: number;
  } = {},
): ContextPressure | undefined {
  const contextWindowTokens = Number(request.metadata.contextWindowTokens);
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  const reservedOutputTokens = resolveContextOutputTokens(
    Math.trunc(contextWindowTokens),
    request.maxOutputTokens,
  );
  const usableInputTokens = Math.max(1, Math.trunc(contextWindowTokens) - reservedOutputTokens);
  const promptShape = {
    model: request.model,
    messages,
    tools: request.tools,
    reasoningEffort: request.reasoningEffort,
    requestCapabilities: request.requestCapabilities,
  };
  const imageTokens = messages.reduce((total, message) =>
    total + (message.role === "user" ? (message.images?.length ?? 0) * 1024 : 0), 0);
  const fallbackEstimate = Math.ceil(JSON.stringify(promptShape).length / 4) + imageTokens;
  const fallbackScale = Number.isFinite(fallbackCalibration.scale) &&
    Number(fallbackCalibration.scale) >= 1
      ? Number(fallbackCalibration.scale)
      : 1;
  const minimumInputTokens = Number.isInteger(fallbackCalibration.minimumInputTokens) &&
    Number(fallbackCalibration.minimumInputTokens) >= 0
      ? Number(fallbackCalibration.minimumInputTokens)
      : 0;
  const hasProviderMeasurement = Number.isInteger(providerInputTokens) && providerInputTokens! >= 0;
  const estimatedPromptTokens = hasProviderMeasurement
    ? providerInputTokens!
    : Math.max(
        Math.ceil(fallbackEstimate * fallbackScale),
        minimumInputTokens,
      );
  return {
    estimatedPromptTokens,
    measurement: hasProviderMeasurement ? "provider" : "fallback_estimate",
    fallbackPromptTokens: fallbackEstimate,
    fallbackScale,
    reservedOutputTokens,
    usableInputTokens,
    ratio: estimatedPromptTokens / usableInputTokens,
  };
}

export function contextPressureNotice(
  state: ContextCompactionState,
  pressure: ContextPressure,
  legacyInput = false,
): ModelMessage {
  const precedingInstructions = state.unsummarizedTurnIds.length > 0
    ? [
        legacyInput ? "Summarize every listed preceding Turn exactly once and in this order:"
          : `Return exactly ${state.unsummarizedTurnIds.length} plain summary strings in summaries, one per listed preceding Turn in this order (no ID objects):`,
        ...state.unsummarizedTurnIds.map((turnId) => `- ${turnId}`),
      ]
    : [
        "There are no unsummarized preceding Turns. Set summaries to an empty array.",
      ];
  const activeInstructions = state.activeTurn
    ? [
        legacyInput ? "Also provide active_turn for the completed portion of the current Turn:"
          : "Return active_summary as one cumulative plain text string for the completed portion of the current Turn. Runtime owns these identifiers; do not copy them into Tool arguments:",
        `- turn_id: ${state.activeTurn.turnId}`,
        `- through_message_id: ${state.activeTurn.throughMessageId}`,
        "Its summary must be cumulative: merge any earlier active_turn_checkpoint already present with all work completed through this boundary. Preserve the original user goal, current scope, facts learned, files or resources changed, external side effects, verification results, important errors or identifiers, unresolved work, and the exact next action needed to continue without repeating completed work.",
      ]
    : [
        legacyInput ? "No active-Turn segment is authorized. Omit active_turn."
          : 'No active-Turn segment is authorized. Set active_summary to an empty string ("").',
      ];
  return {
    role: "user",
    name: "context_pressure",
    visibility: "internal",
    content: [
      `<context_pressure mode="required" ratio="${pressure.ratio.toFixed(4)}" session_revision="${state.revision}">`,
      pressure.ratio >= CONTEXT_COMPACTION_HARD_PRESSURE
        ? "The local Runtime has measured the active context at or above the mandatory 95% threshold. Call checkpoint_context now and call it alone. This user-role instruction is the only authorization to use that Tool."
        : "The local Runtime has reached the last safe round boundary before one configured model response could exhaust the checkpoint reserve. Call checkpoint_context now and call it alone. This user-role instruction is the only authorization to use that Tool.",
      ...precedingInstructions,
      ...activeInstructions,
      ...(legacyInput ? [] : [
        'The Tool input has exactly two fields: {"summaries":["summary text in the order above"],"active_summary":"current Turn summary, or empty when not requested"}. Use summaries: [] when there are no preceding Turns. Do not include session_revision, turn_id, through_message_id or active_turn; Runtime binds them to this authorized boundary.',
      ]),
      "Each natural-language summary must preserve: user intent; inspected scope; conclusions; files or resources changed; external side effects; test/build/publish results; important errors, paths, URLs, hashes or task IDs; and unresolved work.",
      "If a Tool result is represented by an archived compact receipt and its preview is insufficient to establish a fact, preserve its exact locator and make reading that locator an unresolved next action; never guess the omitted content.",
      "Omit ordinary Tool-call order, repeated reads/searches, raw logs, call IDs, and intermediate conclusions superseded later.",
      "</context_pressure>",
    ].join("\n"),
  };
}

function contextMaintenanceTargetRemovedChars(pressure: ContextPressure): number {
  const targetInputTokens = Math.floor(
    pressure.usableInputTokens * CONTEXT_MAINTENANCE_TARGET_RATIO,
  );
  const requiredProviderTokenSavings = Math.max(
    1,
    pressure.estimatedPromptTokens - targetInputTokens,
  );
  const providerTokensPerFallbackToken = pressure.fallbackPromptTokens > 0
    ? pressure.estimatedPromptTokens / pressure.fallbackPromptTokens
    : 1;
  const requiredFallbackTokenSavings = Math.ceil(
    requiredProviderTokenSavings / Math.max(0.25, providerTokensPerFallbackToken),
  );
  return requiredFallbackTokenSavings * 4;
}

function contextMaintenanceToolResultReceipt(
  content: string,
  sessionId: string,
  turnId: string,
  toolCallId: string,
): string {
  const archived = parseArchivedToolResult(content);
  const locator = archived?.locator ??
    `tool-result://${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}/${encodeURIComponent(toolCallId)}`;
  const previewSource = archived?.preview ?? content;
  const head = previewSource.slice(0, CONTEXT_MAINTENANCE_TOOL_RESULT_HEAD_CHARS);
  const tail = previewSource.length >
      CONTEXT_MAINTENANCE_TOOL_RESULT_HEAD_CHARS +
        CONTEXT_MAINTENANCE_TOOL_RESULT_TAIL_CHARS
    ? previewSource.slice(-CONTEXT_MAINTENANCE_TOOL_RESULT_TAIL_CHARS)
    : "";
  const preview = tail
    ? `${head}\n... [middle omitted only for mandatory context checkpoint] ...\n${tail}`
    : head;
  return JSON.stringify({
    archived: true,
    locator,
    originalChars: archived?.originalChars ?? content.length,
    preview,
    contextCheckpointProjection: true,
    note: "This compact receipt is used only to create the mandatory context checkpoint. The complete Tool result remains available at locator and in history.",
  });
}

function parseArchivedToolResult(content: string): {
  locator: string;
  originalChars?: number;
  preview?: string;
} | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.archived !== true || typeof candidate.locator !== "string") {
      return undefined;
    }
    return {
      locator: candidate.locator,
      ...(typeof candidate.originalChars === "number"
        ? { originalChars: candidate.originalChars }
        : {}),
      ...(typeof candidate.preview === "string" ? { preview: candidate.preview } : {}),
    };
  } catch {
    return undefined;
  }
}

function isContextMaintenanceReceipt(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).contextCheckpointProjection === true,
    );
  } catch {
    return false;
  }
}

function serializedMessageChars(message: ModelMessage): number {
  return JSON.stringify(message).length;
}

function checkpointResult(
  checkpoint: ContextCheckpointInput,
  session: SessionSnapshot,
): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    session_revision: session.revision,
    summarized_turns: checkpoint.summaries.map((item) => item.turnId),
    ...(checkpoint.activeTurn
      ? {
          active_turn: {
            turn_id: checkpoint.activeTurn.turnId,
            through_message_id: checkpoint.activeTurn.throughMessageId,
          },
        }
      : {}),
  };
}
