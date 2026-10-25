import { z } from 'zod';
import type { ToolDefinition } from './tool.js' with { 'resolution-mode': 'import' };

/** Shared by the text assistant and every realtime voice provider. */
export const conversationalSubagentInput = z.object({
  prompt: z.string().trim().min(1).max(8000),
  task_id: z.string().trim().min(1).optional(),
}).strict();
export const conversationalTaskInput = z.object({
  action: z.enum(['inspect', 'conversation']).default('inspect'),
  task_ids: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
  cursor: z.string().regex(/^\d+:\d+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'conversation' && value.task_ids?.length !== 1) context.addIssue({ code: 'custom', message: 'conversation requires one task_ids entry' });
  if (value.action !== 'conversation' && value.cursor !== undefined) context.addIssue({ code: 'custom', message: 'cursor requires action=conversation' });
});
export const conversationalSubagentTools: ToolDefinition[] = [{
  name: 'subagent',
  description: 'Dispatch a user-requested task, or continue an existing child with task_id. Omit task_id only for new work. With task_id, a running child receives guidance; a finished child resumes its original conversation and execution host. Returns immediately, without blocking conversation. Briefly state intent, then call without an extra confirmation step. Include relevant context and constraints in prompt. Configured execution permissions remain enforced. A running or message_queued receipt is not a completed result.',
  inputSchema: z.toJSONSchema(conversationalSubagentInput),
}, {
  name: 'tasks',
  description: 'Inspect owned child tasks immediately or read one child conversation with action=conversation and task_ids. Follow nextCursor for more history. Private reasoning and tool logs are excluded. Running tasks notify automatically; continue talking without polling or waiting silently.',
  inputSchema: z.toJSONSchema(conversationalTaskInput, { io: 'input' }),
}];
