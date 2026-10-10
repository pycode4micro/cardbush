/** Classify structured failures, never keywords in provider prose. */
export type ModelFailureAction = 'retry' | 'compact_context' | 'repair_tool_call' | 'stop';
export interface ModelFailureFacts { code: string; status?: number; retryable?: boolean }

const NON_RETRYABLE_CODES = new Set([
  'invalid_api_key', 'authentication_error', 'permission_error', 'invalid_request_error', 'invalid_prompt',
]);
const STOP_CODES = new Set(['request_aborted', 'chatgpt_account_changed',
  'insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active']);
const TRANSIENT_CODES = new Set([
  'server_error', 'internal_server_error', 'api_error', 'overloaded_error', 'service_unavailable',
  'rate_limit_exceeded', 'rate_limit_error', 'request_timeout', 'timeout',
  'provider_timeout', 'provider_connection_error', 'provider_stream_incomplete', 'provider_terminal_event_missing',
]);

export function isToolCallValidationFailure(error: { code: string }): boolean {
  return ['incomplete_tool_call', 'provider_tool_call_incomplete',
    'provider_tool_call_changed', 'provider_tool_search_invalid'].includes(error.code);
}

export function isContextLengthFailure(error: { code: string; status?: number }): boolean {
  return (error.status === undefined || [400, 413, 422].includes(error.status)) &&
    ['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded', 'input_tokens_exceeded'].includes(error.code);
}

export function modelFailureAction(error: ModelFailureFacts): ModelFailureAction {
  if (isContextLengthFailure(error)) return 'compact_context';
  if (isToolCallValidationFailure(error) && (error.status === undefined || [400, 422].includes(error.status))) return 'repair_tool_call';
  if (STOP_CODES.has(error.code)) return 'stop';
  // HTTP status is authoritative, including when an SDK supplies a socket-like
  // code or a caller accidentally sets retryable=true on a permanent refusal.
  if (error.status !== undefined) {
    // A provider may further refuse retry (for example a plan entitlement limit).
    // It cannot turn a permanent HTTP status into a transient failure.
    return error.retryable !== false && ([408, 409, 429].includes(error.status) ||
      (error.status >= 500 && error.status <= 599 && ![501, 505].includes(error.status))) ? 'retry' : 'stop';
  }
  if (NON_RETRYABLE_CODES.has(error.code)) return 'stop';
  return (error.retryable ?? TRANSIENT_CODES.has(error.code)) ? 'retry' : 'stop';
}
