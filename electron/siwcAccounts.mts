import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIWC, siwcSnapshotSchema, siwcActionSchema, type SiwcSnapshot, type SiwcModel } from '@cardbush/bush-protocol';
import { SiwcOAuth, SiwcError, safeSiwcError, siwcTokensSchema } from './siwcOAuth.mjs';

export const SIWC_CREDENTIAL_KEY = createHash('sha256').update('cardbush.siwc_accounts.v1').digest('hex');
const recordSchema = z.object({ id: z.string().uuid(), clientId: z.string().min(1), subject: z.string().optional(),
  email: z.string().optional(), name: z.string().optional(), tokens: siwcTokensSchema.optional(), expiresAt: z.number().optional(),
  reauth: z.boolean().optional(), lastError: z.string().optional() });
const storeSchema = z.object({ version: z.literal(1), hostId: z.string().startsWith('urn:uuid:'),
  welcomeShown: z.boolean(), accounts: z.array(recordSchema) });
type Record = z.infer<typeof recordSchema>;
type Store = z.infer<typeof storeSchema>;
type Options = { read: () => Promise<unknown>; write: (value: unknown) => Promise<unknown>; openUrl: (url: string) => Promise<unknown>;
  changed: () => void; invalidated: (id: string) => void; fetch?: typeof fetch; now?: () => number; oauth?: SiwcOAuth };

/** The desktop owns encrypted registrations. Renderers and persisted model bindings only see IDs. */
export class SiwcAccounts {
  private store!: Store;
  private loaded?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private active?: { id: string; clientId?: string; abort: AbortController; promise: Promise<void> };
  private connectedAccountId?: string;
  private refreshing = new Map<string, Promise<string>>();
  private signingOut = new Map<string, Promise<void>>();
  private blocked = new Set<string>();
  private generations = new Map<string, number>();
  private lifetime = new AbortController();
  private lastError?: string;
  private readonly oauth: SiwcOAuth;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: Options) {
    this.fetcher = options.fetch ?? fetch; this.oauth = options.oauth ?? new SiwcOAuth(this.fetcher);
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private load() {
    return this.loaded ??= (async () => {
      const value = await this.options.read();
      this.store = value === undefined ? { version: 1, hostId: `urn:uuid:${randomUUID()}`, welcomeShown: false, accounts: [] } : storeSchema.parse(value);
      if (value === undefined) await this.options.write(this.store);
    })().catch(() => { this.loaded = undefined; throw new SiwcError('ChatGPT credentials could not be read or saved in secure storage.'); });
  }
  private change(update: (store: Store) => void, stillValid?: () => boolean): Promise<void> {
    const pending = this.writes.then(async () => {
      const next = structuredClone(this.store); update(next);
      await this.options.write(storeSchema.parse(next));
      if (stillValid && !stillValid()) {
        await this.options.write(this.store);
        throw new SiwcError('ChatGPT credentials changed before sign-in completed.');
      }
      this.store = next; this.options.changed();
    });
    this.writes = pending.catch(() => {}); return pending;
  }
  private account(id: string) {
    const account = this.store.accounts.find(item => item.id === id);
    if (!account) throw new SiwcError('This ChatGPT account is unavailable on this device. Add it in model settings.', true);
    return account;
  }
  private plan(account: Record) { return Boolean(account.tokens?.scope.split(/\s+/).includes(SIWC.planScope)); }
  async snapshot(): Promise<SiwcSnapshot> {
    await this.load();
    return siwcSnapshotSchema.parse({ accounts: this.store.accounts.map(account => ({ id: account.id,
      label: account.email || account.name || `ChatGPT · ${account.id.slice(0, 8)}`,
      state: this.active?.id === account.id || this.active?.clientId === account.clientId ? 'signing_in' : this.blocked.has(account.id) || !account.tokens ? 'signed_out' : account.reauth ? 'reauth_required' : 'signed_in',
      planEnabled: this.plan(account), ...(account.lastError ? { lastError: account.lastError } : {}) })),
      signingIn: Boolean(this.active), welcomePending: !this.store.welcomeShown && this.store.accounts.some(item => this.plan(item)),
      ...(this.connectedAccountId ? { connectedAccountId: this.connectedAccountId } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}) });
  }
  async dismissWelcome() { await this.load(); await this.change(store => { store.welcomeShown = true; }); }
  async action(input: unknown) {
    const command = siwcActionSchema.parse(input);
    try {
      if (command.action === 'login') await this.login(command.accountId);
      if (command.action === 'cancel_login') this.cancelLogin();
      if (command.action === 'logout') await this.logout(z.string().uuid().parse(command.accountId));
      if (command.action === 'manage_usage') await this.options.openUrl(SIWC.usageUrl);
      if (command.action === 'dismiss_welcome') await this.dismissWelcome();
      return await this.snapshot();
    } catch (error) { throw new SiwcError(safeSiwcError(error)); }
  }
  async accessPayload(input: unknown, signal: AbortSignal) {
    const payload = z.object({ accountId: z.string().uuid(), rejectedToken: z.string().optional() }).parse(input);
    return this.access(payload.accountId, { rejectedToken: payload.rejectedToken, signal });
  }
  async login(accountId?: string) {
    await this.load(); this.lifetime.signal.throwIfAborted();
    if (accountId) await this.signingOut.get(accountId);
    if (accountId) await this.refreshing.get(accountId)?.catch(() => {});
    if (this.active) throw new SiwcError('A ChatGPT sign-in is already in progress. Complete or cancel it first.');
    const prior = accountId ? this.account(accountId) : undefined;
    const id = prior?.id ?? randomUUID(), abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal]);
    const generation = this.generations.get(id) ?? 0;
    const check = () => { signal.throwIfAborted(); if (generation !== (this.generations.get(id) ?? 0)) throw new SiwcError('The ChatGPT account changed during sign-in.'); };
    this.lastError = undefined;
    const promise = (async () => {
      let login: Awaited<ReturnType<SiwcOAuth['start']>> | undefined;
      try {
        login = await this.oauth.start({ hostId: this.store.hostId, signal,
          ...(prior ? { registration: { ...prior, idToken: prior.tokens?.id_token } } : {}),
          registered: async clientId => { check();
            if (this.active?.abort === abort) this.active.clientId = clientId;
            await Promise.allSettled(this.store.accounts.filter(item => item.clientId === clientId).flatMap(item => this.refreshing.has(item.id) ? [this.refreshing.get(item.id)!] : []));
            await this.change(store => { check();
            if (!store.accounts.some(item => item.id === id)) store.accounts.push({ id, clientId }); }); },
        });
        check(); await this.options.openUrl(login.authorizationUrl);
        const result = await login.result; check();
        let connectedId = id;
        await this.change(store => { check();
          // A repeated bootstrap may resolve to a registration already on this host.
          // Keep the existing ID used by model bindings; never key identity by email.
          const duplicate = store.accounts.find(item => item.id !== id && item.clientId === result.clientId && item.subject === result.identity.subject);
          if (duplicate) { connectedId = duplicate.id; store.accounts = store.accounts.filter(item => item.id !== id); }
          const index = store.accounts.findIndex(item => item.id === connectedId);
          if (index < 0) throw new SiwcError('The ChatGPT registration is missing.');
          store.accounts[index] = { id: connectedId, clientId: result.clientId, ...result.identity, tokens: result.tokens,
            expiresAt: this.now() + result.tokens.expires_in * 1000 };
        }, () => !signal.aborted && generation === (this.generations.get(id) ?? 0));
        check(); this.blocked.delete(connectedId); this.connectedAccountId = connectedId; this.options.invalidated(connectedId);
      } catch (error) { this.lastError = signal.aborted ? undefined : safeSiwcError(error); throw new SiwcError(signal.aborted ? 'ChatGPT sign-in cancelled.' : this.lastError!); }
      finally { await login?.close(); if (this.active?.abort === abort) this.active = undefined; this.options.changed(); }
    })();
    this.active = { id, clientId: prior?.clientId, abort, promise }; this.options.changed(); return promise;
  }
  cancelLogin() { this.active?.abort.abort(); }
  async access(id: string, input: { rejectedToken?: string; signal?: AbortSignal } = {}): Promise<string> {
    await this.load(); input.signal?.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const account = this.account(id);
    if (this.blocked.has(id) || this.active?.id === id || this.active?.clientId === account.clientId || account.reauth || !account.tokens) throw new SiwcError('Continue with ChatGPT in model settings to authorize this account.', true);
    if (!this.plan(account)) throw new SiwcError('ChatGPT plan usage was not authorized. Continue with ChatGPT and enable plan access.', true);
    if (account.expiresAt! > this.now() + 60_000 && input.rejectedToken !== account.tokens.access_token) return account.tokens.access_token;
    if (!this.refreshing.has(id)) {
      const generation = this.generations.get(id) ?? 0;
      const promise = this.refresh(account, generation);
      this.refreshing.set(id, promise);
      void promise.finally(() => { if (this.refreshing.get(id) === promise) this.refreshing.delete(id); }).catch(() => {});
    }
    const token = await waitForCaller(this.refreshing.get(id)!, input.signal);
    input.signal?.throwIfAborted();
    if (this.blocked.has(id)) throw new SiwcError('This ChatGPT account was signed out.', true);
    return token;
  }
  private async refresh(prior: Record, generation: number): Promise<string> {
    try {
      if (!prior.tokens?.refresh_token) throw new SiwcError('ChatGPT authorization expired. Continue with ChatGPT again.', true);
      const tokens = await this.oauth.exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: prior.clientId,
        refresh_token: prior.tokens.refresh_token, resource: SIWC.resource }), this.lifetime.signal);
      if (!tokens.refresh_token) throw new SiwcError('ChatGPT did not return a replacement refresh token. Sign in again.', true);
      if (tokens.id_token) {
        const identity = await this.oauth.identity(tokens.id_token, prior.clientId);
        if (identity.subject !== prior.subject) throw new SiwcError('The refreshed ChatGPT identity did not match.', true);
      }
      await this.change(store => {
        if (generation !== (this.generations.get(prior.id) ?? 0)) throw new SiwcError('ChatGPT credentials changed during refresh.', true);
        const current = store.accounts.find(item => item.id === prior.id)!;
        current.tokens = { ...tokens, id_token: tokens.id_token ?? prior.tokens!.id_token };
        current.expiresAt = this.now() + tokens.expires_in * 1000; current.reauth = false; delete current.lastError;
      });
      if (!tokens.scope.split(/\s+/).includes(SIWC.planScope)) throw new SiwcError('ChatGPT plan authorization was removed. Sign in again.', true);
      return tokens.access_token;
    } catch (error) {
      if (generation === (this.generations.get(prior.id) ?? 0)) await this.change(store => {
        const current = store.accounts.find(item => item.id === prior.id)!;
        current.lastError = safeSiwcError(error); current.reauth = error instanceof SiwcError && error.reauth;
      }).catch(() => {});
      throw new SiwcError(safeSiwcError(error), error instanceof SiwcError && error.reauth);
    }
  }
  async models(id: string, signal = new AbortController().signal): Promise<SiwcModel[]> {
    let token = await this.access(id, { signal });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetcher(`${SIWC.resource}/models`, { redirect: 'error', headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (response.status === 401 && !attempt) { await response.body?.cancel(); token = await this.access(id, { signal, rejectedToken: token }); continue; }
      if (!response.ok) { await response.body?.cancel(); throw new SiwcError(`ChatGPT model discovery failed (HTTP ${response.status}). Check plan access in ChatGPT settings.`); }
      const data = z.object({ models: z.array(z.object({ slug: z.string().min(1), display_name: z.string().optional(), visibility: z.string().optional() })) }).safeParse(await response.json());
      if (!data.success) throw new SiwcError('ChatGPT returned an invalid model catalog.');
      if (this.blocked.has(id)) throw new SiwcError('This ChatGPT account was signed out.');
      return data.data.models.filter(item => item.visibility === 'list').map(item => ({ id: item.slug, name: item.display_name || item.slug }));
    }
    return [];
  }
  async logout(id: string): Promise<void> {
    await this.load();
    if (!this.signingOut.has(id)) {
      const promise = this.signOut(id); this.signingOut.set(id, promise);
      void promise.finally(() => { if (this.signingOut.get(id) === promise) this.signingOut.delete(id); }).catch(() => {});
    }
    return this.signingOut.get(id)!;
  }
  private async signOut(id: string) {
    await this.load(); this.account(id); this.blocked.add(id); this.options.invalidated(id); this.options.changed();
    if (this.active && (this.active.id === id || this.active.clientId === this.account(id).clientId)) { this.active.abort.abort(); await this.active.promise.catch(() => {}); }
    // Finish an already rotating token before revoking its latest replacement.
    await this.refreshing.get(id)?.catch(() => {});
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const account = this.account(id), tokens = account.tokens;
    const revoked = tokens?.refresh_token ? await this.oauth.revoke(tokens.refresh_token, account.clientId) : !tokens;
    await this.change(store => {
      const current = store.accounts.find(item => item.id === id)!;
      delete current.tokens; delete current.expiresAt; delete current.reauth;
      current.lastError = revoked ? undefined : 'Signed out locally. Remote revocation was not confirmed; disconnect CardBush in ChatGPT settings.';
    });
  }
  async close() { this.lifetime.abort(); this.cancelLogin(); await this.active?.promise.catch(() => {}); await Promise.allSettled([...this.refreshing.values(), ...this.signingOut.values()]); await this.writes; }
}
async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted(); let abort!: () => void;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    abort = () => reject(new SiwcError('ChatGPT request cancelled.')); signal.addEventListener('abort', abort, { once: true });
  })]); } finally { signal.removeEventListener('abort', abort); }
}
