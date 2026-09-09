import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpHostOperation } from './mcpHostBridge';

export interface McpUserRequest {
  id: string; serverId: string; sessionId: string; turnId: string;
  params: Record<string, unknown>;
}
type Json = Record<string, unknown>;
/** Desktop owns encrypted credentials and pending forms, independently of the displayed conversation. */
export class McpDesktopHost {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { request: McpUserRequest; resolve: (value: unknown) => void }>();
  constructor(private readonly options: {
    path: string; encrypt: (value: string) => Buffer; decrypt: (value: Buffer) => string;
    openUrl: (url: string) => Promise<unknown>; changed: () => void;
  }) {}
  requests() { return [...this.pending.values()].map(item => structuredClone(item.request)); }
  async handle(operation: McpHostOperation, input: unknown, signal: AbortSignal): Promise<unknown> {
    const payload = object(input);
    if (operation === 'open-url') { await this.options.openUrl(checkedMcpUrl(payload.url)); return; }
    if (operation === 'credentials.read' || operation === 'credentials.write') {
      const key = String(payload.key);
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid MCP credential identity.');
      const work = this.queue.then(async () => {
        let data: Json = {};
        try { data = object(JSON.parse(this.options.decrypt(await readFile(this.options.path)))); }
        catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw new Error('MCP credentials could not be decrypted.'); }
        if (operation === 'credentials.read') return data[key];
        if (payload.value === undefined) delete data[key]; else data[key] = payload.value;
        const encrypted = this.options.encrypt(JSON.stringify(data));
        await mkdir(dirname(this.options.path), { recursive: true });
        const temp = `${this.options.path}.${randomUUID()}.tmp`;
        try { await writeFile(temp, encrypted, { mode: 0o600 }); await rename(temp, this.options.path); }
        finally { await rm(temp, { force: true }); }
      });
      this.queue = work.catch(() => undefined);
      return work;
    }
    if (operation !== 'elicitation' && operation !== 'authentication') throw new Error('Unknown MCP host operation.');
    const params = operation === 'authentication' ? { mode: 'authentication', toolCallId: payload.toolCallId } : object(payload.params);
    if (operation === 'elicitation' && params.mode !== undefined && params.mode !== 'form' && params.mode !== 'url') throw new Error('Unsupported MCP elicitation mode.');
    if (params.mode === 'url') checkedMcpUrl(params.url);
    if (JSON.stringify(params).length > 128 * 1024) throw new Error('MCP form exceeds the size limit.');
    return this.request({ serverId: String(payload.serverId), sessionId: String(payload.sessionId), turnId: String(payload.turnId), params }, signal);
  }
  /** Host-created credential form. Its response stays on the desktop side of RPC. */
  async requestClientCredentials(input: { serverId: string; endpoint: string; clientId: string }, signal: AbortSignal): Promise<{ action: string; content?: { clientId: string; clientSecret: string } }> {
    const endpoint = checkedMcpUrl(input.endpoint);
    return await this.request({ serverId: input.serverId, sessionId: '', turnId: '', params: {
      mode: 'client_credentials', endpoint,
      requestedSchema: { type: 'object', required: ['clientId', 'clientSecret'], properties: {
        clientId: { type: 'string', title: 'OAuth Client ID', default: input.clientId, minLength: 1, maxLength: 4096 },
        clientSecret: { type: 'string', title: 'OAuth Client Secret', minLength: 1, maxLength: 8192 },
      } },
    } }, signal) as { action: string; content?: { clientId: string; clientSecret: string } };
  }
  private request(input: Omit<McpUserRequest, 'id'>, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = randomUUID();
    const request = { ...input, id };
    const abort = () => { void this.answer(id, { action: 'cancel' }); };
    return new Promise(resolve => {
      this.pending.set(id, { request, resolve });
      signal.addEventListener('abort', abort, { once: true });
      this.options.changed();
    }).finally(() => { signal.removeEventListener('abort', abort); this.pending.delete(id); this.options.changed(); });
  }
  async answer(id: string, value: unknown) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    const answer = object(value);
    if (!['accept', 'decline', 'cancel'].includes(String(answer.action))) throw new Error('Invalid MCP form response.');
    if (answer.action === 'accept' && pending.request.params.mode === 'client_credentials') {
      const content = object(answer.content);
      if (typeof content.clientId !== 'string' || !content.clientId.trim() || content.clientId.length > 4096 || /^<[^<>]+>$/.test(content.clientId.trim()) ||
          typeof content.clientSecret !== 'string' || !content.clientSecret.trim() || content.clientSecret.length > 8192) throw new Error('Enter a valid OAuth client ID and client secret.');
    } else if (answer.action === 'accept' && !['url', 'authentication'].includes(String(pending.request.params.mode))) {
      const { validateMcpFormResponse } = await import('@cardbush/bush-mcp-client');
      await validateMcpFormResponse(object(pending.request.params.requestedSchema), object(answer.content));
      if (this.pending.get(id) !== pending) return false;
    }
    this.pending.delete(id);
    pending.resolve({ action: answer.action, ...(answer.action === 'accept' && !['url', 'authentication'].includes(String(pending.request.params.mode)) ? { content: object(answer.content) } : {}) });
    this.options.changed();
    return true;
  }
  async openRequestUrl(id: string) {
    const pending = this.pending.get(id);
    if (!pending || pending.request.params.mode !== 'url') throw new Error('This MCP URL request is no longer pending.');
    await this.options.openUrl(checkedMcpUrl(pending.request.params.url));
  }
}
export function checkedMcpUrl(value: unknown): string {
  const url = new URL(String(value));
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('MCP authorization links must use HTTPS or local HTTP.');
  return url.toString();
}
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP host payload.'); return value as Json; }
