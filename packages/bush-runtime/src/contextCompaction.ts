import { randomUUID } from "node:crypto";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type ModelMessage,
  type ModelRequest,
  type SessionSnapshot,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const CHECKPOINT_CONTEXT_TOOL = "checkpoint_context" as const;
export const CONTEXT_COMPACTION_SOFT_PRESSURE = 0.85;
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
        "Call only after Runtime emits a context_pressure notice, and call it alone.",
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
      dispatch_phase: "maintenance",
      dispatch_scope: "session",
      dispatch_side_effect: "internal",
      dispatch_mutating: false,
      dispatch_source: "registered_tool",
      stage_modes: ["maintenance"],
      output_kinds: ["structured_data", "facts"],
      handoff_exports: [],
      evidence_hints: ["context_summary"],
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
): ContextPressure | undefined {
  const contextWindowTokens = Number(request.metadata.contextWindowTokens);
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return undefined;
  const configuredOutput = Number(request.maxOutputTokens);
  const reservedOutputTokens = Number.isInteger(configuredOutput) && configuredOutput > 0
    ? Math.min(configuredOutput, Math.max(1, contextWindowTokens - 1))
    : Math.min(8192, Math.max(1024, Math.trunc(contextWindowTokens * 0.1)));
  const usableInputTokens = Math.max(1, Math.trunc(contextWindowTokens) - reservedOutputTokens);
  const promptShape = {
    model: request.model,
    messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    reasoningEffort: request.reasoningEffort,
    requestCapabilities: request.requestCapabilities,
  };
  const imageTokens = messages.reduce((total, message) =>
    total + (message.role === "user" ? (message.images?.length ?? 0) * 1024 : 0), 0);
  const estimatedPromptTokens = Math.ceil(JSON.stringify(promptShape).length / 4) + imageTokens;
  return {
    estimatedPromptTokens,
    reservedOutputTokens,
    usableInputTokens,
    ratio: estimatedPromptTokens / usableInputTokens,
  };
}

export function contextPressureNotice(
  state: ContextCompactionState,
  pressure: ContextPressure,
  required: boolean,
): ModelMessage {
  return {
    role: "user",
    name: "context_pressure",
    visibility: "internal",
    content: [
      `<context_pressure mode="${required ? "required" : "optional"}" ratio="${pressure.ratio.toFixed(4)}" session_revision="${state.revision}">`,
      required
        ? "The active context has reached the mandatory compaction threshold. Call checkpoint_context now and call it alone."
        : "The active context is above the soft threshold. If attention pressure is materially affecting the task, call checkpoint_context alone; otherwise continue normally.",
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
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output: {
      session_id: session.sessionId,
      session_revision: session.revision,
      summarized_turns: context.input.summaries.map((item) => item.turnId),
    },
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: `receipt_context_checkpoint_${randomUUID()}`,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "completed",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["context_summary"],
      paths: [],
      execution_success: true,
      semantic_success: true,
      verification_state: "verified",
      error_code: "",
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
  };
}
