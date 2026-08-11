const desktopActionRunningStatuses = new Set([
  'queued',
  'running',
  'waiting_confirmation',
]);

const desktopActionSuccessfulStatuses = new Set(['completed']);
const desktopActionFailedStatuses = new Set(['failed', 'cancelled']);

export function desktopActionToolPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const status = String(payload.status ?? '').trim().toLowerCase();
  const state = desktopActionState(status);
  const metadata = {
    ...asRecord(payload.metadata),
    desktop_action: true,
    desktopAction: true,
    status,
    risk: payload.risk ?? null,
    progress: payload.progress ?? null,
    requires_confirmation: payload.requires_confirmation ?? false,
    audit_id: payload.audit_id ?? null,
    idempotency_key: payload.idempotency_key ?? null,
    undo_available: payload.undo_available ?? false,
    undo_token: payload.undo_token ?? null,
    verification: asRecord(payload.verification),
  };
  return {
    ...payload,
    state,
    metadata,
    ...(desktopActionSuccessfulStatuses.has(status) ? { success: true } : {}),
    ...(desktopActionFailedStatuses.has(status) ? { success: false } : {}),
  };
}

export function desktopActionState(status: unknown) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (desktopActionSuccessfulStatuses.has(normalized)) {
    return 'ok';
  }
  if (desktopActionFailedStatuses.has(normalized)) {
    return 'fail';
  }
  if (desktopActionRunningStatuses.has(normalized)) {
    return 'using';
  }
  return normalized || 'using';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
