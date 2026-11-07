import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';
import { assistantProfileSchema, type AssistantManagementSnapshot } from './assistantConversation.js';
import type { RuntimeSolutionSelection } from './solutionSelection.js';

export const FRIENDS_COMMAND = 'runtime.friends' as const;
export const FRIENDS_SESSION = 'your-friends' as const;
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
