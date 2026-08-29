import { z } from "zod";

import { taskPlanSchema } from "./turn.js";

export const BUSH_PLAN_STATE_PROTOCOL = "bush.plan_state.v1" as const;
export const BUSH_GOAL_PROTOCOL = "bush.goal.v1" as const;
export const BUSH_COORDINATION_EVENT_PROTOCOL =
  "bush.coordination_event.v1" as const;

export const GET_RUNTIME_PLAN_COMMAND = "runtime.get_plan" as const;
export const SET_RUNTIME_PLAN_COMMAND = "runtime.set_plan" as const;
export const GET_RUNTIME_GOAL_COMMAND = "runtime.get_goal" as const;
export const CREATE_RUNTIME_GOAL_COMMAND = "runtime.create_goal" as const;
export const UPDATE_RUNTIME_GOAL_COMMAND = "runtime.update_goal" as const;

export const planStateSchema = z.object({
  protocol: z.literal(BUSH_PLAN_STATE_PROTOCOL),
  sessionId: z.string().min(1),
  revision: z.number().int().positive(),
  plan: taskPlanSchema,
  updatedAt: z.string().min(1),
});

export type PlanState = z.infer<typeof planStateSchema>;

export const setRuntimePlanRequestSchema = z.object({
  sessionId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  plan: taskPlanSchema,
  scopeChangeReason: z.string().default(""),
});

export const runtimeCoordinationSessionSchema = z.object({
  sessionId: z.string().min(1),
});

export const goalStatusSchema = z.enum([
  "active",
  "complete",
  "blocked",
  "cancelled",
]);

export const goalStateSchema = z.object({
  protocol: z.literal(BUSH_GOAL_PROTOCOL),
  goalId: z.string().min(1),
  sessionId: z.string().min(1),
  objective: z.string().min(1),
  status: goalStatusSchema,
  statusReason: z.string(),
  tokenBudget: z.number().int().positive().optional(),
  consumedTokens: z.number().int().nonnegative(),
  linkedA2ATaskIds: z.array(z.string().min(1)),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
});

export type GoalState = z.infer<typeof goalStateSchema>;

export const createRuntimeGoalRequestSchema = z.object({
  goalId: z.string().min(1),
  sessionId: z.string().min(1),
  objective: z.string().min(1),
  tokenBudget: z.number().int().positive().optional(),
  linkedA2ATaskIds: z.array(z.string().min(1)).default([]),
});

export const updateRuntimeGoalRequestSchema = z.object({
  goalId: z.string().min(1),
  sessionId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  status: goalStatusSchema,
  statusReason: z.string(),
  consumedTokens: z.number().int().nonnegative(),
  linkedA2ATaskIds: z.array(z.string().min(1)),
});

const coordinationEventEnvelopeSchema = z.object({
  protocol: z.literal(BUSH_COORDINATION_EVENT_PROTOCOL),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  sessionId: z.string().min(1),
  createdAt: z.string().min(1),
});

export const coordinationEventSchema = z.discriminatedUnion("kind", [
  coordinationEventEnvelopeSchema.extend({
    kind: z.literal("plan_set"),
    payload: planStateSchema,
  }),
  coordinationEventEnvelopeSchema.extend({
    kind: z.literal("goal_set"),
    payload: goalStateSchema,
  }),
]);

export type CoordinationEvent = z.infer<typeof coordinationEventSchema>;
