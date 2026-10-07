import { z } from 'zod';
import type { ToolDefinition } from './tool.js' with { 'resolution-mode': 'import' };

/** Shared by the text assistant and every realtime voice provider. */
export const conversationalSubagentInput = z.object({
  prompt: z.string().trim().min(1).max(8000),
  task_id: z.string().trim().min(1).optional(),
}).strict();
export const conversationalAwaitInput = z.object({
  task_ids: z.array(z.string().trim().min(1)).max(8).optional(),
}).strict();
export const conversationalReadInput = z.object({
  task_id: z.string().trim().min(1), cursor: z.string().regex(/^\d+:\d+$/).optional(),
}).strict();

export const conversationalSubagentTools: ToolDefinition[] = [{
  name: 'subagent',
  description: 'Dispatch a user-requested task, or continue an existing child with task_id. Omit task_id only for new work. With task_id, a running child receives guidance; a finished child resumes its original conversation and execution host. Returns immediately, without blocking conversation. Briefly state intent, then call without an extra confirmation step. Include relevant context and constraints in prompt. Configured execution permissions remain enforced. A running or message_queued receipt is not a completed result.',
  inputSchema: z.toJSONSchema(conversationalSubagentInput),
}, {
  name: 'await_subagents',
  description: 'In this conversational interface, return owned task states immediately and register asynchronous completion notifications. Never waits for completion. Omit task_ids for this conversation’s tasks. After watching, continue talking; do not poll or wait silently.',
  inputSchema: z.toJSONSchema(conversationalAwaitInput),
}, {
  name: 'read_subagent_conversation',
  description: 'Read an owned child’s ordered inputs and final answers. Follow nextCursor for more pages. Excludes internal reasoning and tool logs. Does not wait for completion or imply completion from partial history.',
  inputSchema: z.toJSONSchema(conversationalReadInput),
}];
