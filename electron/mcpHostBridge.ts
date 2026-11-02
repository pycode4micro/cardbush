import { randomUUID } from 'node:crypto';

const protocol = 'cardbush.mcp_host.v1';
export type McpHostOperation = 'agents.list' | 'agents.delegate' | 'agents.read-child' | 'agents.guide-child' | 'agents.control' | 'ssh.workspace' | 'credentials.read' | 'credentials.write' | 'open-url' | 'browser.open-external' | 'browser.inherit-scope' | 'agent.desktop.tool' | 'elicitation' | 'authentication' | 'openai.access-token' | 'siwc.access-token' | 'automation.prepare-model' | 'subagent.models' | 'subagent.prepare-model' | 'automation.changed' | 'network.configuration' | 'network.route' | 'resources.acquire' | 'resources.release' | 'resources.track' | 'resources.ready';
type Request = { protocol: typeof protocol; type: 'request'; id: string; operation: McpHostOperation; payload: unknown };
type Response = { protocol: typeof protocol; type: 'response'; id: string; result?: unknown; error?: string; errorCode?: string; errorDetails?: Record<string, unknown> };
type Cancel = { protocol: typeof protocol; type: 'cancel'; id: string };
type Accepted = { protocol: typeof protocol; type: 'accepted'; id: string };
export type McpHostMessage = Request | Response | Cancel | Accepted;
export function isMcpHostMessage(value: unknown): value is McpHostMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.protocol === protocol && typeof item.id === 'string' && ['request', 'response', 'cancel', 'accepted'].includes(String(item.type));
}
/** Private Utility Process RPC. This channel is never forwarded to renderer runtime clients. */
export class McpHostBridge {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; onAccepted?: () => void }>();
  constructor(private readonly send: (message: McpHostMessage) => void) {}
  request<T>(operation: McpHostOperation, payload: unknown, signal?: AbortSignal, settleCancellation = false, onAccepted?: () => void): Promise<T> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const abort = () => { if (!settleCancellation) { this.pending.get(id)?.reject(new Error('MCP host request cancelled.')); this.pending.delete(id); } this.send({ protocol, type: 'cancel', id }); };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject, onAccepted });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ protocol, type: 'request', id, operation, payload });
    }).finally(() => { signal?.removeEventListener('abort', abort); this.pending.delete(id); });
  }
  receive(message: McpHostMessage) {
    if (message.type === 'accepted') {
      const pending = this.pending.get(message.id), callback = pending?.onAccepted;
      if (pending) pending.onAccepted = undefined;
      callback?.(); return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending?.reject(Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {},
      message.errorDetails ? { details: message.errorDetails } : {})); else pending?.resolve(message.result);
  }
}
export async function handleMcpHostRequest(message: Request, signal: AbortSignal,
  handle: (operation: McpHostOperation, payload: unknown, signal: AbortSignal, onAccepted: () => void) => Promise<unknown>,
  send?: (message: Accepted) => void): Promise<Response> {
  let accepted = false;
  const onAccepted = () => { if (!accepted && message.operation === 'agents.delegate') { accepted = true; send?.({ protocol, type: 'accepted', id: message.id }); } };
  try { return { protocol, type: 'response', id: message.id, result: await handle(message.operation, message.payload, signal, onAccepted) }; }
  catch (error) { return { protocol, type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error),
    ...((error as { code?: string })?.code === 'mcp_auth_required' || ['siwc_auth_required', 'siwc_unavailable', 'siwc_desktop_unavailable'].includes(String((error as { code?: string })?.code)) || String((error as { code?: string })?.code).startsWith('resource_')
      ? { errorCode: (error as { code: string }).code } : {}),
    ...(String((error as { code?: string })?.code).startsWith('resource_')
      ? { errorDetails: (error as { details?: Record<string, unknown> }).details } : {}) }; }
}
