import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';

export const ASSISTANT_CONVERSATION_COMMAND = 'runtime.assistant_conversation' as const;
export const PERSONAL_ASSISTANT_SESSION = 'personal-assistant' as const;
export const conversationEntrySchema = z.object({
  id: z.string().min(1).max(220), role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(64000), createdAt: z.string().datetime(),
  source: z.enum(['voice', 'page', 'text', 'task']),
  visibility: z.enum(['conversation', 'internal']).default('conversation'),
  attachments: z.array(z.object({
    id: z.string(), name: z.string(), path: z.string().optional(), size: z.number().nonnegative().optional(),
    type: z.enum(['image', 'video', 'audio', 'document', 'folder']),
    execution: z.object({ connectionId: z.string().min(1), path: z.string().min(1) }).strict().optional(),
  }).strict()).max(64).optional(),
}).strict();
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;
export const assistantProfileSchema = z.object({
  name: z.string().trim().min(1).max(60).default('assistant'),
  persona: z.string().max(2000).default('温和、可靠、自然地交流。尊重用户的停顿和思考时间。'),
  targetAgent: z.string().max(200).default(''),
  microphoneMuted: z.boolean().default(false),
  outputMuted: z.boolean().default(false),
}).strict();
export type AssistantProfile = z.infer<typeof assistantProfileSchema>;
export const assistantConversationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), sessionId: z.string().min(1), after: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ action: z.literal('reset'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION) }).strict(),
  z.object({ action: z.literal('append'), sessionId: z.string().min(1), entry: conversationEntrySchema, generation: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('turn'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION),
    entry: conversationEntrySchema, parent: runtimeSessionTurnRequestSchema, profile: assistantProfileSchema, generation: z.number().int().nonnegative().optional() }).strict(),
]);
export const assistantPageTool = {
  name: 'page_write', description: 'Publish a useful Markdown message to this assistant conversation. Spoken replies are not automatically shown here. Use for requested written answers, links, examples and task results worth keeping. Only writes to the current conversation; returns immediately. Never publish internal reasoning or tool logs.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['content'], properties: { content: { type: 'string', minLength: 1, maxLength: 64000 } } },
};
export const assistantPageInputSchema = z.object({ content: z.string().trim().min(1).max(64000) }).strict();
