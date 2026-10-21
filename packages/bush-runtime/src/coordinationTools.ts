import { randomUUID } from "node:crypto";

import {
  BUSH_TASK_PLAN_PROTOCOL,
  taskPlanWaitingKindSchema,
  type TaskPlan,
} from "@cardbush/bush-protocol";

import type { CoordinationStore } from "./coordinationStore.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { actionFieldSchema, validateActionFields } from "./toolActionRules.js";

export const UPDATE_TASK_PLAN_TOOL = "update_task_plan" as const;
export const UPDATE_GOAL_TOOL = "update_goal" as const;

const planActions = {
  get: { required: [] },
  replace: { required: ['nodes'], optional: ['expected_revision', 'explanation', 'active', 'scopeChangeReason'] },
  patch: { required: ['expected_revision'], optional: ['updates', 'append_nodes', 'remove_ids', 'explanation', 'active', 'scopeChangeReason'] },
} as const;

interface TaskPlanToolInput {
  action: keyof typeof planActions;
  expectedRevision?: number;
  updates?: Array<{ id: string; step?: string; status?: TaskPlan['nodes'][number]['status']; waitingFor?: string | null; waitingKind?: TaskPlan['nodes'][number]['waitingKind'] | null }>;
  appendNodes?: TaskPlan['nodes'];
  removeIds?: string[];
  nodes: TaskPlan["nodes"];
  explanation?: string;
  active?: boolean;
  scopeChangeReason: string;
}

interface GoalToolInput {
  status: "active" | "complete" | "blocked" | "cancelled";
  statusReason: string;
  consumedTokens?: number;
}

export function registerCoordinationTools(
  registry: ToolRegistry,
  store: CoordinationStore,
  options: {
    createPlanId?: () => string;
  } = {},
): void {
  const createPlanId = options.createPlanId ?? (() => `plan_${randomUUID()}`);

  if (!registry.resolve(UPDATE_TASK_PLAN_TOOL)) {
    registry.register<TaskPlanToolInput>({
      definition: {
        name: UPDATE_TASK_PLAN_TOOL,
        description:
          "Manage a visible task plan when it materially helps delivery or review. action=get reads the plan and revision and accepts no other fields. action=patch requires expected_revision and changes only supplied updates (by node ID), append_nodes, remove_ids or plan fields. action=replace (default) requires nodes; omitted explanation defaults to an empty string and active reflects whether any node is unfinished. Preserve node IDs; removing active-plan nodes requires scopeChangeReason. pending=not started; in_progress=current work (at most one); completed=finished. For waiting, set waitingFor to the concrete reason and waitingKind: user=needs user confirmation/input, background=awaits an already-started task, dependency=awaits a prerequisite step. Only user waits request the user's attention. Keep active true while unfinished. Updates are atomic; stale revisions require rereading. Reported progress is not independent verification and does not force another response.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: actionFieldSchema(planActions, 'replace'),
            expected_revision: { type: 'integer', minimum: 0 },
            updates: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['id'], properties: {
              id: { type: 'string', minLength: 1, pattern: '\\S' }, step: { type: 'string', minLength: 1, pattern: '\\S' },
              status: { enum: ['pending', 'in_progress', 'waiting', 'completed'] }, waitingFor: { type: ['string', 'null'], minLength: 1, pattern: '\\S' },
              waitingKind: { enum: [...taskPlanWaitingKindSchema.options, null] },
            } } },
            append_nodes: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['step', 'status'], properties: {
              step: { type: 'string', minLength: 1, pattern: '\\S' }, status: { enum: ['pending', 'in_progress', 'waiting', 'completed'] }, waitingFor: { type: 'string', minLength: 1, pattern: '\\S' },
              waitingKind: { enum: taskPlanWaitingKindSchema.options },
            } } },
            remove_ids: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, pattern: '\\S' } },
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
                  step: { type: "string", minLength: 1, pattern: '\\S' },
                  status: { enum: ["pending", "in_progress", "waiting", "completed"] },
                  waitingFor: { type: "string", minLength: 1, pattern: '\\S', description: "Required for waiting: the concrete external dependency or user action needed to continue." },
                  waitingKind: { enum: taskPlanWaitingKindSchema.options, description: "For waiting: user confirmation/input, an already-started background task, or a prerequisite step." },
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
        const input = context.input;
        if (input.action === 'get') return before ?? null;
        let nodes = input.nodes;
        if (input.action === 'patch') {
          if (!before) throw new Error('No plan exists; create it with action=replace.');
          const ids = new Set(before.plan.nodes.map(node => node.id));
          const updates = new Map(input.updates?.map(node => [node.id, node]));
          const removed = new Set(input.removeIds);
          if ((input.updates?.length ?? 0) !== updates.size || [...updates.keys(), ...removed].some(id => !ids.has(id)) || [...removed].some(id => updates.has(id))) throw new Error('Patch IDs must be unique existing nodes; do not update and remove the same node.');
          nodes = before.plan.nodes.filter(node => !removed.has(node.id!)).map(node => {
            const update = updates.get(node.id!);
            const next = { ...node, ...update };
            if (next.waitingFor === null || (update?.status && update.status !== 'waiting')) delete next.waitingFor;
            if (next.waitingKind === null || (update?.status && update.status !== 'waiting')) delete next.waitingKind;
            // A changed reason must not inherit a prior user-action classification accidentally.
            if (update?.waitingFor !== undefined && update.waitingFor !== node.waitingFor && update.waitingKind === undefined) delete next.waitingKind;
            return next as TaskPlan['nodes'][number];
          }).concat(input.appendNodes ?? []);
        }
        const plan: TaskPlan = {
          protocol: BUSH_TASK_PLAN_PROTOCOL,
          plan_id: before?.plan.plan_id ?? createPlanId(),
          session_id: context.sessionId,
          nodes,
          explanation: input.explanation ?? before?.plan.explanation ?? '',
          active: input.active ?? before?.plan.active ?? true,
        };
        const state = store.setPlan({
          sessionId: context.sessionId,
          expectedRevision: input.expectedRevision ?? before?.revision ?? 0,
          plan,
          scopeChangeReason: context.input.scopeChangeReason,
        });
        return state;
      },
    });
  }

  if (!registry.resolve(UPDATE_GOAL_TOOL)) {
    registry.register<GoalToolInput>({
      definition: {
        name: UPDATE_GOAL_TOOL,
        description:
          "Declare the current Goal status and reason. In Goal mode, the parent must call this before completing the Turn; children report to the parent instead. Use complete only when the objective is achieved, blocked when it cannot continue, and active when another Turn is needed.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["status", "statusReason"],
          properties: {
            status: { enum: ["active", "complete", "blocked", "cancelled"] },
            statusReason: { type: "string" },
            consumedTokens: { type: "integer", minimum: 0 },
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
        });
        return state;
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
    dispatch_scope: "session",
    mutating: true,
  };
}

function decodeTaskPlanInput(input: unknown): TaskPlanToolInput {
  const object = plainObject(input, "update_task_plan input");
  const action = validateActionFields(object, planActions, 'Plan', 'replace');
  if (object.scopeChangeReason !== undefined) stringValue(object.scopeChangeReason, 'scopeChangeReason');
  if (object.expected_revision !== undefined && (!Number.isSafeInteger(object.expected_revision) || Number(object.expected_revision) < 0)) throw new Error('expected_revision must be a nonnegative integer.');
  if (action === 'get') {
    return { action, nodes: [], explanation: '', active: true, scopeChangeReason: '' };
  }
  if (action === 'patch') {
    const array = (key: string): unknown[] => { const value = object[key] === undefined ? [] : object[key]; if (!Array.isArray(value) || value.length > 20) throw new Error(`${key} must contain at most 20 entries.`); return value; };
    const updates = array('updates').map(value => {
      const node = plainObject(value, 'updates');
      if (Object.keys(node).some(key => !['id', 'step', 'status', 'waitingFor', 'waitingKind'].includes(key))) throw new Error('Unknown plan patch field.');
      if (node.status !== undefined && (typeof node.status !== 'string' || !['pending', 'in_progress', 'waiting', 'completed'].includes(node.status))) throw new Error('Invalid node status.');
      return { id: requiredString(node.id, 'id'), ...(node.step !== undefined ? { step: requiredString(node.step, 'step') } : {}),
        ...(node.status !== undefined ? { status: node.status as TaskPlan['nodes'][number]['status'] } : {}),
        ...(node.waitingKind !== undefined ? { waitingKind: node.waitingKind === null ? null : taskPlanWaitingKindSchema.parse(node.waitingKind) } : {}),
        ...(node.waitingFor !== undefined ? { waitingFor: node.waitingFor === null ? null : requiredString(node.waitingFor, 'waitingFor') } : {}) };
    });
    const appended = array('append_nodes');
    if (appended.some(node => Object.hasOwn(plainObject(node, 'append_nodes'), 'id'))) throw new Error('New nodes receive IDs from Runtime.');
    const appendNodes = appended.length ? decodeTaskPlanInput({ nodes: appended, explanation: '', active: true }).nodes : [];
    const removeIds = array('remove_ids').map(id => requiredString(id, 'remove_ids'));
    if (new Set(removeIds).size !== removeIds.length) throw new Error('remove_ids must be unique.');
    return { action, expectedRevision: Number(object.expected_revision), nodes: [], updates, appendNodes, removeIds,
      explanation: object.explanation === undefined ? undefined : stringValue(object.explanation, 'explanation'),
      active: object.active === undefined ? undefined : booleanValue(object.active, 'active'), scopeChangeReason: optionalString(object.scopeChangeReason) ?? '' };
  }
  if (!Array.isArray(object.nodes) || object.nodes.length < 1 || object.nodes.length > 20) {
    throw new Error("nodes must contain between 1 and 20 Plan nodes.");
  }
  return {
    action: 'replace', expectedRevision: object.expected_revision as number | undefined,
    nodes: object.nodes.map((candidate, index) => {
      const node = plainObject(candidate, `nodes[${index}]`);
      if (Object.keys(node).some(key => !['id', 'step', 'status', 'waitingFor', 'waitingKind'].includes(key))) throw new Error('Unknown plan node field.');
      if (node.id !== undefined) stringValue(node.id, `nodes[${index}].id`);
      const status = stringValue(node.status, `nodes[${index}].status`);
      if (!["pending", "in_progress", "waiting", "completed"].includes(status)) {
        throw new Error(`nodes[${index}].status is invalid.`);
      }
      return {
        ...(optionalString(node.id) ? { id: optionalString(node.id) } : {}),
        step: requiredString(node.step, `nodes[${index}].step`),
        status: status as TaskPlanToolInput["nodes"][number]["status"],
        ...(node.waitingKind !== undefined ? { waitingKind: taskPlanWaitingKindSchema.parse(node.waitingKind) } : {}),
        ...(node.waitingFor !== undefined ? { waitingFor: requiredString(node.waitingFor, `nodes[${index}].waitingFor`) } : {}),
      };
    }),
    explanation: object.explanation === undefined ? '' : stringValue(object.explanation, "explanation"),
    active: object.active === undefined ? object.nodes.some(node => node.status !== 'completed') : booleanValue(object.active, "active"),
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
  return {
    status: status as GoalToolInput["status"],
    statusReason: stringValue(object.statusReason, "statusReason"),
    ...(consumedTokens === undefined ? {} : { consumedTokens: Number(consumedTokens) }),
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
