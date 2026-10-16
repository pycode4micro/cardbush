import { z } from 'zod';
import { sessionSnapshotSchema, sessionTurnStatusSchema, type SessionMessage, type SessionSnapshot } from './session.js';
import { taskPlanWaitingSchema } from './turn.js';
import { runtimeEventSchema } from './runtimeHost.js';
import { toolExecutionSummarySchema } from './tool.js';
import { authoredPromptContent } from './userPrompt.js';

export const LIST_RUNTIME_SESSION_SUMMARIES_COMMAND = 'runtime.list_session_summaries' as const;
export const GET_RUNTIME_SESSION_HISTORY_COMMAND = 'runtime.get_session_history' as const;
export const SESSION_HISTORY_PAGE_SIZE = 20;

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1), revision: z.number().int().nonnegative(),
  createdAt: z.string().min(1), updatedAt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turnCount: z.number().int().nonnegative(), firstUserText: z.string().max(4000), preview: z.string().max(512),
  latestTurn: z.object({ turnId: z.string(), turnSequence: z.number().int().positive(),
    status: sessionTurnStatusSchema, reason: z.string(), completedAt: z.string(),
    planWaiting: taskPlanWaitingSchema.optional() }).optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionHistoryCursorSchema = z.object({
  beforeTurnSequence: z.number().int().positive(), historyRevision: z.number().int().nonnegative(),
});
export type SessionHistoryCursor = z.infer<typeof sessionHistoryCursorSchema>;
export const sessionHistoryRequestSchema = z.object({
  sessionId: z.string().min(1), limit: z.number().int().min(1).max(100).default(SESSION_HISTORY_PAGE_SIZE),
  cursor: sessionHistoryCursorSchema.optional(),
});
export type SessionHistoryRequest = z.infer<typeof sessionHistoryRequestSchema>;
export const sessionHistoryPageSchema = z.object({
  summary: sessionSummarySchema, snapshot: sessionSnapshotSchema,
  nextCursor: sessionHistoryCursorSchema.nullable(), historyRevision: z.number().int().nonnegative(),
  beforeCreatedAt: z.string().optional(),
  toolExecutions: z.array(toolExecutionSummarySchema), contextCompactions: z.array(runtimeEventSchema),
});
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;

const internalUserNames = new Set(['runtime_context', 'tool_image_observation', 'task_plan_continuation', 'empty_stop_recovery', 'subagent_result']);
const internalDeveloperNames = new Set(['output_limit_continuation', 'context_pressure', 'context_compaction_correction']);
export function isInternalSessionMessage(entry: Pick<SessionMessage, 'message'>): boolean {
  const message = entry.message;
  return message.role === 'developer' ? !!message.name && internalDeveloperNames.has(message.name)
    : message.role === 'user' && (message.visibility === 'internal' || !!message.name && internalUserNames.has(message.name));
}

/** Bounded presentation excerpts, never model context or an alternative journal. */
export function sessionMessageExcerpt(entry: SessionMessage) {
  if (isInternalSessionMessage(entry) || entry.metadata?.runtimeMaintenance === 'context_compaction') return [];
  if (entry.message.role !== 'user' && entry.message.role !== 'assistant') return [];
  return [{ id: entry.messageId, role: entry.message.role, text: (entry.message.role === 'user'
    ? authoredPromptContent(entry.message.content, entry.metadata) : entry.message.content).slice(0, entry.message.role === 'user' ? 4000 : 512) }];
}

export function summarizeSession(snapshot: SessionSnapshot): SessionSummary {
  const superseded = new Set(snapshot.supersededMessageIds);
  const excerpts = snapshot.turns.flatMap(turn => turn.messages.flatMap(entry => superseded.has(entry.messageId) ? [] : sessionMessageExcerpt(entry)));
  const last = snapshot.turns.at(-1);
  return { sessionId: snapshot.sessionId, revision: snapshot.revision, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
    ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}), turnCount: snapshot.turns.length,
    firstUserText: excerpts.find(entry => entry.role === 'user')?.text ?? '',
    preview: [...excerpts].reverse().find(entry => entry.role === 'assistant')?.text ?? '',
    ...(last ? { latestTurn: { turnId: last.turnId, turnSequence: last.turnSequence, status: last.status,
      reason: last.reason, completedAt: last.completedAt, ...(last.planWaiting ? { planWaiting: last.planWaiting } : {}) } } : {}) };
}
