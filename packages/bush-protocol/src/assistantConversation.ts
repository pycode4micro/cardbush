import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';
import type { PlanState } from './coordination.js';
import type { RuntimePermissionRequest } from './runtimeHost.js';

/** Direct, bounded management; execution tools remain owned by children. */
export const ASSISTANT_MANAGEMENT_TOOLS = ['schedule_task', 'scheduled_results', 'search_skills', 'list_plugin_commands', 'mcp_search', 'update_task_plan', 'assistant_event'] as const;
export interface AssistantManagementSnapshot {
  plan?: PlanState;
  permissions: Array<{ permissionId: string; toolCallId: string; sessionId: string; turnId: string; request: RuntimePermissionRequest }>;
}

export const ASSISTANT_CONVERSATION_COMMAND = 'runtime.assistant_conversation' as const;
export const PERSONAL_ASSISTANT_SESSION = 'personal-assistant' as const;
export type AssistantWorkActivity = 'idle' | 'thinking' | 'working' | 'waiting' | 'retrying' | 'error';
export const ASSISTANT_REACTIONS = ['❤️', '👍', '👎', '‼️', '😂', '✅', '🎉', '🙏', '🤔', '👀', '🚀', '😮'] as const;
export const assistantReactionSchema = z.enum(ASSISTANT_REACTIONS);
export type AssistantReaction = z.infer<typeof assistantReactionSchema>;
export const assistantReactionsSchema = z.record(z.string(), assistantReactionSchema);
export const assistantReplySchema = z.object({ messageId: z.string().min(1).max(220), excerpt: z.string().trim().min(1).max(4000).optional() }).strict();
export const conversationEntrySchema = z.object({
  id: z.string().min(1).max(220), role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(64000), createdAt: z.string().datetime(),
  source: z.enum(['voice', 'page', 'text', 'task']),
  voiceMode: z.enum(['realtime', 'chained']).optional(),
  status: z.enum(['completed', 'interrupted']).optional(),
  visibility: z.enum(['conversation', 'internal']).default('conversation'),
  replyTo: assistantReplySchema.optional(),
  // Real input entries consumed by this response; transports must not guess from adjacency.
  responseTo: z.array(z.string().min(1).max(220)).max(256).optional(),
  eventId: z.string().min(1).max(220).optional(),
  originTurnId: z.string().min(1).max(220).optional(),
  botSourceRef: z.string().min(1).max(100).optional(),
  botRecipientKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  promptContext: z.array(z.object({ kind: z.enum(['preview-selection', 'editing-location', 'plugin-diagnostics']),
    content: z.string().max(256000), requestId: z.string().optional() }).strict()).max(16).optional(),
  attachments: z.array(z.object({
    id: z.string(), name: z.string(), path: z.string().optional(), size: z.number().nonnegative().optional(),
    type: z.enum(['image', 'video', 'audio', 'document', 'folder']),
    execution: z.object({ connectionId: z.string().min(1), path: z.string().min(1) }).strict().optional(),
  }).strict()).max(64).optional(),
}).strict();
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;
/** Historical speech entries were private, including some saved with default visibility. */
export function isAssistantPageMessage(entry: ConversationEntry) {
  return entry.visibility === 'conversation' && (entry.source !== 'voice' || entry.voiceMode !== undefined);
}
export const assistantEventPreferencesSchema = z.object({
  recognition: z.record(z.string(), z.string().max(8000)),
  beforeExecution: z.enum(['ask', 'within-scope']), report: z.enum(['always', 'important']),
  confirmedAt: z.string().datetime().optional(), notificationSourceRef: z.string().max(100).optional(),
}).strict();
export type AssistantEventPreferences = z.infer<typeof assistantEventPreferencesSchema>;
export const assistantProfileSchema = z.object({
  name: z.string().trim().min(1).max(60).default('assistant'),
  persona: z.string().max(2000).default(''),
  proactive: assistantEventPreferencesSchema.optional(),
  // Read old profiles without silently restoring a retired remote assistant host.
  targetAgent: z.string().max(200).default('').transform(() => ''),
  microphoneMuted: z.boolean().default(false),
  outputMuted: z.boolean().default(false),
}).strict();
export type AssistantProfile = z.infer<typeof assistantProfileSchema>;
export const assistantConversationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('activity'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION) }).strict(),
  z.object({ action: z.literal('read'), sessionId: z.string().min(1), after: z.number().int().nonnegative().default(0), language: z.string().max(80).optional() }).strict(),
  z.object({ action: z.literal('reset'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION) }).strict(),
  z.object({ action: z.literal('react'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION), messageId: z.string().min(1).max(220),
    reaction: assistantReactionSchema.nullable(), generation: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('stop'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION), generation: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('retry'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION),
    parent: runtimeSessionTurnRequestSchema, profile: assistantProfileSchema, generation: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('append'), sessionId: z.string().min(1), entry: conversationEntrySchema, generation: z.number().int().nonnegative().optional() }).strict(),
  z.object({ action: z.literal('turn'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION),
    entry: conversationEntrySchema, parent: runtimeSessionTurnRequestSchema, profile: assistantProfileSchema, generation: z.number().int().nonnegative().optional() }).strict(),
]);
