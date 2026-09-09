import { randomUUID } from 'node:crypto';

const protocol = 'cardbush.mcp_host.v1';
export type McpHostOperation = 'credentials.read' | 'credentials.write' | 'open-url' | 'elicitation' | 'authentication' | 'openai.access-token';
type Request = { protocol: typeof protocol; type: 'request'; id: string; operation: McpHostOperation; payload: unknown };
type Response = { protocol: typeof protocol; type: 'response'; id: string; result?: unknown; error?: string; errorCode?: 'mcp_auth_required' };
type Cancel = { protocol: typeof protocol; type: 'cancel'; id: string };
export type McpHostMessage = Request | Response | Cancel;
export function isMcpHostMessage(value: unknown): value is McpHostMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.protocol === protocol && typeof item.id === 'string' && ['request', 'response', 'cancel'].includes(String(item.type));
}
/** Private Utility Process RPC. This channel is never forwarded to renderer runtime clients. */
export class McpHostBridge {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(private readonly send: (message: McpHostMessage) => void) {}
  request<T>(operation: McpHostOperation, payload: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const abort = () => { this.pending.get(id)?.reject(new Error('MCP host request cancelled.')); this.pending.delete(id); this.send({ protocol, type: 'cancel', id }); };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ protocol, type: 'request', id, operation, payload });
    }).finally(() => { signal?.removeEventListener('abort', abort); this.pending.delete(id); });
  }
  receive(message: McpHostMessage) {
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending?.reject(Object.assign(new Error(message.error), message.errorCode ? { code: message.errorCode } : {})); else pending?.resolve(message.result);
  }
}
export async function handleMcpHostRequest(message: Request, signal: AbortSignal,
  handle: (operation: McpHostOperation, payload: unknown, signal: AbortSignal) => Promise<unknown>): Promise<Response> {
  try { return { protocol, type: 'response', id: message.id, result: await handle(message.operation, message.payload, signal) }; }
  catch (error) { return { protocol, type: 'response', id: message.id, error: error instanceof Error ? error.message : String(error),
    ...((error as { code?: string })?.code === 'mcp_auth_required' ? { errorCode: 'mcp_auth_required' as const } : {}) }; }
}
