import { uiText, type MessageKey } from '@cardbush/platform/i18n';

export type SessionSubmission = { sessionId: string | null; requestId: string; text: string; modelId: string; attachments: string[] };
export function recoverSessionSubmission(saved: unknown, current: SessionSubmission): SessionSubmission {
  if (!saved || typeof saved !== 'object') return current;
  const prior = saved as Partial<SessionSubmission>;
  if (prior.sessionId !== current.sessionId || prior.text !== current.text || prior.modelId !== current.modelId ||
    typeof prior.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior.requestId) ||
    !Array.isArray(prior.attachments) || prior.attachments.length !== current.attachments.length ||
    prior.attachments.some((id, i) => id !== current.attachments[i])) return current;
  return { ...current, requestId: prior.requestId };
}

const messages: Record<string, MessageKey> = {
  SESSION_SERVICE_MAINTENANCE: 'web.sessionMaintenance',
  SESSION_AGENT_START_TIMEOUT: 'web.sessionStartupTimeout',
  SESSION_AGENT_START_FAILED: 'web.sessionStartupFailed',
  SESSION_AGENT_DATA_LOCKED: 'web.sessionDataLocked',
  SESSION_AGENT_MEMORY_LIMIT: 'web.sessionMemoryLimit',
  SESSION_AGENT_POLICY_NOT_READY: 'web.sessionPolicyNotReady',
  SESSION_HISTORY_CHANGED: 'web.sessionHistoryChanged',
  SESSION_HISTORY_TOO_LARGE: 'web.sessionHistoryTooLarge',
};
export function sessionServiceError(value: unknown, language?: string) {
  if (value instanceof Error && value.name === 'TimeoutError') return uiText(language)('web.sessionStartupTimeout');
  const message = value instanceof Error ? value.message : String(value ?? '');
  return messages[message] ? uiText(language)(messages[message]) : message;
}
export function isSessionServiceFailure(error: unknown) {
  const status: unknown = error instanceof Error ? Reflect.get(error, 'status') : undefined;
  return error instanceof TypeError || error instanceof Error &&
    (error.name === 'TimeoutError' || /^SESSION_AGENT_/.test(error.message) ||
      typeof status === 'number' && status >= 500);
}
