import { z } from 'zod';
import { runtimeSessionTurnRequestSchema } from './session.js';
import type { AssistantManagementSnapshot } from './assistantConversation.js';
import type { RuntimeSolutionSelection } from './solutionSelection.js';

export const FRIENDS_COMMAND = 'runtime.friends' as const;
export const FRIENDS_SESSION = 'your-friends' as const;
export const friendInputSchema = z.object({ id: z.string().min(1).max(160), text: z.string().min(1).max(8000).refine(value => Boolean(value.trim())),
  createdAt: z.string().datetime(), relatesTo: z.string().min(1).max(160).optional() }).strict();
export const friendsProfileSchema = z.object({ name: z.string().max(60), language: z.string().min(1), timeZone: z.string().min(1),
  recognition: z.record(z.string(), z.string().max(8000)), confirmedAt: z.string().datetime() }).strict();
export const friendsCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('configure'), parent: runtimeSessionTurnRequestSchema, profile: friendsProfileSchema }),
  z.object({ action: z.literal('submit'), input: friendInputSchema }),
  z.object({ action: z.enum(['pause', 'resume', 'archive', 'restore']), eventId: z.string().min(1) }),
]);
export type FriendInput = z.infer<typeof friendInputSchema>;
export type FriendsProfile = z.infer<typeof friendsProfileSchema>;
export type FriendEventStatus = 'queued' | 'running' | 'watching' | 'waiting_user' | 'completed' | 'paused' | 'failed';
export interface FriendsWorkEvent {
  id: string; logicalKey: string; origin: 'user' | 'agent' | 'system'; title: string; intent: string;
  inputs: FriendInput[]; status: FriendEventStatus; archived: boolean; revision: number; createdAt: string; updatedAt: string;
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
