import { z } from 'zod';
import type { ToolDefinition } from './tool.js' with { 'resolution-mode': 'import' };

/** Shared by the text assistant and every realtime voice provider. */
export const conversationalSubagentInput = z.object({
  prompt: z.string().trim().min(1).max(8000),
  task_id: z.string().trim().min(1).optional(),
  delivery: z.enum(['queue', 'insert']).optional().describe('With task_id: queue starts a later turn in the same child. insert interrupts current reasoning and continues that turn after any in-flight tools finish.'),
}).strict().refine(input => !input.delivery || input.task_id !== undefined, { message: 'delivery requires task_id' });
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
  description: 'Dispatch a user-requested task, or continue an existing child with task_id. Omit task_id only for new work. With task_id, choose delivery to queue or immediately insert a message. An explicit insert requires the exact active task. When delivery is omitted, a running child receives guidance and a finished child resumes its original conversation and execution host. Returns immediately, without blocking conversation. Briefly state intent, then call without an extra confirmation step. Include relevant context and constraints in prompt. Configured execution permissions remain enforced. A running or message_queued receipt is not a completed result.',
  inputSchema: z.toJSONSchema(conversationalSubagentInput),
}, {
  name: 'tasks',
  description: 'Inspect owned child tasks immediately or read one child conversation with action=conversation and task_ids. Follow nextCursor for more history. Private reasoning and tool logs are excluded. Running tasks notify automatically; continue talking without polling or waiting silently.',
  inputSchema: z.toJSONSchema(conversationalTaskInput, { io: 'input' }),
}];

export const assistantPageInputSchema = z.object({ content: z.string().trim().min(1).max(64000) }).strict();
export const assistantPageTool = {
  name: 'page_write', description: 'During a voice call, save requested written material to this conversation. For a report, share its verified file link and essential finding. Keep the report body, reasoning and tool logs out of the message.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 64000 } } },
};
