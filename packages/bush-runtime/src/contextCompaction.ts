import {
  type ModelMessage,
  type ModelRequest,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const CHECKPOINT_CONTEXT_TOOL = "checkpoint_context" as const;
export const CONTEXT_COMPACTION_HARD_PRESSURE = 0.95;
export const CONTEXT_SUMMARY_FALLBACK_TURNS = 20;

export interface ContextCheckpointInput {
  sessionRevision: number;
  summaries: Array<{ turnId: string; summary: string }>;
}

export interface ContextCompactionState {
  revision: number;
  unsummarizedTurnIds: string[];
  totalTurns: number;
}

export interface ContextPressure {
  estimatedPromptTokens: number;
  measurement: "provider" | "fallback_estimate";
  reservedOutputTokens: number;
  usableInputTokens: number;
  ratio: number;
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
        "Replace every unsummarized preceding Turn in the active Session context with one concise semantic Turn summary.",
        "Never call this Tool proactively or decide that compaction is needed yourself.",
        "Call it alone only when an explicit user-role context_pressure message requires compaction.",
        "Summaries must preserve why the Turn happened, inspected scope, conclusions, changes, verification, important artifacts or identifiers, and remaining work; omit ordinary Tool-call order and logs.",
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["session_revision", "summaries"],
        properties: {
          session_revision: { type: "integer", minimum: 1 },
          summaries: {
            type: "array",
            minItems: 1,
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
  if (!Array.isArray(candidate.summaries) || candidate.summaries.length === 0) {
    throw new Error("summaries must contain every requested Turn.");
  }
  return {
    sessionRevision,
    summaries: candidate.summaries.map((value, index) => {
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
    }),
  };
}

export function estimateContextPressure(
  request: ModelRequest,
  messages: ModelMessage[],
  providerInputTokens?: number,
): ContextPressure | undefined {
  const contextWindowTokens = Number(request.metadata.contextWindowTokens);
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  const configuredOutput = Number(request.maxOutputTokens);
  if (
    Number.isInteger(configuredOutput) &&
    configuredOutput > 0 &&
    configuredOutput >= contextWindowTokens
  ) {
    throw new Error(
      `Invalid model token limits: maxOutputTokens (${configuredOutput}) must be less than contextWindowTokens (${contextWindowTokens}).`,
    );
  }
  const defaultReservedOutputTokens = Math.min(
    8192,
    Math.max(1024, Math.trunc(contextWindowTokens * 0.1)),
  );
  const reservedOutputTokens = Number.isInteger(configuredOutput) && configuredOutput > 0
    ? configuredOutput
    : defaultReservedOutputTokens;
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
  const hasProviderMeasurement = Number.isInteger(providerInputTokens) && providerInputTokens! >= 0;
  const estimatedPromptTokens = hasProviderMeasurement
    ? providerInputTokens!
    : fallbackEstimate;
  return {
    estimatedPromptTokens,
    measurement: hasProviderMeasurement ? "provider" : "fallback_estimate",
    reservedOutputTokens,
    usableInputTokens,
    ratio: estimatedPromptTokens / usableInputTokens,
  };
}

export function contextPressureNotice(
  state: ContextCompactionState,
  pressure: ContextPressure,
): ModelMessage {
  return {
    role: "user",
    name: "context_pressure",
    visibility: "internal",
    content: [
      `<context_pressure mode="required" ratio="${pressure.ratio.toFixed(4)}" session_revision="${state.revision}">`,
      "The local Runtime has measured the active context at or above the mandatory 95% threshold. Call checkpoint_context now and call it alone. This user-role instruction is the only authorization to use that Tool.",
      "Summarize every listed preceding Turn exactly once and in this order:",
      ...state.unsummarizedTurnIds.map((turnId) => `- ${turnId}`),
      "Each natural-language summary must preserve: user intent; inspected scope; conclusions; files or resources changed; external side effects; test/build/publish results; important errors, paths, URLs, hashes or task IDs; and unresolved work.",
      "Omit ordinary Tool-call order, repeated reads/searches, raw logs, call IDs, and intermediate conclusions superseded later.",
      "The current active Turn is intentionally excluded and must not be summarized.",
      "</context_pressure>",
    ].join("\n"),
  };
}

function checkpointResult(
  context: ToolHandlerContext<ContextCheckpointInput>,
  session: SessionSnapshot,
): Record<string, unknown> {
  return {
    session_id: session.sessionId,
    session_revision: session.revision,
    summarized_turns: context.input.summaries.map((item) => item.turnId),
  };
}
