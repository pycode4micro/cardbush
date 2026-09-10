import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  auth, UnauthorizedError, validateAuthorizationResponseIssuer, checkResourceAllowed,
  type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { mcpOAuthConfigSchema, type McpServerSnapshot } from '@cardbush/bush-protocol';

export interface McpCredentialStore {
  read(key: string): Promise<CredentialState | undefined>;
  write(key: string, value: CredentialState | undefined): Promise<void>;
}
export interface CredentialState {
  clientSecret?: { value: string; url: string; clientId: string };
  clients?: Record<string, StoredOAuthClientInformation>;
  tokens?: Record<string, StoredOAuthTokens>;
  issuer?: string;
  discovery?: OAuthDiscoveryState;
}
export class McpAuthenticationRequired extends UnauthorizedError {
  readonly code = 'mcp_auth_required';
  constructor() { super('This MCP service requires sign-in. Connect it from plugin or MCP settings.'); }
}
export class McpOAuthConfigurationRequired extends Error {
  readonly code = 'mcp_oauth_configuration_required';
}

function validateClientConfiguration(options: NonNullable<Exclude<McpServerSnapshot['transport'], { kind: 'stdio' }>['oauth']>) {
  if (options.clientId && /^<[^<>]+>$/.test(options.clientId.trim())) throw new McpOAuthConfigurationRequired('Configure your OAuth client ID in this connection. The package contains an unfilled client ID placeholder.');
  if (!options.clientSecretRef && options.clientSecretEnv && !process.env[options.clientSecretEnv]) throw new McpOAuthConfigurationRequired('The configured OAuth client secret environment variable is empty or unavailable. Save the client secret in connection settings, or configure the environment before signing in.');
}

/** Credentials are owned by the desktop vault; neither snapshots nor model context contain tokens. */
export class McpOAuthCoordinator {
  readonly #sessions = new Map<string, AbortController>();
  readonly #credentials = new Map<string, Promise<CredentialState>>();
  constructor(private readonly store: McpCredentialStore, private readonly openUrl: (url: string) => Promise<void>,
    private readonly fetchForServer: (server: McpServerSnapshot) => typeof fetch = () => fetch) {}

  async #clientSecret(server: McpServerSnapshot): Promise<string | undefined> {
    if (server.transport.kind === 'stdio') throw new Error('OAuth requires an HTTP MCP service.');
    const options = server.transport.oauth ?? {};
    validateClientConfiguration(options);
    if (!options.clientSecretRef) return options.clientSecretEnv ? process.env[options.clientSecretEnv] : undefined;
    // Read the private entry at authentication time, independently of cached tokens.
    const secret = (await this.store.read(options.clientSecretRef))?.clientSecret;
    if (!secret?.value || secret.clientId !== options.clientId || secret.url !== new URL(server.transport.url).href) {
      throw new McpOAuthConfigurationRequired('The saved client secret is missing or belongs to a different endpoint or client ID. Save the credentials again in connection settings.');
    }
    return secret.value;
  }

  provider(server: McpServerSnapshot, interactive?: { redirectUrl: string; state: string }): OAuthClientProvider {
    if (server.transport.kind === 'stdio') throw new Error('OAuth requires an HTTP MCP service.');
    const options = server.transport.oauth ?? {};
    const key = credentialKey(server);
    const read = () => {
      let data = this.#credentials.get(key);
      if (!data) { data = this.store.read(key).then(value => value ?? {}); this.#credentials.set(key, data); }
      return data;
    };
    let verifier = '';
    const update = async (mutate: (state: CredentialState) => void) => {
      const data = read().then(async previous => { const next = structuredClone(previous); mutate(next); await this.store.write(key, next); return next; });
      this.#credentials.set(key, data);
      try { await data; } catch (error) { if (this.#credentials.get(key) === data) this.#credentials.delete(key); throw error; }
    };
    return {
      redirectUrl: interactive?.redirectUrl ?? options.callbackUrl ?? `http://127.0.0.1/callback/${key.slice(0, 24)}`,
      clientMetadataUrl: options.clientMetadataUrl,
      clientMetadata: { client_name: 'CardBush', redirect_uris: [interactive?.redirectUrl ?? options.callbackUrl ?? `http://127.0.0.1/callback/${key.slice(0, 24)}`],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: options.clientSecretRef || options.clientSecretEnv ? 'client_secret_post' : 'none',
        ...(options.scopes?.length ? { scope: options.scopes.join(' ') } : {}) },
      state: () => interactive?.state ?? '',
      clientInformation: async context => {
        const secret = await this.#clientSecret(server);
        if (options.clientId) return { client_id: options.clientId, ...(context?.issuer ? { issuer: context.issuer } : {}), ...(secret ? { client_secret: secret } : {}) };
        const saved = await read();
        const client = saved.clients?.[context?.issuer ?? saved.issuer ?? ''];
        if (!interactive && !client) throw new McpAuthenticationRequired();
        return client;
      },
      saveClientInformation: (client, context) => update(saved => { const issuer = context?.issuer ?? client.issuer ?? ''; (saved.clients ??= {})[issuer] = client; }),
      tokens: async context => { const saved = await read(); return saved.tokens?.[context?.issuer ?? saved.issuer ?? '']; },
      saveTokens: (tokens, context) => update(saved => { const issuer = context?.issuer ?? tokens.issuer ?? ''; saved.issuer = issuer; (saved.tokens ??= {})[issuer] = tokens; }),
      redirectToAuthorization: async url => { if (!interactive) throw new McpAuthenticationRequired(); await this.openUrl(url.toString()); },
      saveCodeVerifier: value => { verifier = value; },
      codeVerifier: () => { if (!verifier) throw new Error('OAuth login expired. Start sign-in again.'); return verifier; },
      discoveryState: async () => (await read()).discovery,
      saveDiscoveryState: value => update(saved => { saved.discovery = value; }),
      ...(options.resourceUrl ? { validateResourceURL: async (serverUrl: string | URL, discovered?: string) => {
        if (!checkResourceAllowed({ requestedResource: serverUrl, configuredResource: options.resourceUrl! }) || (discovered && new URL(discovered).href !== new URL(options.resourceUrl!).href)) {
          throw new McpOAuthConfigurationRequired('The configured OAuth resource does not match this MCP service or its published resource metadata.');
        }
        return new URL(options.resourceUrl!);
      } } : {}),
      invalidateCredentials: async scope => {
        if (scope === 'verifier') { verifier = ''; return; }
        await update(saved => {
          if (scope === 'tokens' || scope === 'all') { delete saved.tokens; delete saved.issuer; }
          if (scope === 'client' || scope === 'all') delete saved.clients;
          if (scope === 'discovery' || scope === 'all') delete saved.discovery;
        });
      },
    };
  }

  async login(server: McpServerSnapshot, signal?: AbortSignal): Promise<void> {
    if (server.transport.kind === 'stdio') throw new Error('OAuth requires an HTTP MCP service.');
    if (this.#sessions.has(server.id)) throw new Error('Sign-in is already in progress for this service.');
    const options = server.transport.oauth ?? {};
    await this.#clientSecret(server);
    const path = options.callbackPort !== undefined ? '/callback' : `/callback/${credentialKey(server).slice(0, 24)}`;
    const callback = new URL(options.callbackUrl ?? `http://127.0.0.1:${options.callbackPort ?? 0}${path}`);
    if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) || callback.username || callback.password || callback.search || callback.hash) {
      throw new McpOAuthConfigurationRequired('OAuth callback must be a local HTTP loopback URL without credentials, query or fragment.');
    }
    const controller = new AbortController();
    this.#sessions.set(server.id, controller);
    const abort = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : [])]);
    const state = randomBytes(32).toString('hex');
    let finish!: (value: URL) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<URL>((resolve, fail) => { finish = resolve; reject = fail; });
    // Observe early cancellation while discovery/registration is still running.
    void completed.catch(() => undefined);
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? '/', callback);
      const supplied = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      if (request.method !== 'GET' || request.headers.host !== callback.host || url.pathname !== callback.pathname || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(400).end('Invalid OAuth callback.'); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('CardBush received the sign-in response. You can close this tab.');
      finish(url);
    });
    const onAbort = () => { reject(new Error('MCP sign-in was cancelled or expired.')); listener.close(); };
    abort.addEventListener('abort', onAbort, { once: true });
    try {
      abort.throwIfAborted();
      await new Promise<void>((resolve, fail) => { listener.once('error', fail); listener.listen(Number(callback.port || 80), callback.hostname === '[::1]' ? '::1' : callback.hostname, resolve); });
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('OAuth callback listener failed.');
      callback.port = String(address.port);
      const provider = this.provider(server, { redirectUrl: callback.toString(), state });
      const fetchFn: typeof fetch = (input, init) => this.fetchForServer(server)(input, { ...init, signal: AbortSignal.any([abort, ...(init?.signal ? [init.signal] : [])]) });
      const authOptions = { serverUrl: server.transport.url, scope: options.scopes?.join(' '), fetchFn };
      if (await auth(provider, authOptions) === 'AUTHORIZED') return;
      const returned = await completed;
      const discovery = await provider.discoveryState?.();
      validateAuthorizationResponseIssuer({ iss: returned.searchParams.get('iss') ?? undefined,
        expectedIssuer: discovery?.authorizationServerMetadata?.issuer,
        issParameterSupported: discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true });
      if (returned.searchParams.has('error')) throw new Error(`OAuth authorization failed: ${returned.searchParams.get('error')}`);
      const code = returned.searchParams.get('code');
      if (!code) throw new Error('OAuth callback has no authorization code.');
      if (await auth(provider, { ...authOptions, authorizationCode: code, iss: returned.searchParams.get('iss') ?? undefined }) !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete.');
    } finally {
      abort.removeEventListener('abort', onAbort); listener.close(); listener.closeAllConnections(); this.#sessions.delete(server.id);
    }
  }
  cancel(serverId: string) { this.#sessions.get(serverId)?.abort(); }
  async logout(server: McpServerSnapshot) {
    this.cancel(server.id);
    const key = credentialKey(server);
    await this.#credentials.get(key)?.catch(() => undefined);
    await this.store.write(key, undefined); this.#credentials.delete(key);
  }
  close() { for (const session of this.#sessions.values()) session.abort(); }
}
export function credentialKey(server: McpServerSnapshot) {
  if (server.transport.kind === 'stdio') throw new Error('OAuth requires an HTTP service.');
  return createHash('sha256').update(JSON.stringify([server.id, server.transport.url, mcpOAuthConfigSchema.parse(server.transport.oauth ?? {})])).digest('hex');
}
