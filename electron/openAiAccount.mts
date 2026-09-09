import { createHash } from 'node:crypto';
import { OPENAI_HOSTED_PROTOCOL, type OpenAiAccountStatus, type OpenAiAccess } from '@cardbush/bush-protocol';
import { startOpenAiLogin, openAiAccess, storedOpenAiTokens, decodeOpenAiTokens, exchangeOpenAiToken, OpenAiAuthError,
  OpenAiHttpError, type StoredOpenAiTokens } from '@cardbush/bush-mcp-client';

export const OPENAI_ACCOUNT_CREDENTIAL_KEY = createHash('sha256').update('cardbush.openai_account.v1').digest('hex');
type Login = Awaited<ReturnType<typeof startOpenAiLogin>>;

/** Desktop owns the only account record. No token or login URL is exposed to renderer snapshots. */
export class OpenAiAccount {
  private tokens?: StoredOpenAiTokens;
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private activeLogin?: { controller: AbortController; promise: Promise<void>; previous: OpenAiAccountStatus['state'] };
  private refreshing?: Promise<OpenAiAccess>;
  private lifetime = new AbortController();
  private state: OpenAiAccountStatus['state'] = 'signed_out';
  private lastError?: string;
  constructor(private readonly options: {
    read: () => Promise<unknown>; write: (value: unknown) => Promise<unknown>;
    openUrl: (url: string) => Promise<unknown>; changed: () => void;
    fetch?: typeof fetch; now?: () => number;
    startLogin?: (signal: AbortSignal) => Promise<Login>;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private changed(state: OpenAiAccountStatus['state'], lastError?: string) {
    this.state = state; this.lastError = lastError; this.options.changed();
  }
  private load() {
    return this.loaded ??= (async () => {
      const epoch = this.epoch;
      try {
        const stored = await this.options.read();
        if (epoch !== this.epoch) return;
        if (stored !== undefined) {
          const raw = stored as { tokens?: unknown; expiresAt?: number };
          const tokens = decodeOpenAiTokens(raw.tokens);
          this.tokens = { ...tokens, ...(typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? { expiresAt: raw.expiresAt } : {}) };
          this.state = 'signed_in';
        }
      } catch { if (epoch === this.epoch) this.changed('unavailable', 'OpenAI credentials could not be read from secure storage.'); }
    })();
  }
  async status(): Promise<OpenAiAccountStatus> {
    await this.load();
    return { state: this.state, experimental: true, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }
  private save(tokens: StoredOpenAiTokens, epoch: number): Promise<void> {
    const pending = this.writes.then(async () => {
      if (epoch !== this.epoch) throw new OpenAiAuthError('OpenAI account changed during authorization.');
      await this.options.write({ tokens: decodeOpenAiTokens(tokens), expiresAt: tokens.expiresAt });
      if (epoch !== this.epoch) {
        await this.options.write(this.tokens ? { tokens: decodeOpenAiTokens(this.tokens), expiresAt: this.tokens.expiresAt } : undefined);
        throw new OpenAiAuthError('OpenAI account changed during authorization.');
      }
      this.tokens = tokens;
    });
    this.writes = pending.catch(() => {}); return pending;
  }
  async login(signal?: AbortSignal): Promise<void> {
    await this.load(); signal?.throwIfAborted();
    if (this.activeLogin) return this.activeLogin.promise;
    const epoch = ++this.epoch;
    this.lifetime.abort(); this.lifetime = new AbortController(); this.refreshing = undefined;
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const previous = this.state;
    this.changed('signing_in');
    const promise = (async () => {
      let login: Login | undefined;
      try {
        login = await (this.options.startLogin?.(combined) ?? startOpenAiLogin({ fetch: this.options.fetch, signal: combined }));
        combined.throwIfAborted();
        await this.options.openUrl(login.authorizationUrl);
        const tokens = await login.result;
        combined.throwIfAborted();
        await this.save(storedOpenAiTokens(tokens, this.now()), epoch);
        if (epoch === this.epoch) this.changed('signed_in');
      } catch (error) {
        if (epoch === this.epoch) this.changed(this.tokens ? (previous === 'reauth_required' ? previous : 'signed_in') : 'signed_out',
          combined.aborted ? undefined : safeOpenAiError(error));
        throw new Error(combined.aborted ? 'OpenAI login cancelled.' : safeOpenAiError(error));
      } finally { await login?.close(); if (this.activeLogin?.controller === controller) this.activeLogin = undefined; }
    })();
    this.activeLogin = { controller, promise, previous }; return promise;
  }
  cancelLogin() {
    if (!this.activeLogin) return;
    this.epoch++; this.activeLogin.controller.abort();
    this.changed(this.tokens ? (this.activeLogin.previous === 'reauth_required' ? 'reauth_required' : 'signed_in') : 'signed_out');
  }
  async access(input: { rejectedToken?: string; signal?: AbortSignal } = {}): Promise<OpenAiAccess> {
    await this.load(); input.signal?.throwIfAborted();
    if (!this.tokens || this.state === 'reauth_required' || this.state === 'signing_in') throw new OpenAiAuthError();
    const rejected = input.rejectedToken === this.tokens.access_token;
    if (!rejected && (!this.tokens.expiresAt || this.tokens.expiresAt > this.now() + 60_000)) return { ...openAiAccess(this.tokens), generation: this.epoch };
    if (!this.tokens.refresh_token) { this.changed('reauth_required', 'OpenAI authorization expired. Sign in again.'); throw new OpenAiAuthError(); }
    if (!this.refreshing) {
      const prior = this.tokens, epoch = this.epoch, signal = this.lifetime.signal;
      const pending = (async () => {
        try {
          const tokens = await exchangeOpenAiToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: prior.refresh_token!,
            client_id: OPENAI_HOSTED_PROTOCOL.clientId }), this.options.fetch, signal);
          signal.throwIfAborted();
          const refreshed = storedOpenAiTokens({ ...tokens, refresh_token: tokens.refresh_token ?? prior.refresh_token, id_token: tokens.id_token ?? prior.id_token }, this.now());
          await this.save(refreshed, epoch);
          if (epoch === this.epoch) this.changed('signed_in');
          return { ...openAiAccess(refreshed), generation: epoch };
        } catch (error) {
          if (epoch === this.epoch) this.changed(error instanceof OpenAiAuthError ? 'reauth_required' : 'signed_in', safeOpenAiError(error));
          if (error instanceof OpenAiAuthError) throw error;
          throw new Error(safeOpenAiError(error));
        }
      })();
      this.refreshing = pending;
      void pending.finally(() => { if (this.refreshing === pending) this.refreshing = undefined; }).catch(() => {});
    }
    // Cancelling one tool must not cancel a refresh shared by other calls.
    const access = await waitForCaller(this.refreshing, input.signal);
    input.signal?.throwIfAborted(); return access;
  }
  async logout(): Promise<void> {
    this.epoch++; this.cancelLogin(); this.lifetime.abort(); this.lifetime = new AbortController(); this.refreshing = undefined;
    this.tokens = undefined; this.changed('signed_out');
    const clear = this.writes.then(() => this.options.write(undefined));
    this.writes = clear.catch(() => {});
    try { await clear; }
    catch { this.changed('unavailable', 'OpenAI credentials could not be removed from secure storage. Try signing out again.'); throw new Error(this.lastError); }
  }
  async close() { this.epoch++; this.cancelLogin(); this.lifetime.abort(); await this.activeLogin?.promise.catch(() => {}); await this.writes; this.tokens = undefined; }
}
function safeOpenAiError(error: unknown): string {
  if (error instanceof OpenAiHttpError || error instanceof OpenAiAuthError) return error.message;
  return 'OpenAI sign-in or credential storage failed. Check the network and secure storage, then retry.';
}
async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted(); let abort!: () => void;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error('OpenAI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
  })]); } finally { signal.removeEventListener('abort', abort); }
}
