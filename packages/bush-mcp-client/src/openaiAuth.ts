import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { OPENAI_HOSTED_PROTOCOL, type OpenAiAccess } from '@cardbush/bush-protocol';

export type OpenAiTokens = { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string; token_type?: string };
export type StoredOpenAiTokens = OpenAiTokens & { expiresAt?: number };
export class OpenAiAuthError extends Error {
  readonly code = 'mcp_auth_required';
  constructor(message = 'Sign in to OpenAI in CardBush plugin settings.') { super(message); }
}
export class OpenAiHttpError extends Error {
  constructor(readonly status: number) { super(`OpenAI request failed (HTTP ${status}).`); }
}
export async function readOpenAiJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OpenAI returned an empty response.');
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('OpenAI response exceeds the size limit.');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('OpenAI returned an invalid JSON response.'); }
  } finally { await reader.cancel().catch(() => {}); }
}
export function decodeOpenAiTokens(value: unknown): OpenAiTokens {
  const item = value as OpenAiTokens | undefined;
  if (!item || typeof item.access_token !== 'string' || !item.access_token || item.access_token.length > 65_536 ||
      /[\r\n]/.test(item.access_token) || (item.token_type && String(item.token_type).toLowerCase() !== 'bearer') ||
      [item.refresh_token, item.id_token].some(token => token !== undefined && (typeof token !== 'string' || token.length > 65_536))) throw new Error('OpenAI returned an unsupported token response.');
  return { access_token: item.access_token, ...(item.refresh_token ? { refresh_token: item.refresh_token } : {}),
    ...(item.id_token ? { id_token: item.id_token } : {}), ...(typeof item.scope === 'string' ? { scope: item.scope } : {}),
    ...(typeof item.expires_in === 'number' && Number.isFinite(item.expires_in) && item.expires_in > 0 ? { expires_in: item.expires_in } : {}) };
}
function claim(token: string | undefined): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString('utf8')); } catch { return {}; }
}
export function openAiAccess(tokens: OpenAiTokens): OpenAiAccess {
  for (const token of [tokens.access_token, tokens.id_token]) {
    const auth = claim(token)['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id;
    if (typeof accountId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(accountId)) return { accessToken: tokens.access_token, accountId };
  }
  return { accessToken: tokens.access_token };
}
/** JWT fields only hint at refresh timing/routing; the server validates the bearer. */
export function storedOpenAiTokens(tokens: OpenAiTokens, now = Date.now()): StoredOpenAiTokens {
  const exp = claim(tokens.access_token).exp;
  const expiresAt = tokens.expires_in ? now + tokens.expires_in * 1000 : typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  return { ...tokens, ...(expiresAt ? { expiresAt } : {}) };
}
export async function exchangeOpenAiToken(parameters: URLSearchParams, request: typeof fetch = fetch, signal?: AbortSignal): Promise<OpenAiTokens> {
  const response = await request(OPENAI_HOSTED_PROTOCOL.tokenEndpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: parameters,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
  if (!response.ok) { await response.body?.cancel(); if ([400, 401].includes(response.status)) throw new OpenAiAuthError('OpenAI authorization expired or was rejected. Sign in again.'); throw new OpenAiHttpError(response.status); }
  return decodeOpenAiTokens(await readOpenAiJson(response));
}
export async function startOpenAiLogin({ fetch: request = globalThis.fetch, ports = [1455, 1457], timeoutMs = 600_000, signal }: {
  fetch?: typeof fetch; ports?: number[]; timeoutMs?: number; signal?: AbortSignal;
} = {}) {
  signal?.throwIfAborted();
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const lifetime = new AbortController();
  let resolveLogin!: (value: OpenAiTokens) => void, rejectLogin!: (error: Error) => void;
  let settled = false, exchanging = false, redirectUri = '';
  const result = new Promise<OpenAiTokens>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
  result.catch(() => {});
  const server = createServer((incoming, response) => {
    const reply = (status: number, message: string) => response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" }).end(
      `<!doctype html><html lang="zh"><meta charset="utf-8"><title>CardBush · OpenAI</title><body style="font:16px system-ui;padding:48px;max-width:650px"><h1>CardBush · OpenAI</h1><p>${message}</p><p>可关闭此页面，返回 CardBush 查看连接状态。</p></body></html>`);
    const expected = new URL(redirectUri);
    if (incoming.method !== 'GET' || incoming.headers.origin || incoming.headers.host !== expected.host || (incoming.url?.length ?? 0) > 16_384) { reply(400, '请求无效。'); incoming.resume(); return; }
    let url;
    try { url = new URL(incoming.url!, redirectUri); } catch { reply(400, '请求无效。'); return; }
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) { reply(404, '页面不存在。'); return; }
    const provided = Buffer.from(url.searchParams.get('state') ?? ''), required = Buffer.from(state);
    if (provided.length !== required.length || !timingSafeEqual(provided, required)) { reply(400, '登录状态校验失败，请重新发起登录。'); return; }
    if (settled || exchanging) { reply(409, '此次登录已处理。'); return; }
    if (url.searchParams.has('error')) { settled = true; reply(400, '登录未完成或被拒绝。'); rejectLogin(new OpenAiAuthError('OpenAI login was declined or failed.')); return; }
    const code = url.searchParams.get('code'); if (!code) { reply(400, '缺少授权码。'); return; }
    exchanging = true;
    void exchangeOpenAiToken(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: OPENAI_HOSTED_PROTOCOL.clientId, code_verifier: verifier }), request, lifetime.signal).then(tokens => {
      lifetime.signal.throwIfAborted(); settled = true;
      reply(200, 'OpenAI 授权已完成。'); resolveLogin(tokens);
    }).catch(error => { settled = true; reply(502, '授权未完成，请返回 CardBush 查看错误。'); rejectLogin(error); });
  });
  let bound = false;
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1');
      }); bound = true; break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
  }
  if (!bound) throw new Error('OAuth callback ports are occupied. Existing applications were left running.');
  redirectUri = `http://localhost:${(server.address() as { port: number }).port}/auth/callback`;
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const authorize = new URL(OPENAI_HOSTED_PROTOCOL.authorizationEndpoint);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: OPENAI_HOSTED_PROTOCOL.clientId, redirect_uri: redirectUri,
    scope: OPENAI_HOSTED_PROTOCOL.scopes, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'cardbush' }).toString();
  const timer = setTimeout(() => { void close(new OpenAiAuthError('OpenAI login timed out. Start a new login.')); }, timeoutMs);
  const aborted = () => { void close(); };
  signal?.addEventListener('abort', aborted, { once: true });
  async function close(reason: Error = new OpenAiAuthError('OpenAI login cancelled.')) {
    clearTimeout(timer); signal?.removeEventListener('abort', aborted); lifetime.abort(reason);
    if (!settled) { settled = true; rejectLogin(reason); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (signal?.aborted) await close();
  return { authorizationUrl: authorize.href, redirectUri, result, close };
}
