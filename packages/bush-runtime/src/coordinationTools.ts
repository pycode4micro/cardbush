import { randomUUID } from "node:crypto";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TASK_PLAN_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type GoalState,
  type TaskPlan,
  type ToolResult,
} from "@cardbush/bush-protocol";

import type { CoordinationStore } from "./coordinationStore.js";
import type {
  ToolHandlerContext,
  ToolRegistry,
} from "./toolRegistry.js";

export const UPDATE_TASK_PLAN_TOOL = "update_task_plan" as const;
export const UPDATE_GOAL_TOOL = "update_goal" as const;

interface TaskPlanToolInput {
  nodes: Array<{ id?: string; step: string; status: "pending" | "in_progress" | "completed" }>;
  explanation: string;
  active: boolean;
  scopeChangeReason: string;
}

interface GoalToolInput {
  status: "active" | "complete" | "blocked" | "cancelled";
  statusReason: string;
  consumedTokens?: number;
  linkedA2ATaskIds?: string[];
}

export function registerCoordinationTools(
  registry: ToolRegistry,
  store: CoordinationStore,
  options: {
    createPlanId?: () => string;
    createReceiptId?: () => string;
  } = {},
): void {
  const createPlanId = options.createPlanId ?? (() => `plan_${randomUUID()}`);
  const createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);

  if (!registry.resolve(UPDATE_TASK_PLAN_TOOL)) {
    registry.register<TaskPlanToolInput>({
      definition: {
        name: UPDATE_TASK_PLAN_TOOL,
        description:
          "Create or update the current task plan with explicit nodes and statuses. Preserve returned node IDs on later updates; give a scopeChangeReason when removing a node.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["nodes", "explanation", "active"],
          properties: {
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["step", "status"],
                properties: {
                  id: { type: "string" },
                  step: { type: "string" },
                  status: { enum: ["pending", "in_progress", "completed"] },
                },
              },
            },
            explanation: { type: "string" },
            active: { type: "boolean" },
            scopeChangeReason: { type: "string" },
          },
        },
      },
      manifest: coordinationManifest("plan.update"),
      decodeInput: decodeTaskPlanInput,
      execute: (context) => {
        const before = store.getPlan(context.sessionId);
        const plan: TaskPlan = {
          protocol: BUSH_TASK_PLAN_PROTOCOL,
          plan_id: before?.plan.plan_id ?? createPlanId(),
          session_id: context.sessionId,
          nodes: context.input.nodes,
          explanation: context.input.explanation,
          active: context.input.active,
        };
        const state = store.setPlan({
          sessionId: context.sessionId,
          expectedRevision: before?.revision ?? 0,
          plan,
          scopeChangeReason: context.input.scopeChangeReason,
        });
        return completedResult(context, state, createReceiptId());
      },
    });
  }

  if (!registry.resolve(UPDATE_GOAL_TOOL)) {
    registry.register<GoalToolInput>({
      definition: {
        name: UPDATE_GOAL_TOOL,
        description:
          "Declare the current Goal status and reason. Use complete only when the objective is complete, blocked only when it cannot continue, and active when another Turn is needed.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["status", "statusReason"],
          properties: {
            status: { enum: ["active", "complete", "blocked", "cancelled"] },
            statusReason: { type: "string" },
            consumedTokens: { type: "integer", minimum: 0 },
            linkedA2ATaskIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      manifest: coordinationManifest("goal.update"),
      visibleToChild: true,
      decodeInput: decodeGoalInput,
      execute: (context) => {
        const before = store.getGoal(context.sessionId);
        if (!before) throw new Error(`Session ${context.sessionId} has no active Goal fact.`);
        const state = store.updateGoal({
          goalId: before.goalId,
          sessionId: context.sessionId,
          expectedRevision: before.revision,
          status: context.input.status,
          statusReason: context.input.statusReason,
          consumedTokens: context.input.consumedTokens ?? before.consumedTokens,
          linkedA2ATaskIds: context.input.linkedA2ATaskIds ?? before.linkedA2ATaskIds,
        });
        return completedResult(context, state, createReceiptId());
      },
    });
  }
}

function coordinationManifest(operation: string) {
  return {
    effect_kind: "runtime_state",
    operation,
    risk: "low",
    owner: "runtime_coordination",
    dispatch_phase: "execution",
    dispatch_scope: "session",
    dispatch_side_effect: "runtime_fact",
    dispatch_mutating: true,
    dispatch_source: "registered_tool",
    stage_modes: ["execute"],
    output_kinds: ["structured_data"],
    handoff_exports: [],
    evidence_hints: ["runtime_state"],
  };
}

function completedResult(
  context: ToolHandlerContext<unknown>,
  output: TaskPlan | GoalState | unknown,
  receiptId: string,
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output,
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "succeeded",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["runtime_state"],
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

function decodeTaskPlanInput(input: unknown): TaskPlanToolInput {
  const object = plainObject(input, "update_task_plan input");
  if (!Array.isArray(object.nodes) || object.nodes.length < 1 || object.nodes.length > 20) {
    throw new Error("nodes must contain between 1 and 20 Plan nodes.");
  }
  return {
    nodes: object.nodes.map((candidate, index) => {
      const node = plainObject(candidate, `nodes[${index}]`);
      const status = requiredString(node.status, `nodes[${index}].status`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`nodes[${index}].status is invalid.`);
      }
      return {
        ...(optionalString(node.id) ? { id: optionalString(node.id) } : {}),
        step: requiredString(node.step, `nodes[${index}].step`),
        status: status as TaskPlanToolInput["nodes"][number]["status"],
      };
    }),
    explanation: stringValue(object.explanation, "explanation"),
    active: booleanValue(object.active, "active"),
    scopeChangeReason: optionalString(object.scopeChangeReason) ?? "",
  };
}

function decodeGoalInput(input: unknown): GoalToolInput {
  const object = plainObject(input, "update_goal input");
  const status = requiredString(object.status, "status");
  if (!["active", "complete", "blocked", "cancelled"].includes(status)) {
    throw new Error("status is invalid.");
  }
  const consumedTokens = object.consumedTokens;
  if (
    consumedTokens !== undefined &&
    (!Number.isInteger(consumedTokens) || Number(consumedTokens) < 0)
  ) {
    throw new Error("consumedTokens must be a non-negative integer.");
  }
  const linked = object.linkedA2ATaskIds;
  if (linked !== undefined && (!Array.isArray(linked) || linked.some((item) => !optionalString(item)))) {
    throw new Error("linkedA2ATaskIds must contain non-empty strings.");
  }
  return {
    status: status as GoalToolInput["status"],
    statusReason: stringValue(object.statusReason, "statusReason"),
    ...(consumedTokens === undefined ? {} : { consumedTokens: Number(consumedTokens) }),
    ...(linked === undefined ? {} : { linkedA2ATaskIds: linked.map(String) }),
  };
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}
