import { uiText } from '@cardbush/platform/i18n';
import { sessionServiceError } from './sessionService';
export type User = { id: string; username: string; display_name: string; role: string; is_active: boolean; department_id: string | null; department_name?: string | null; company_id?: string | null; company_name?: string | null; deleted_at?: string | null };
export type Company = { id: string; name: string; description: string; department_count: number; member_count: number };
export type Department = { id: string; name: string; description: string | null; company_id: string; company_name: string; is_active: boolean; member_count: number };
export type Organization = { companies: Company[]; departments: Department[] };
export type Identity = { user: User; csrf: string; models: Array<{ id: string; name: string }>; defaultModelId: string; toolsEnabled: boolean };
export type Conversation = { id: string; title: string; pinned: boolean; archived: boolean; updated_at: string; created_at: string };
export type ConversationPage = { items: Conversation[]; nextCursor: string | null };
export type Job = { id: string; turnId: string; text: string; status: string; modelId: string; createdAt?: string; completedAt?: string; error?: string; attachments?: import('./AgentWidgets').Attachment[] };
export type Message = { messageId: string; turnId?: string; createdAt?: string; messageIndex?: number; message: { role: string; content: string; visibility?: string; name?: string; toolCalls?: Array<{ id: string; name: string; arguments?: unknown }>; toolCallId?: string }; metadata?: Record<string, unknown> };
export type State = { history?: { nextCursor: string | null }; toolExecutions?: import('@cardbush/bush-protocol').ToolExecutionSummary[]; solutions?: import('./AgentWidgets').Solution[]; conversation: Conversation; jobs: Job[]; snapshot: { turns: Array<{ turnId: string; status?: string; reason?: string; createdAt?: string; completedAt?: string; messages: Message[] }>; supersededMessageIds?: string[] } | null };
export type Frame = { type: string; event?: { sequence: number; turnId: string; kind: string; createdAt?: string; payload: { messageId?: string; assistantMessageId?: string; ordinal?: number; finalResponse?: boolean; toolCallId?: string; toolName?: string; display?: unknown; error?: { message?: string }; reason?: string; segmentId?: string; delta?: string; content?: string; status?: string } }; error?: string };
let csrf = '';
let identityEpoch = 0;
let accountId = '';
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** getRandomValues is available on the existing LAN HTTP site as well as HTTPS. */
export function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function setIdentity(identity: Identity | null) { csrf = identity?.csrf ?? ''; accountId = identity?.user.id ?? ''; identityEpoch++; }
export async function api<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const epoch = identityEpoch;
  const sessionRequest = /^\/sessions(?:$|\?|\/[^/]+(?:\?|$|\/messages$|\/status(?:\?|$)))/.test(path);
  const deadline = sessionRequest ? AbortSignal.timeout(70_000) : undefined;
  const requestSignal = deadline && signal ? AbortSignal.any([signal, deadline]) : deadline ?? signal;
  const response = await fetch(`/api/web/v1${path}`, { method, credentials: 'same-origin', signal: requestSignal,
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(accountId && !path.startsWith('/auth/') ? { 'X-CardBush-User': accountId } : {}), ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login') && epoch === identityEpoch) window.dispatchEvent(new Event('cardbush:logged-out'));
    throw new ApiError(sessionServiceError(body?.error) || uiText()("web.connectionFailedPleaseTryAgainLater"), response.status);
  }
  return body as T;
}
export function watch(sessionId: string, turnId: string, listener: (frame: Frame) => void, afterSequence?: number) {
  let cursor = afterSequence ?? -1;
  let source: EventSource, retry: ReturnType<typeof setTimeout> | undefined, closed = false;
  const connect = () => {
    if (closed) return;
    source = new EventSource(`/api/web/v1/sessions/${sessionId}/events?turnId=${encodeURIComponent(turnId)}${cursor < 0 ? '' : `&afterSequence=${cursor}`}`);
    source.onmessage = event => {
      const frame = JSON.parse(event.data) as Frame;
      if (frame.event) { if (frame.event.sequence <= cursor) return; cursor = frame.event.sequence; }
      listener(frame);
      if (frame.type === 'end') { closed = true; source.close(); }
      else if (frame.type === 'error' && !closed) {
        source.close(); retry = setTimeout(connect, 1500);
      }
    };
    source.onerror = () => { if (!closed) listener({ type: 'reconnecting' }); };
  };
  connect();
  return () => { closed = true; clearTimeout(retry); source?.close(); };
}
