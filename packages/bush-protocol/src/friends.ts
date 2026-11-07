import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';
import { assistantProfileSchema, type AssistantManagementSnapshot } from './assistantConversation.js';
import type { RuntimeSolutionSelection } from './solutionSelection.js';

export const FRIENDS_COMMAND = 'runtime.friends' as const;
export const FRIENDS_SESSION = 'your-friends' as const;
export const eventRecurrenceSchema = z.object({
  unit: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']),
  interval: z.int().positive().describe('Repeat every this many units. Use 1 for every unit.'),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/)
    .refine(value => z.iso.date().safeParse(value.slice(0, 10)).success, 'Use a valid calendar date.')
    .describe('First eligible local date and wall time, YYYY-MM-DDTHH:mm, in timeZone.'),
  timeZone: z.string().min(1).max(100).refine(zone => {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; }
    catch { return false; }
  }, 'Use an IANA time zone such as Asia/Shanghai, UTC, or an explicit UTC offset.'),
  weekdays: z.array(z.int().min(1).max(7)).min(1).max(7).optional()
    .describe('Weekly rules only. ISO weekdays, Monday=1 through Sunday=7. Defaults to the start weekday.'),
}).strict().refine(rule => !rule.weekdays || (rule.unit === 'week' && new Set(rule.weekdays).size === rule.weekdays.length),
  'Use distinct weekdays with a weekly rule.');
export type EventRecurrence = z.infer<typeof eventRecurrenceSchema>;
const predicateCode = z.string().min(1).max(8000).describe('Synchronous JavaScript function body. Use observation, return exactly 0 or 1.');
export const eventPredicateSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('interval'), everySeconds: z.int().min(1).max(86400), code: predicateCode }).strict(),
  z.object({ source: z.literal('runtime'), code: predicateCode }).strict(),
  z.object({ source: z.literal('collector'), everySeconds: z.int().min(1).max(86400),
    taskId: z.string().min(1).max(220).describe('Completed local child task which verified this source.'),
    tool: z.string().min(1).max(200).describe('Exact read tool or terminal_exec used for the successful sample.'),
    toolCallId: z.string().min(1).max(220).optional().describe('Required if several successful calls to this tool exist in the child turn.'),
    once: z.literal(true).optional().describe('Use only for an explicitly one-time first match. Omit for a continuing watch.'),
    initial: z.enum(['baseline', 'notify']).optional().describe('Default baseline seeds the verified sample. notify allows the first matching poll to deliver.'),
    code: predicateCode }).strict(),
]);
export type EventPredicate = z.infer<typeof eventPredicateSchema>;
export const friendInputSchema = z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(8000).refine(value => Boolean(value.trim())),
  createdAt: z.string().datetime(), relatesTo: z.string().min(1).max(160).optional() }).strict();
const webhookText = z.string().min(1).max(32000).refine(value => Boolean(value.trim()));
export const friendEvidenceSchema = friendInputSchema.extend({ text: webhookText, authoredBy: z.literal('assistant').optional(), sourceMessageId: z.string().max(220).optional(), botSourceRef: z.string().max(100).optional() });
export const friendDeliveryRouteSchema = z.object({ sourceRef: z.string().min(1).max(100), recipientKey: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const friendsWebhookReceiptSchema = z.object({ status: z.enum(['pending', 'completed', 'failed', 'interrupted']), reply: z.string(), errorCode: z.string().optional() }).strict();
export type FriendsWebhookReceipt = z.infer<typeof friendsWebhookReceiptSchema>;
export const friendsProfileSchema = z.object({ name: z.string().max(60), language: z.string().min(1), timeZone: z.string().min(1),
  recognition: z.record(z.string(), z.string().max(8000)), confirmedAt: z.string().datetime(),
  interactionPreferences: z.object({ beforeExecution: z.enum(['ask', 'within-scope']), report: z.enum(['always', 'important']) }).strict().optional(),
}).strict();
export const friendsCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('binding') }),
  z.object({ action: z.literal('targets') }),
  z.object({ action: z.literal('preferences') }),
  z.object({ action: z.literal('configure'), parent: runtimeSessionTurnRequestSchema, profile: friendsProfileSchema, assistant: assistantProfileSchema.optional() }),
  z.object({ action: z.literal('submit'), input: friendInputSchema }),
  z.object({ action: z.literal('receive_webhook'), receiptId: z.string().uuid(), createdAt: z.string().datetime(), text: webhookText, recipientKey: friendDeliveryRouteSchema.shape.recipientKey }).strict(),
  z.object({ action: z.literal('read_webhook'), receiptId: z.string().uuid() }).strict(),
  z.object({ action: z.enum(['pause', 'resume', 'archive', 'restore', 'delete']), eventId: z.string().min(1) }),
]);
export type FriendInput = z.infer<typeof friendInputSchema>;
export type FriendsProfile = z.infer<typeof friendsProfileSchema>;
export type FriendEventStatus = 'queued' | 'running' | 'watching' | 'waiting_user' | 'completed' | 'paused' | 'failed';
export interface FriendsWorkEvent {
  id: string; logicalKey: string; origin: 'user' | 'agent' | 'system'; title: string; intent: string;
  subscription?: true;
  recurrence?: EventRecurrence;
  trigger?: EventPredicate;
  triggerMatched?: boolean;
  triggerKey?: string;
  collectorVersion?: string;
  collectorFailures?: number;
  currentInputId?: string;
  reminderText?: string;
  inputs: z.infer<typeof friendEvidenceSchema>[]; deliveryRoute?: z.infer<typeof friendDeliveryRouteSchema>; status: FriendEventStatus; archived: boolean; revision: number; createdAt: string; updatedAt: string;
  result?: { text: string; turnId: string; createdAt: string };
  decision?: { disposition: 'completed' | 'watching' | 'waiting_user'; basis: string; habitRefs: Array<{ id: string; revision: number }> };
  error?: string; interruptedTurnId?: string;
}
export type FriendsDetection = { id: string; eventId: string; at: string };
export interface FriendsConnectionStatus { configured: boolean; pending: number; watching: number; active: { eventId: string; turnId: string } | null }
export interface FriendsSnapshot {
  configured: boolean; events: FriendsWorkEvent[]; detections: FriendsDetection[];
  workspaceDir?: string;
  active?: { eventId: string; turnId: string };
  permissions: AssistantManagementSnapshot['permissions']; solutions: RuntimeSolutionSelection[];
}
