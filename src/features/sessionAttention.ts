import type { SessionAttentionState } from '../types';

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
        return [[normalizedId, {
          sessionId: normalizedId,
          kind: kind as SessionAttentionState['kind'],
          title: String(item.title ?? '').trim(),
          body: String(item.body ?? '').trim(),
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

export function isCardbushForeground() {
  return document.visibilityState === 'visible' && document.hasFocus();
}
