import { randomUUID } from "node:crypto";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  BUSH_TURN_OUTCOME_DECLARATION_PROTOCOL,
  turnOutcomeDeclarationSchema,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { ToolExecutionStore } from "./toolExecutionStore.js";
import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const DECLARE_TURN_OUTCOME_TOOL = "declare_turn_outcome" as const;

export function registerOutcomeTool(
  registry: ToolRegistry,
  executions: ToolExecutionStore,
  createReceiptId: () => string = () => `receipt_${randomUUID()}`,
): void {
  if (registry.resolve(DECLARE_TURN_OUTCOME_TOOL)) return;
  registry.register({
    definition: {
      name: DECLARE_TURN_OUTCOME_TOOL,
      description:
        "Declare the Turn's terminal disposition and final user-visible response. For effect_complete, explicitly cite successful receipt IDs returned by prior Tool calls in this Turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["disposition", "final_response"],
        properties: {
          disposition: {
            enum: ["answer", "effect_complete", "blocked", "awaiting_input"],
          },
          receipt_ids: {
            type: "array",
            items: { type: "string", minLength: 1 },
            default: [],
          },
          final_response: { type: "string", minLength: 1 },
        },
      },
    },
    manifest: {
      effect_kind: "runtime_state",
      operation: "turn.declare_outcome",
      risk: "low",
      owner: "runtime_turn",
      dispatch_phase: "finalization",
      dispatch_scope: "session",
      dispatch_side_effect: "runtime_fact",
      dispatch_mutating: true,
      dispatch_source: "registered_tool",
      stage_modes: ["finalize"],
      output_kinds: ["turn_outcome"],
      handoff_exports: [],
      evidence_hints: ["execution_receipt"],
    },
    parallelSafe: false,
    visibleToChild: true,
    decodeInput: (input) => {
      const candidate = object(input);
      const receiptIds = Array.isArray(candidate.receipt_ids)
        ? candidate.receipt_ids.map(String)
        : [];
      if (new Set(receiptIds).size !== receiptIds.length) {
        throw new Error("receipt_ids must be unique.");
      }
      return turnOutcomeDeclarationSchema.parse({
        protocol: BUSH_TURN_OUTCOME_DECLARATION_PROTOCOL,
        disposition: candidate.disposition,
        receipt_ids: receiptIds,
        final_response: candidate.final_response,
      });
    },
    execute: (context) => {
      const declaration = context.input;
      const records = executions.listTurn(context.sessionId, context.turnId);
      const byReceipt = new Map(records.flatMap((record) =>
        record.result.facts.map((fact) => [fact.receipt_id, { fact, record }] as const),
      ));
      for (const receiptId of declaration.receipt_ids) {
        const cited = byReceipt.get(receiptId);
        if (!cited) throw new Error(`Receipt ${receiptId} does not belong to this Turn.`);
        const { fact } = cited;
        if (!fact.execution_success || !fact.semantic_success || fact.verification_state === "failed") {
          throw new Error(`Receipt ${receiptId} is not a successful execution fact.`);
        }
      }
      if (declaration.disposition === "effect_complete" && declaration.receipt_ids.length === 0) {
        throw new Error("effect_complete requires at least one successful receipt ID.");
      }
      if (
        declaration.disposition === "effect_complete" &&
        !declaration.receipt_ids.some((receiptId) => {
          const sideEffect = byReceipt.get(receiptId)?.record.actionManifest?.dispatch_side_effect;
          return Boolean(sideEffect && sideEffect !== "none");
        })
      ) {
        throw new Error(
          "effect_complete requires a cited receipt whose Action Manifest declares an effect.",
        );
      }
      return completed(context, declaration, createReceiptId());
    },
  });
}

function completed(
  context: ToolHandlerContext<ReturnType<typeof turnOutcomeDeclarationSchema.parse>>,
  declaration: ReturnType<typeof turnOutcomeDeclarationSchema.parse>,
  receiptId: string,
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output: declaration,
    turn_outcome: declaration,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "succeeded",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["turn_outcome"],
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

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}
