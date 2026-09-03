import {
  type ModelMessage,
  type ModelRequest,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

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
    checkpoint: ContextCheckpointInput;
  }) => SessionSnapshot,
): void {
  registry.register<ContextCheckpointInput>({
    definition: {
      name: CHECKPOINT_CONTEXT_TOOL,
      description: [
        "Replace every explicitly requested context segment with concise semantic summaries.",
        "Never call this Tool proactively or decide that compaction is needed yourself.",
        "Call it alone only when an explicit user-role context_pressure message requires compaction.",
        "The Runtime may request preceding Turn summaries, one cumulative active-Turn checkpoint, or both.",
        "Preserve why the work happened, inspected scope, conclusions, changes, verification, important artifacts or identifiers, external side effects, unresolved work, and the exact next action; omit ordinary Tool-call order and logs.",
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["session_revision", "summaries"],
        properties: {
          session_revision: { type: "integer", minimum: 1 },
          summaries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["turn_id", "summary"],
              properties: {
                turn_id: { type: "string", minLength: 1 },
                summary: { type: "string", minLength: 1, maxLength: 6000 },
              },
            },
          },
          active_turn: {
            type: "object",
            additionalProperties: false,
            required: ["turn_id", "through_message_id", "summary"],
            properties: {
              turn_id: { type: "string", minLength: 1 },
              through_message_id: { type: "string", minLength: 1 },
              summary: { type: "string", minLength: 1, maxLength: 6000 },
            },
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
    decodeInput: decodeContextCheckpointInput,
    execute: (context) => {
      const session = apply({
        sessionId: context.sessionId,
        activeTurnId: context.turnId,
        checkpoint: context.input,
      });
      return checkpointResult(context, session);
    },
  });
}

export function decodeContextCheckpointInput(value: unknown): ContextCheckpointInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("checkpoint_context input must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const sessionRevision = Number(candidate.session_revision);
  if (!Number.isInteger(sessionRevision) || sessionRevision < 1) {
    throw new Error("session_revision must be a positive integer.");
  }
  if (!Array.isArray(candidate.summaries)) {
    throw new Error("summaries must be an array.");
  }
  const summaries = candidate.summaries.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`summaries[${index}] must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const turnId = String(entry.turn_id ?? "").trim();
    const summary = String(entry.summary ?? "").trim();
    if (!turnId) throw new Error(`summaries[${index}].turn_id is required.`);
    if (!summary) throw new Error(`summaries[${index}].summary is required.`);
    if (summary.length > 6000) {
      throw new Error(`summaries[${index}].summary exceeds 6000 characters.`);
    }
    return { turnId, summary };
  });
  const activeTurn = decodeActiveTurnCheckpoint(candidate.active_turn);
  if (summaries.length === 0 && !activeTurn) {
    throw new Error("checkpoint_context must contain requested preceding summaries or active_turn.");
  }
  return {
    sessionRevision,
    summaries,
    ...(activeTurn ? { activeTurn } : {}),
  };
}

function decodeActiveTurnCheckpoint(value: unknown): ActiveTurnCheckpointInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("active_turn must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const turnId = String(candidate.turn_id ?? "").trim();
  const throughMessageId = String(candidate.through_message_id ?? "").trim();
  const summary = String(candidate.summary ?? "").trim();
  if (!turnId) throw new Error("active_turn.turn_id is required.");
  if (!throughMessageId) throw new Error("active_turn.through_message_id is required.");
  if (!summary) throw new Error("active_turn.summary is required.");
  if (summary.length > 6000) {
    throw new Error("active_turn.summary exceeds 6000 characters.");
  }
  return { turnId, throughMessageId, summary };
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
): ModelMessage {
  const precedingInstructions = state.unsummarizedTurnIds.length > 0
    ? [
        "Summarize every listed preceding Turn exactly once and in this order:",
        ...state.unsummarizedTurnIds.map((turnId) => `- ${turnId}`),
      ]
    : [
        "There are no unsummarized preceding Turns. Set summaries to an empty array.",
      ];
  const activeInstructions = state.activeTurn
    ? [
        "Also provide active_turn for the completed portion of the current Turn:",
        `- turn_id: ${state.activeTurn.turnId}`,
        `- through_message_id: ${state.activeTurn.throughMessageId}`,
        "Its summary must be cumulative: merge any earlier active_turn_checkpoint already present with all work completed through this boundary. Preserve the original user goal, current scope, facts learned, files or resources changed, external side effects, verification results, important errors or identifiers, unresolved work, and the exact next action needed to continue without repeating completed work.",
      ]
    : [
        "No active-Turn segment is authorized. Omit active_turn.",
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
  context: ToolHandlerContext<ContextCheckpointInput>,
  session: SessionSnapshot,
): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    session_revision: session.revision,
    summarized_turns: context.input.summaries.map((item) => item.turnId),
    ...(context.input.activeTurn
      ? {
          active_turn: {
            turn_id: context.input.activeTurn.turnId,
            through_message_id: context.input.activeTurn.throughMessageId,
          },
        }
      : {}),
  };
}
