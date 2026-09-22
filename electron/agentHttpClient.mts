import { z } from 'zod';
import { Agent as HttpAgent } from 'undici';
import { agentApiPath, type AgentEventFrame, type AgentEventRequest, type AgentInfo, type AgentOperation } from './agentTypes.js';

export class AgentNetworkError extends Error {}
export class AgentIdentityError extends Error {}
export class AgentHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function connectionError(error: unknown, url: URL): Error {
  const codes = new Set<string>();
  const seen = new Set<object>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 16) return;
    seen.add(value);
    const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.code === 'string') codes.add(item.code);
    if (item.name === 'TimeoutError') codes.add('ETIMEDOUT');
    visit(item.cause);
    if (Array.isArray(item.errors)) item.errors.slice(0, 16).forEach(visit);
  }
  visit(error);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let reason = '网络请求失败，请检查服务地址、网络和代理设置。';
  let code: string | undefined;
  const match = (...values: string[]) => values.find(value => codes.has(value));
  if ((code = match('ECONNREFUSED'))) {
    reason = local
      ? '连接被拒绝，请确认服务正在运行；远程 Agent 可在连接设置中启用 SSH 隧道自动连接。'
      : '连接被拒绝，请检查服务是否正在监听，以及反向代理和端口配置。';
  } else if ((code = match('ENOTFOUND', 'EAI_AGAIN'))) {
    reason = '无法解析服务域名，请检查地址和 DNS 设置。';
  } else if ((code = match('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'))) {
    reason = '请求超时，请检查服务、网络、代理或 SSH 隧道是否可用。';
  } else if ((code = match('CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'))) {
    reason = 'HTTPS 证书校验失败，请检查证书有效期、域名和受信任的证书链。';
  } else if ((code = match('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'))) {
    reason = '连接中断，请检查服务、反向代理或 SSH 隧道是否仍在运行。';
  }
  // Only expose the origin and known error codes, never request headers, payloads or raw causes.
  return new AgentNetworkError(`无法连接 Agent（${url.origin}）：${reason}${code ? ` [${code}]` : ''}`, { cause: error });
}

/** Address of the service, optionally behind a reverse proxy path prefix. */
export function agentBaseUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Use an HTTP(S) Agent address without embedded credentials.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote Agent connections require HTTPS. Use an HTTPS reverse proxy or an SSH tunnel to localhost.');
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\/api\/agent\/v1$/, '').replace(/\/mcp$/, '').replace(/\/$/, '') + '/';
  return url.href;
}
export class AgentHttpClient {
  readonly #closed = new AbortController();
  readonly #direct?: HttpAgent;
  #agentId?: string;
  constructor(readonly url: string, private readonly token: string, agentId?: string) {
    this.#agentId = agentId;
    // A local service or SSH listener must not send its token through an environment proxy.
    if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) this.#direct = new HttpAgent();
  }
  close() { this.#closed.abort(); void this.#direct?.destroy().catch(() => undefined); }
  async #fetch(path: string, init: RequestInit, signal?: AbortSignal) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    if (this.#agentId) headers.set('X-CardBush-Agent-ID', this.#agentId);
    const url = new URL(`${agentApiPath.slice(1)}/${path}`, this.url);
    const requestSignal = signal ? AbortSignal.any([this.#closed.signal, signal]) : this.#closed.signal;
    let response: Response;
    try { response = await fetch(url, { ...init, headers, redirect: 'error', signal: requestSignal, ...(this.#direct ? { dispatcher: this.#direct } : {}) }); }
    catch (error) {
      if (requestSignal.aborted && requestSignal.reason?.name !== 'TimeoutError') throw error;
      throw connectionError(error, url);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new AgentHttpError(data?.error?.message || `Agent HTTP request failed (${response.status}).`, response.status);
    }
    if (this.#agentId && response.headers.get('x-cardbush-agent-id') !== this.#agentId) {
      await response.body?.cancel(); throw new AgentIdentityError('Agent identity changed. Add a new connection after verifying the server.');
    }
    return response;
  }
  async info(): Promise<AgentInfo> {
    const response = await this.#fetch('info', { headers: { Accept: 'application/json' } }, AbortSignal.timeout(30_000));
    const info = z.object({ protocol: z.literal('cardbush.agent.v1'), apiVersion: z.literal(1),
      eventStreams: z.tuple([z.literal('sse'), z.literal('ndjson')]), id: z.string().min(1), name: z.string(), platform: z.string(),
      capabilities: z.object({ durableQueue: z.literal(true) }).passthrough(),
    }).passthrough().parse(await response.json()) as AgentInfo;
    if (this.#agentId && info.id !== this.#agentId) throw new AgentIdentityError('Agent identity changed. Add a new connection after verifying the server.');
    this.#agentId = info.id; return info;
  }
  async call(operation: AgentOperation, input: Record<string, unknown>) {
    const response = await this.#fetch('call', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ operation, input }) }, AbortSignal.timeout(60_000));
    const data = await response.json() as { result: unknown }; return data.result;
  }
  async *events(input: AgentEventRequest, signal: AbortSignal, format: 'sse' | 'ndjson' = 'sse'): AsyncIterable<AgentEventFrame> {
    const abort = new AbortController(); const combined = AbortSignal.any([signal, abort.signal]);
    let idle = setTimeout(() => abort.abort(new Error('Agent event stream timed out.')), 45_000);
    const query = new URLSearchParams({ sessionId: input.sessionId, turnId: input.turnId });
    if (input.afterSequence !== undefined) query.set('afterSequence', String(input.afterSequence));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const contentType = format === 'sse' ? 'text/event-stream' : 'application/x-ndjson';
      const response = await this.#fetch(`events?${query}`, { headers: { Accept: contentType } }, combined);
      if (!response.headers.get('content-type')?.startsWith(contentType) || !response.body) {
        await response.body?.cancel(); throw new Error('Invalid Agent event stream response.');
      }
      reader = response.body.getReader(); const decoder = new TextDecoder();
      let buffer = ''; let data: string[] = []; let ended = false;
      let sequence = input.afterSequence ?? 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        clearTimeout(idle); idle = setTimeout(() => abort.abort(new Error('Agent event stream timed out.')), 45_000);
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
          let raw: string | undefined;
          if (format === 'ndjson') { if (line) raw = line; }
          else if (line === '') { if (data.length) raw = data.join('\n'); data = []; }
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          if (data.join('\n').length > 8 * 1024 * 1024) throw new Error('Agent event frame is too large.');
          if (!raw) continue;
          const frame = JSON.parse(raw) as AgentEventFrame;
          if (frame.type === 'error') throw new Error(frame.error);
          if (frame.type === 'ready' && frame.agentId !== this.#agentId) throw new Error('Agent identity changed.');
          if (frame.type === 'event') {
            if (frame.event.sessionId !== input.sessionId || frame.event.turnId !== input.turnId || !Number.isSafeInteger(frame.event.sequence) || frame.event.sequence <= sequence) throw new Error('Invalid Agent event identity or sequence.');
            sequence = frame.event.sequence;
          }
          if (!['ready', 'event', 'heartbeat', 'end'].includes(frame.type)) throw new Error('Unknown Agent event frame.');
          yield frame;
          if (frame.type === 'end') { ended = true; break; }
        }
        if (ended) break;
        if (buffer.length > 8 * 1024 * 1024) throw new Error('Agent event frame is too large.');
      }
      if (!ended && !signal.aborted) throw new Error('Agent event stream disconnected; resume from the last event sequence.');
    } finally { clearTimeout(idle); abort.abort(); await reader?.cancel().catch(() => undefined); }
  }
}
