import { taskPlanWaitingSchema } from '@cardbush/bush-protocol';
import type { AppLanguage, SessionAttentionState } from '../types';
import { taskPlanWaitingLabel } from './taskPlanWaiting';

const sessionAttentionStorageKey = 'cardbush_session_attention_v1';
const maxPersistedAttentionAgeMs = 30 * 24 * 60 * 60 * 1000;

export function readSessionAttentionState(): Record<string, SessionAttentionState> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(sessionAttentionStorageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([sessionId, value]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        const normalizedId = String(item.sessionId ?? sessionId).trim();
        const kind = String(item.kind ?? '').trim().toLowerCase();
        const updatedAt = String(item.updatedAt ?? '').trim();
        const updatedTime = Date.parse(updatedAt);
        if (
          !normalizedId ||
          !['completed', 'waiting', 'error'].includes(kind) ||
          !Number.isFinite(updatedTime) ||
          now - updatedTime > maxPersistedAttentionAgeMs
        ) return [];
        const waitingKind = taskPlanWaitingSchema.shape.kind.safeParse(item.waitingKind);
        return [[normalizedId, {
          sessionId: normalizedId,
          kind: kind as SessionAttentionState['kind'],
          title: String(item.title ?? '').trim(),
          // Legacy waiting badges did not distinguish user action from dependencies.
          body: kind === 'waiting' && !waitingKind.success ? '' : String(item.body ?? '').trim(),
          ...(kind === 'waiting' ? { waitingKind: waitingKind.success ? waitingKind.data : 'unspecified' as const } : {}),
          ...(kind === 'waiting' && waitingKind.success && waitingKind.data === 'user' && typeof item.interactionId === 'string'
            ? { interactionId: item.interactionId } : {}),
          turnId: String(item.turnId ?? '').trim() || undefined,
          updatedAt,
        } satisfies SessionAttentionState]];
      }),
    );
  } catch {
    return {};
  }
}

export function persistSessionAttentionState(
  state: Record<string, SessionAttentionState>,
) {
  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(sessionAttentionStorageKey);
      return;
    }
    window.localStorage.setItem(sessionAttentionStorageKey, JSON.stringify(state));
  } catch {
    // Attention hints should never interrupt the chat workflow.
  }
}

export function sessionAttentionNeedsNotification(attention: Pick<SessionAttentionState, 'kind' | 'waitingKind'>) {
  return attention.kind !== 'waiting' || attention.waitingKind === 'user';
}

export function sessionAttentionLabel(attention: Pick<SessionAttentionState, 'kind' | 'waitingKind'>, language: AppLanguage) {
  if (attention.kind === 'waiting') return taskPlanWaitingLabel(attention.waitingKind, language);
  if (attention.kind === 'error') return language === 'zh' ? '需要关注' : 'Needs attention';
  return language === 'zh' ? '已完成，待查看' : 'Complete, not viewed';
}

export function isCardbushForeground() {
  return document.visibilityState === 'visible' && document.hasFocus();
}
