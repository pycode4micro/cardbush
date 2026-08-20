import type { ExperimentalGoal, ExperimentalGoalStatus } from '../backend/api';
import type { ChatMessage, ChatToolExecution } from '../types';

type GoalDecision = 'continue' | 'complete' | 'blocked';

export interface GoalToolUpdate {
  goalId: string;
  sessionId: string;
  decision: GoalDecision;
  status: ExperimentalGoalStatus;
  reason: string;
}

export function goalToolUpdateFromExecution(
  execution: ChatToolExecution,
): GoalToolUpdate | null {
  if (toolBasename(execution.name) !== 'update_goal') {
    return null;
  }
  const output = parseRecord(execution.output);
  const update = recordFromUnknown(
    output.goal_update ??
      output.goalUpdate ??
      execution.metadata.goal_update ??
      execution.metadata.goalUpdate,
  );
  const decision = normalizeGoalDecision(update.decision ?? update.status);
  if (!decision) {
    return null;
  }
  const status = normalizeGoalStatus(update.status, decision);
  return {
    goalId: String(update.goal_id ?? update.goalId ?? '').trim(),
    sessionId: String(update.session_id ?? update.sessionId ?? '').trim(),
    decision,
    status,
    reason: String(update.reason ?? update.status_reason ?? update.statusReason ?? '').trim(),
  };
}

export function applyGoalToolUpdate(
  goal: ExperimentalGoal | null | undefined,
  update: GoalToolUpdate,
): ExperimentalGoal | null {
  if (!goal) {
    return null;
  }
  if (update.goalId && update.goalId !== goal.goalId) {
    return goal;
  }
  if (update.sessionId && update.sessionId !== goal.sessionId) {
    return goal;
  }
  const completedAt = update.status === 'active'
    ? undefined
    : goal.completedAt ?? new Date().toISOString();
  return {
    ...goal,
    status: update.status,
    statusReason: update.reason,
    revision: goal.revision + 1,
    updatedAt: new Date().toISOString(),
    completedAt,
  };
}

export function isGoalSelfCheckMessage(message: ChatMessage) {
  if (message.role !== 'user') {
    return false;
  }
  const metadata = message.metadata ?? {};
  if (metadata.goal_auto_continuation === true || metadata.goalAutoContinuation === true) {
    return true;
  }
  const runtimeLabel = String(
    metadata.runtime_user_label ??
      metadata.runtimeUserLabel ??
      recordFromUnknown(metadata.runtime).user_label ??
      recordFromUnknown(metadata.runtime).userLabel ??
      '',
  )
    .trim()
    .toLowerCase();
  return runtimeLabel === 'goal_self_check';
}

function normalizeGoalDecision(value: unknown): GoalDecision | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'continue' || normalized === 'complete' || normalized === 'blocked'
    ? normalized
    : null;
}

function normalizeGoalStatus(
  value: unknown,
  decision: GoalDecision,
): ExperimentalGoalStatus {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'active' ||
    normalized === 'complete' ||
    normalized === 'blocked' ||
    normalized === 'cancelled'
  ) {
    return normalized;
  }
  return decision === 'continue' ? 'active' : decision;
}

function toolBasename(value: string) {
  return value.trim().toLowerCase().split('.').pop() ?? '';
}

function parseRecord(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text.startsWith('{')) {
    return {};
  }
  try {
    return recordFromUnknown(JSON.parse(text));
  } catch {
    return {};
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
