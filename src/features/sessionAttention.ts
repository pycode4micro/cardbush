import { uiText } from '../i18n';
import type { AppLanguage, SessionAttentionState } from '../types';
import { isWindowVisible } from '../shared/windowVisibility';

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
          !sessionAttentionNeedsNotification({ kind, interactionId: item.interactionId }) ||
          !Number.isFinite(updatedTime) ||
          now - updatedTime > maxPersistedAttentionAgeMs
        ) return [];
        return [[normalizedId, {
          sessionId: normalizedId,
          kind: kind as SessionAttentionState['kind'],
          title: String(item.title ?? '').trim(),
          body: String(item.body ?? '').trim(),
          ...(kind === 'interaction' ? { interactionId: String(item.interactionId).trim() } : {}),
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

export function sessionAttentionNeedsNotification(attention: { kind: unknown; interactionId?: unknown }) {
  return attention.kind === 'completed' || attention.kind === 'error'
    || (attention.kind === 'interaction' && typeof attention.interactionId === 'string' && Boolean(attention.interactionId.trim()));
}

export function sessionAttentionLabel(attention: Pick<SessionAttentionState, 'kind'>, language: AppLanguage) {
  if (attention.kind === 'interaction') return uiText(language)('sessionAttention.confirmationPending');
  if (attention.kind === 'error') return uiText(language)('sessionAttention.executionFailed');
  return uiText(language)('sessionAttention.completeNotViewed');
}

export function isCardbushForeground() {
  return isWindowVisible() && document.hasFocus();
}
