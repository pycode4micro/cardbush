import { z } from "zod";

import { sessionUsageSchema } from "./session.js";
import { remoteObservationSchema } from './remoteInteraction.js';

export const BUSH_SUBAGENT_TASK_PROTOCOL = "bush.subagent_task.v1" as const;
export const BUSH_SUBAGENT_EVENT_PROTOCOL = "bush.subagent_event.v1" as const;
export const remoteWorkerSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), name: z.string().min(1).max(160), instructions: z.string().min(1).max(40000),
}).strict();
export const GET_RUNTIME_SUBAGENT_TASK_COMMAND = "runtime.get_subagent_task" as const;
export const LIST_RUNTIME_SUBAGENT_TASKS_COMMAND = "runtime.list_subagent_tasks" as const;

export const subagentTaskStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
  "unavailable",
]);

export const subagentTaskSchema = z.object({
  protocol: z.literal(BUSH_SUBAGENT_TASK_PROTOCOL),
  taskId: z.string().min(1),
  parentSessionId: z.string().min(1),
  parentTurnId: z.string().min(1),
  childSessionId: z.string().min(1),
  childTurnId: z.string().min(1),
  prompt: z.string().min(1),
  inheritContext: z.boolean(),
  background: z.boolean().optional(),
  inheritedMessageCount: z.number().int().nonnegative(),
  origin: z.enum(["subagent", "team"]).optional(),
  teamId: z.string().min(1).optional(),
  teamMemberId: z.string().min(1).optional(),
  agentProfileId: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  resumedFromTaskId: z.string().min(1).optional(),
  queuedAfterTaskId: z.string().min(1).optional(),
  executionStartedAt: z.string().min(1).optional(),
  remote: z.object({ connectionId: z.string().min(1), agentId: z.string().optional(), worker: remoteWorkerSchema.optional() }).optional(),
  observation: remoteObservationSchema.optional(),
  observationError: z.string().optional(),
  phase: z.enum(["discussion", "execution"]).optional(),
  status: subagentTaskStatusSchema,
  finalResponse: z.string(),
  errorMessage: z.string(),
  usage: sessionUsageSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
});

export type SubagentTask = z.infer<typeof subagentTaskSchema>;

export interface RemoteSubagentRequest {
  connectionId: string; agentId?: string; taskId: string;
  parentSessionId: string; parentTurnId: string; sessionId: string; turnId: string;
  prompt: string; permissionMode: 'task_free' | 'user_free' | 'all_free'; language: string;
  permissionRouting?: 'user' | 'parent';
  worker?: z.infer<typeof remoteWorkerSchema>;
  queue?: boolean;
}
export interface RemoteSubagentResult {
  status: 'completed' | 'failed' | 'stopped' | 'unavailable'; finalResponse: string; errorMessage: string; usage: SubagentTask['usage'];
}

export const subagentEventSchema = z.object({
  protocol: z.literal(BUSH_SUBAGENT_EVENT_PROTOCOL),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  parentSessionId: z.string().min(1),
  taskId: z.string().min(1),
  createdAt: z.string().min(1),
  task: subagentTaskSchema,
});

export type SubagentEvent = z.infer<typeof subagentEventSchema>;

export const subagentTaskIdentitySchema = z.object({
  parentSessionId: z.string().min(1),
  taskId: z.string().min(1),
});

export const subagentTaskListRequestSchema = z.object({
  parentSessionId: z.string().min(1),
  parentTurnId: z.string().min(1).optional(),
});
