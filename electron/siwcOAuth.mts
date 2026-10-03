import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import { SIWC } from '@cardbush/bush-protocol';

export class SiwcError extends Error {
  get code() { return this.reauth ? 'siwc_auth_required' : 'siwc_unavailable'; }
  constructor(message: string, readonly reauth = false) { super(message); this.name = 'SiwcError'; }
}
export const siwcTokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(), token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(), scope: z.string(), earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
});
export type SiwcTokens = z.infer<typeof siwcTokensSchema>;
export interface SiwcIdentity { subject: string; email?: string; name?: string; }
export interface SiwcRegistration extends Partial<SiwcIdentity> { clientId: string; idToken?: string; }
const issuedClient = z.string().min(1).max(256).refine(value => value !== SIWC.registrationClient && /^[A-Za-z0-9_-]+$/.test(value));
const random = () => randomBytes(32).toString('base64url');

/** Safe errors deliberately exclude OAuth bodies, URLs and credentials. */
export function safeSiwcError(error: unknown): string {
  return error instanceof SiwcError ? error.message : 'ChatGPT authorization failed. Check the network and secure storage, then retry.';
}
export class SiwcOAuth {
  private discoveryPromise?: Promise<{ jwks_uri: string; revocation_endpoint: string }>;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async discovery() {
    return this.discoveryPromise ??= (async () => {
      const response = await this.fetcher(SIWC.discovery, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new SiwcError('ChatGPT authorization discovery is unavailable.');
      const data = z.object({ issuer: z.literal(SIWC.issuer), jwks_uri: z.string(), revocation_endpoint: z.string() }).parse(await response.json());
      for (const endpoint of [data.jwks_uri, data.revocation_endpoint]) {
        const url = new URL(endpoint);
        if (url.origin !== SIWC.issuer || url.username || url.password || url.hash || url.search) throw new SiwcError('Invalid ChatGPT authorization endpoint.');
      }
      return data;
    })().catch(error => { this.discoveryPromise = undefined; throw error; });
  }
  async identity(token: string, clientId: string, nonce?: string): Promise<SiwcIdentity> {
    const discovery = await this.discovery();
    this.keys ??= createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 20_000,
      [customFetch]: (url, options) => this.fetcher(url, { ...options, redirect: 'error' }) });
    try {
      const { payload } = await jwtVerify(token, this.keys, { issuer: SIWC.issuer, audience: clientId,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce) ||
          (payload.azp !== undefined && payload.azp !== clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw Error();
      return { subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}) };
    } catch { throw new SiwcError('ChatGPT returned an invalid identity. Sign in again.', true); }
  }
  async exchange(params: URLSearchParams, signal: AbortSignal): Promise<SiwcTokens> {
    const response = await this.fetcher(SIWC.token, { method: 'POST', body: params,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SiwcError(response.status === 400 || response.status === 401
        ? 'ChatGPT authorization expired or was rejected. Continue with ChatGPT again.'
        : `ChatGPT authorization service is unavailable (HTTP ${response.status}). Retry later.`, response.status === 400 || response.status === 401);
    }
    const parsed = siwcTokensSchema.safeParse(await response.json());
    if (!parsed.success) throw new SiwcError('ChatGPT returned an incomplete token response. Sign in again.', true);
    return parsed.data;
  }
  async revoke(refreshToken: string, clientId: string): Promise<boolean> {
    try {
      const { revocation_endpoint } = await this.discovery();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.fetcher(revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
          await response.body?.cancel();
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch { /* One bounded backoff; local sign-out must remain possible. */ }
        if (!attempt) await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch { /* Discovery may be unavailable while offline. */ }
    return false;
  }
  async start(input: { hostId: string; registration?: SiwcRegistration; registered: (clientId: string) => Promise<void>; signal: AbortSignal }) {
    input.signal.throwIfAborted();
    const state = random(), nonce = random(), verifier = random();
    let resolve!: (value: { tokens: SiwcTokens; identity: SiwcIdentity; clientId: string }) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<{ tokens: SiwcTokens; identity: SiwcIdentity; clientId: string }>((yes, no) => { resolve = yes; reject = no; });
    // A failed browser launch or cancellation can precede the caller awaiting result.
    void result.catch(() => {});
    let consumed = false, redirectUri = '';
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const finish = (status: number, text: string) => { response.writeHead(status); response.end(text); };
      if (request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host) { finish(400, 'Invalid callback.'); return; }
      const url = new URL(request.url ?? '/', redirectUri);
      if (url.pathname !== SIWC.callbackPath) { finish(404, 'Not found.'); return; }
      const query = url.searchParams;
      if (query.getAll('state').length !== 1 || query.get('state') !== state) { finish(400, 'Invalid sign-in state.'); return; }
      if (consumed) { finish(409, 'This sign-in callback was already used.'); return; }
      consumed = true;
      if (query.has('error')) { finish(400, 'ChatGPT sign-in was not completed. Return to CardBush.'); reject(new SiwcError('ChatGPT sign-in was declined.')); return; }
      const clientId = query.get('client_id') ?? input.registration?.clientId;
      if (!issuedClient.safeParse(clientId).success || query.getAll('client_id').length > 1 ||
          (input.registration && clientId !== input.registration.clientId) || query.getAll('code').length !== 1 || !query.get('code')) {
        finish(400, 'Invalid sign-in callback.'); reject(new SiwcError('ChatGPT returned an invalid client registration.')); return;
      }
      finish(200, 'ChatGPT authorization received. You can return to CardBush.');
      void (async () => {
        input.signal.throwIfAborted();
        // Keep the issued registration even when exchanging a short-lived code fails.
        await input.registered(clientId!);
        const tokens = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId!,
          code: query.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource: SIWC.resource }), input.signal);
        if (!tokens.id_token) throw new SiwcError('ChatGPT did not return an identity token.', true);
        const identity = await this.identity(tokens.id_token, clientId!, nonce);
        if (input.registration?.subject && identity.subject !== input.registration.subject) throw new SiwcError('A different ChatGPT account was selected. Add it as another account instead.', true);
        input.signal.throwIfAborted(); resolve({ tokens, identity, clientId: clientId! });
      })().catch(reject);
    });
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); yes(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new SiwcError('Could not start the local ChatGPT callback.'); }
    redirectUri = `http://127.0.0.1:${address.port}${SIWC.callbackPath}`;
    const close = async () => { clearTimeout(timer); input.signal.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); };
    const abort = () => { reject(new SiwcError('ChatGPT sign-in cancelled.')); void close(); };
    const timer = setTimeout(() => { reject(new SiwcError('ChatGPT sign-in timed out. Try again.')); void close(); }, 10 * 60_000);
    timer.unref(); input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const url = new URL(SIWC.authorization);
    url.search = new URLSearchParams({ response_type: 'code', client_id: input.registration?.clientId ?? SIWC.registrationClient,
      redirect_uri: redirectUri, scope: SIWC.scopes, resource: SIWC.resource, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ext_agent_host_id: input.hostId,
      ...(input.registration ? { ...(input.registration.email ? { login_hint: input.registration.email } : {}),
        ...(input.registration.idToken ? { id_token_hint: input.registration.idToken } : {}), prompt: 'consent' }
        : { agent_name_hint: 'CardBush' }),
    }).toString();
    return { authorizationUrl: url.href, result, close };
  }
}
