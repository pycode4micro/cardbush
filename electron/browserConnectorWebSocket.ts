import { createECDH, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { uiText } from '@cardbush/platform/i18n';
import { WebSocket, WebSocketServer } from 'ws';
import { browserConnectorDiscoveryPorts, browserConnectorExtensionId, browserConnectorProtocol } from './browserConnectorConstants';
import { assertConnectorFile, writeConnectorFile } from './browserConnectorFiles';

export type ConnectorBrowser = 'chrome' | 'edge';
export type BrowserConnection = { id: string; browser: ConnectorBrowser; label: string };
export type ConnectorPortRecovery = { previousPort: number; port: number; reason: 'EADDRINUSE' | 'EACCES' | 'discovery_migration' };
export type ConnectorConnectionAttempt = { at: string; stage: 'rejected' | 'authenticating' | 'awaiting_browser_approval' | 'connected'; reason?: string; connectionId?: string };
export type BrowserApprovalOptions = {
  uiLanguage?: () => string;
  // Only the enabled local App/CLI exposes enrollment. Recheck before commit
  // so a preference change while the browser dialog is open cannot grant access.
  allowLocalPairing?: () => boolean;
  onConnectionAttempt?: () => void;
  approvalTimeoutMs?: number;
  approvalCooldownMs?: number;
};
type Credential = BrowserConnection & { secret: string };
type Pairing = Credential & { expiresAt: number };
type ProfileIdentity = { id: string; browser: ConnectorBrowser; key: string };
const hex = (size: number) => randomBytes(size).toString('hex');
export function connectorProof(secret: string, text: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(text).digest('hex');
}
function matches(proof: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
}

/** Authenticated extension transport. First connection uses browser-owned consent
 * and key agreement; existing credentials never travel over the wire. */
export class BrowserConnectorWebSocket {
  readonly #file: string;
  readonly #server = http.createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { Connection: 'close' }); response.end();
  });
  readonly #ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false, handleProtocols: () => 'cardbush-v2' });
  readonly #approvalWs = new WebSocketServer({ noServer: true, maxPayload: 4096,
    perMessageDeflate: false, handleProtocols: protocols => ['cardbush-pair-v3', 'cardbush-pair-v2', 'cardbush-pair-v1'].find(value => protocols.has(value)) || false });
  #approval?: WebSocket;
  #approvalNotBefore = 0;
  readonly #sockets = new Set<Socket>();
  readonly #nonces = new Set<string>();
  #credentials = new Map<string, Credential>();
  readonly #profiles = new Map<string, ProfileIdentity>();
  #defaultConnectionId = '';
  readonly #revoked = new Set<string>();
  readonly #clients = new Map<WebSocket, string>();
  #pending: Pairing | null = null;
  #port = 0;
  #running = false;
  #portRecovery?: ConnectorPortRecovery;
  #connectionAttempt?: ConnectorConnectionAttempt;

  #observe(stage: ConnectorConnectionAttempt['stage'], reason?: string, connectionId?: string) {
    // No headers, proofs, credentials or browser content enter diagnostics.
    // A rejected attempt is an observation, never authority to change pairing.
    this.#connectionAttempt = { at: new Date().toISOString(), stage, ...(reason ? { reason } : {}), ...(connectionId ? { connectionId } : {}) };
    try { this.options.onConnectionAttempt?.(); } catch { /* Diagnostics never grant or interrupt a connection. */ }
  }

  constructor(directory: string, readonly connected: (socket: WebSocket, connection: BrowserConnection) => void,
    readonly options: { handshakeTimeoutMs?: number; pairingTtlMs?: number } & BrowserApprovalOptions = {}) {
    this.#file = path.join(directory, 'pairing.json');
    this.#server.requestTimeout = 5000;
    this.#server.headersTimeout = 5000;
    this.#server.on('connection', socket => {
      if (this.#sockets.size >= 16) { socket.destroy(); return; }
      this.#sockets.add(socket);
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
    });
    this.#server.on('upgrade', (request, socket, head) => {
      const reject = (reason: string, id?: string) => { this.#observe('rejected', reason, id); socket.destroy(); };
      if (!this.#running || request.method !== 'GET'
        || request.headers.host !== `127.0.0.1:${this.#port}`
        || request.socket.remoteAddress !== '127.0.0.1') return reject('invalid_endpoint');
      if (request.headers.origin !== `chrome-extension://${browserConnectorExtensionId}`) return reject('extension_origin_mismatch');
      if (this.#ws.clients.size >= 16) return reject('connection_limit');
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
      if (request.url === '/request-connection' && protocols?.length === 1
        && ['cardbush-pair-v1', 'cardbush-pair-v2', 'cardbush-pair-v3'].includes(protocols[0])) {
        this.#approvalWs.handleUpgrade(request, socket, head, client => {
          request.socket.setTimeout(0);
          if (protocols[0] !== 'cardbush-pair-v3') {
            client.on('error', () => {});
            this.#observe('rejected', 'extension_update_required');
            client.send(JSON.stringify({ type: 'pair_error', code: 'extension_update_required' })); client.close();
          } else this.#requestConnection(client);
        });
        return;
      }
      if (request.url !== '/connect') return reject('unsupported_connection_request');
      if (protocols?.length !== 2 || protocols[0] !== 'cardbush-v2') return reject('unsupported_protocol');
      const match = /^auth\.([a-f0-9]{32})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(protocols[1]!);
      if (!match) return reject('invalid_authentication');
      const id = match[1]!, nonce = match[2]!, proof = match[3]!;
      const candidate = this.#pending?.id === id && this.#pending.expiresAt > Date.now()
        ? this.#pending : this.#credentials.get(id);
      if (!candidate) return reject(this.#revoked.has(id) ? 'pairing_revoked' : 'pairing_not_found', id);
      if (this.#nonces.has(nonce)) return reject('replayed_nonce', id);
      if (!matches(proof, connectorProof(candidate.secret, `upgrade:${id}:${nonce}`))) return reject('pairing_proof_mismatch', id);
      // Bound memory; a fresh server nonce still makes old handshakes unusable.
      if (this.#nonces.size >= 512) this.#nonces.delete(this.#nonces.values().next().value!);
      this.#nonces.add(nonce);
      this.#ws.handleUpgrade(request, socket, head, client => {
        request.socket.setTimeout(0);
        this.#observe('authenticating', undefined, id);
        this.#authenticate(client, candidate, nonce);
      });
    });
  }

  async start(): Promise<void> {
    assertConnectorFile(this.#file);
    if (fs.existsSync(this.#file)) {
      const saved = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      // One-time conversion of the former single Chrome pairing, without losing consent.
      const credentials = saved.version === 2
        ? (saved.credential ? [{ ...saved.credential, browser: 'chrome', label: 'Chrome' }] : []) : saved.credentials;
      const invalid = () => new Error('Invalid browser pairing configuration. Remove the connector configuration and pair again.');
      if (![2, 3, 4].includes(saved.version) || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535
        || !Array.isArray(credentials) || credentials.length > 8) throw invalid();
      for (const credential of credentials) {
        if (!credential || !/^[a-f0-9]{32}$/.test(credential.id) || !/^[a-f0-9]{64}$/.test(credential.secret)
          || !['chrome', 'edge'].includes(credential.browser) || typeof credential.label !== 'string'
          || !credential.label.trim() || credential.label.length > 80 || this.#credentials.has(credential.id)) throw invalid();
        this.#credentials.set(credential.id, credential);
      }
      this.#defaultConnectionId = saved.version === 2 ? credentials[0]?.id ?? '' : saved.defaultConnectionId;
      if (typeof this.#defaultConnectionId !== 'string' || (this.#defaultConnectionId && !this.#credentials.has(this.#defaultConnectionId))) throw invalid();
      this.#port = saved.port;
      if (saved.revoked !== undefined && (!Array.isArray(saved.revoked) || saved.revoked.length > 256 || saved.revoked.some((id: unknown) => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)))) throw invalid();
      for (const id of saved.revoked ?? []) this.#revoked.add(id);
      if (saved.profiles !== undefined && (!Array.isArray(saved.profiles) || saved.profiles.length > 264)) throw invalid();
      for (const profile of saved.profiles ?? []) {
        if (!profile || !/^[a-f0-9]{32}$/.test(profile.id) || !['chrome', 'edge'].includes(profile.browser)
          || !/^04[a-f0-9]{128}$/.test(profile.key) || this.#profiles.has(profile.id)
          || (this.#credentials.has(profile.id) && this.#credentials.get(profile.id)!.browser !== profile.browser)
          || (!this.#credentials.has(profile.id) && !this.#revoked.has(profile.id))) throw invalid();
        this.#profiles.set(profile.id, profile);
      }
      if (saved.approvalNotBefore !== undefined && (!Number.isFinite(saved.approvalNotBefore) || saved.approvalNotBefore < 0)) throw invalid();
      this.#approvalNotBefore = Math.min(saved.approvalNotBefore ?? 0, Date.now() + 60_000);
    }
    const savedPort = this.#port;
    // Fresh extensions only know the discovery range. A local consent-enabled
    // broker must migrate old arbitrary ports into it; paired extensions can
    // authenticate discovery with the same credentials. Remote/manual-only
    // brokers retain their saved endpoint.
    const migratePort = Boolean(this.options.allowLocalPairing && savedPort && !browserConnectorDiscoveryPorts.includes(savedPort));
    const candidates = [...new Set([...(savedPort && !migratePort ? [savedPort] : []), ...browserConnectorDiscoveryPorts])];
    let savedPortError: ConnectorPortRecovery['reason'] | undefined = migratePort ? 'discovery_migration' : undefined;
    let lastError: unknown;
    for (const port of candidates) {
      try { await this.#listen(port); lastError = undefined; break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
        if (port === savedPort) savedPortError = code;
        lastError = error;
      }
    }
    if (lastError) throw Object.assign(new Error(
      'Browser connector could not bind any local connection port. Pairings are preserved; retry when a port is available.',
      { cause: lastError },
    ), { code: 'connector_ports_unavailable', attemptedPorts: candidates });
    this.#port = (this.#server.address() as { port: number }).port;
    if (savedPortError) this.#portRecovery = { previousPort: savedPort, port: this.#port, reason: savedPortError };
    try { this.#save(); this.#running = true; }
    catch (error) { this.stop(); throw error; }
  }

  #listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.#server.off('error', failed); this.#server.off('listening', listening); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const listening = () => { cleanup(); resolve(); };
      this.#server.once('error', failed);
      this.#server.once('listening', listening);
      try { this.#server.listen(port, '127.0.0.1'); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  createPairing(input: { browser?: ConnectorBrowser; label?: string } = {}): { code: string; expiresAt: string; id: string; browser: ConnectorBrowser } {
    if (!this.#running) throw new Error('Enable the connector before pairing.');
    const browser = input.browser ?? 'chrome';
    if (browser !== 'chrome' && browser !== 'edge') throw new Error(uiText(this.options.uiLanguage?.())('browserConnector.supportedBrowsers'));
    // A ticket can refresh an existing profile even when all connection slots are used.
    if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80)) throw new Error('Connection name must be at most 80 characters.');
    const label = input.label?.trim() || (browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome');
    this.#pending = { id: hex(16), secret: hex(32), browser, label, expiresAt: Date.now() + (this.options.pairingTtlMs ?? 300_000) };
    return { code: `CB2.${this.#port}.${this.#pending.id}.${this.#pending.secret}`,
      expiresAt: new Date(this.#pending.expiresAt).toISOString(), id: this.#pending.id, browser };
  }
  get port(): number { return this.#port; }
  get pendingPairingId(): string | null { return this.#pending && this.#pending.expiresAt > Date.now() ? this.#pending.id : null; }
  importPairings(credentials: Credential[], defaultId: string, profiles: ProfileIdentity[] = []): void {
    if (!Array.isArray(credentials) || credentials.length > 8) throw new Error('Invalid legacy browser pairings.');
    const next = new Map(this.#credentials);
    for (const item of credentials) {
      if (!item || !/^[a-f0-9]{32}$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.secret)
        || !['chrome', 'edge'].includes(item.browser) || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 80)
        throw new Error('Invalid legacy browser pairing.');
      if (this.#revoked.has(item.id)) continue;
      const existing = next.get(item.id);
      if (existing) {
        if (existing.browser !== item.browser || (existing.secret !== item.secret && !this.#profiles.has(item.id)))
          throw new Error('Conflicting legacy browser identity.');
        // A recurring CLI migration must not undo a profile's credential refresh.
        continue;
      }
      next.set(item.id, item);
    }
    if (next.size > 8) throw new Error('Remove unused browser connections before importing the CLI pairings (maximum 8).');
    if (!Array.isArray(profiles) || profiles.length > 264) throw new Error('Invalid legacy profile identities.');
    const previousProfiles = new Map(this.#profiles), nextProfiles = new Map(this.#profiles);
    for (const profile of profiles) {
      if (!profile || !/^[a-f0-9]{32}$/.test(profile.id) || !/^04[a-f0-9]{128}$/.test(profile.key)
        || !['chrome', 'edge'].includes(profile.browser)) throw new Error('Invalid legacy profile identity.');
      if (this.#revoked.has(profile.id) || !next.has(profile.id)) continue;
      const existing = nextProfiles.get(profile.id);
      if (next.get(profile.id)!.browser !== profile.browser || (existing && existing.key !== profile.key)) throw new Error('Conflicting legacy profile identity.');
      nextProfiles.set(profile.id, profile);
    }
    const previous = this.#credentials, previousDefault = this.#defaultConnectionId;
    this.#credentials = next;
    for (const [id, profile] of nextProfiles) this.#profiles.set(id, profile);
    if (previous.size === 0 && !previousDefault && next.has(defaultId)) this.#defaultConnectionId = defaultId;
    try { this.#save(); } catch (error) {
      this.#credentials = previous; this.#defaultConnectionId = previousDefault;
      this.#profiles.clear(); for (const [id, profile] of previousProfiles) this.#profiles.set(id, profile);
      throw error;
    }
  }
  #requestConnection(client: WebSocket): void {
    const controller = new AbortController();
    let phase = 'hello', id = '', nonce = '', secret = '', browser: ConnectorBrowser, profileKey = '';
    let original: Credential | undefined, profile: ProfileIdentity | undefined, ticket: Pairing | undefined, wasRevoked = false;
    const authorized = () => ticket ? this.#pending === ticket && ticket.expiresAt > Date.now() : this.options.allowLocalPairing?.() === true;
    let timer = setTimeout(() => client.terminate(), 5000);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const fail = (code: string) => { phase = 'done'; controller.abort(); clearTimeout(timer); clearInterval(heartbeat);
      this.#observe('rejected', code, id || undefined); if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'pair_error', code })); client.close();
    } };
    const approved = () => client.send(JSON.stringify({ type: 'pair_approved',
      proof: connectorProof(secret, `approved:${id}:${nonce}`) }));
    client.on('error', () => {});
    client.once('close', () => {
      clearTimeout(timer); clearInterval(heartbeat); controller.abort();
      phase = 'done';
      if (this.#approval === client) this.#approval = undefined;
    });
    client.on('message', (data, binary) => { void (async () => {
      if (binary || data.toString().length > 4096 || controller.signal.aborted) throw new Error('Invalid request');
      const message = JSON.parse(data.toString());
      if (message.type === 'pair_ping') return;
      if (phase === 'browser') {
        if (this.#credentials.get(id) !== original || this.#revoked.has(id) !== wasRevoked || this.#profiles.get(id) !== profile) {
          fail('identity_conflict'); return;
        }
        if (message.type === 'pair_decline' && matches(String(message.proof), connectorProof(secret, `decline:${id}:${nonce}`))) {
          if (!original) {
            this.#revoked.add(id); this.#profiles.set(id, { id, browser, key: profileKey });
            try { this.#save(); } catch (error) {
              if (!wasRevoked) this.#revoked.delete(id);
              if (profile) this.#profiles.set(id, profile); else this.#profiles.delete(id);
              throw error;
            }
          }
          fail('connection_denied'); return;
        }
        if (message.type !== 'pair_accept' || !matches(String(message.proof), connectorProof(secret, `accept:${id}:${nonce}`))) throw new Error('Browser confirmation required');
        if (!authorized()) { fail('connector_disabled'); return; }
        if (!original && this.#credentials.size >= 8) { fail('connection_limit'); return; }
        phase = 'done';
        this.#credentials.set(id, { id, secret, browser, label: original?.label ?? ticket?.label ?? (browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome') });
        this.#profiles.set(id, { id, browser, key: profileKey }); this.#revoked.delete(id);
        const previous = this.#defaultConnectionId;
        if (this.#credentials.size === 1 && !previous) this.#defaultConnectionId = id;
        try { this.#save(); } catch (error) {
          if (original) this.#credentials.set(id, original); else this.#credentials.delete(id);
          if (profile) this.#profiles.set(id, profile); else this.#profiles.delete(id);
          if (wasRevoked) this.#revoked.add(id);
          this.#defaultConnectionId = previous; throw error;
        }
        if (ticket) this.#pending = null;
        // Already authenticated sockets using the replaced secret lose control too.
        for (const [socket, connectionId] of this.#clients) if (connectionId === id) socket.terminate();
        approved(); client.close(); return;
      }
      if (phase === 'hello') {
        phase = 'challenge';
        if (message.type !== 'pair_request' || !/^[a-f0-9]{32}$/.test(message.id)
          || !/^[a-f0-9]{64}$/.test(message.nonce) || !['chrome', 'edge'].includes(message.browser)
          || !/^04[a-f0-9]{128}$/.test(message.key)) throw new Error('Invalid identity');
        id = message.id; nonce = message.nonce; browser = message.browser; profileKey = message.key;
        if (message.ticketId !== undefined) {
          const candidate = this.#pending;
          if (!candidate || candidate.id !== message.ticketId || candidate.browser !== browser || candidate.expiresAt <= Date.now()
            || !matches(String(message.ticketProof), connectorProof(candidate.secret, `ticket:${id}:${nonce}:${browser}:${profileKey}`))) {
            fail('identity_conflict'); return;
          }
          ticket = candidate;
        }
        original = this.#credentials.get(id); profile = this.#profiles.get(id); wasRevoked = this.#revoked.has(id);
        if (!ticket && this.options.allowLocalPairing && !this.options.allowLocalPairing()) { fail('connector_disabled'); return; }
        const resume = original && matches(String(message.resumeProof), connectorProof(original.secret, `resume:${id}:${nonce}:${profileKey}`));
        if ((profile && (profile.browser !== browser || profile.key !== profileKey))
          || (original && (original.browser !== browser || (!profile && !resume)))) { fail('identity_conflict'); return; }
        if (wasRevoked && (!profile || (!message.rotate && !ticket))) { fail('connection_revoked'); return; }
        if (original && !message.rotate && !ticket) {
          if (!resume) { fail('identity_conflict'); return; }
          secret = original.secret; approved(); client.close(); return;
        }
        if (!authorized()) { fail(this.options.allowLocalPairing ? 'connector_disabled' : 'connector_unavailable'); return; }
        if (this.#approval || (!profile && !ticket && Date.now() < this.#approvalNotBefore)) { fail('approval_busy'); return; }
        if ((!original && this.#credentials.size >= 8) || (!original && !wasRevoked && this.#revoked.size >= 256)) { fail('connection_limit'); return; }
        const key = createECDH('prime256v1'); key.generateKeys();
        const publicKey = key.getPublicKey('hex');
        secret = createHash('sha256').update(key.computeSecret(Buffer.from(message.key, 'hex')))
          .update(`cardbush-pair-v3:${id}:${browser}:${profileKey}:${publicKey}:${ticket?.id ?? ''}:${message.rotate === true}`).digest('hex');
        this.#approval = client;
        client.send(JSON.stringify({ type: 'pair_challenge', key: publicKey }));
        return;
      }
      if (phase !== 'challenge' || message.type !== 'pair_confirm'
        || !matches(String(message.proof), connectorProof(secret, `request:${id}:${nonce}`))) throw new Error('Invalid confirmation');
      if (!authorized()) { fail('connector_disabled'); return; }
      phase = 'browser';
      this.#approvalNotBefore = Date.now() + (this.options.approvalCooldownMs ?? 30_000);
      this.#save();
      clearTimeout(timer); timer = setTimeout(() => { controller.abort(); fail('connection_denied'); }, this.options.approvalTimeoutMs ?? 60_000);
      heartbeat = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.send('{"type":"pair_waiting"}'); }, 15_000);
      this.#observe('awaiting_browser_approval', undefined, id);
      // An offer is not approval. Only an accept proof following the trusted
      // extension window's explicit confirmation can persist a credential.
      client.send(JSON.stringify({ type: 'pair_offer', proof: connectorProof(secret, `offer:${id}:${nonce}`) }));
    })().catch(() => { if (this.#approval === client) this.#approval = undefined; fail('connection_failed'); }); });
  }
  get portRecovery(): ConnectorPortRecovery | undefined { return this.#portRecovery; }
  get connectionAttempt(): ConnectorConnectionAttempt | undefined { return this.#connectionAttempt; }
  get paired(): boolean { return this.#credentials.size > 0; }
  get defaultConnectionId(): string { return this.#defaultConnectionId; }
  connections(): BrowserConnection[] { return [...this.#credentials.values()].map(({ id, browser, label }) => ({ id, browser, label })); }
  setDefault(id: string): void {
    if (!this.#credentials.has(id)) throw new Error('Browser pairing not found.');
    const previous = this.#defaultConnectionId;
    this.#defaultConnectionId = id;
    try { this.#save(); } catch (error) { this.#defaultConnectionId = previous; throw error; }
  }
  revoke(id: string): void {
    const credential = this.#credentials.get(id);
    if (!credential) throw new Error('Browser pairing not found.');
    const previous = this.#defaultConnectionId;
    if (this.#revoked.size >= 256 && !this.#revoked.has(id)) throw new Error('Browser revocation history is full. Remove connector configuration to reset it.');
    this.#revoked.add(id);
    this.#credentials.delete(id);
    if (previous === id) this.#defaultConnectionId = '';
    try { this.#save(); } catch (error) { this.#revoked.delete(id); this.#credentials.set(id, credential); this.#defaultConnectionId = previous; throw error; }
    for (const [client, connectionId] of this.#clients) if (connectionId === id) {
      client.send(JSON.stringify({ type: 'control', method: 'connector.disable', reason: 'pairing_removed' }));
      client.close(1008, 'Pairing removed');
      const timer = setTimeout(() => client.terminate(), 1000);
      timer.unref(); client.once('close', () => clearTimeout(timer));
    }
  }
  stop(): void {
    this.#running = false; this.#pending = null; this.#nonces.clear();
    for (const client of this.#ws.clients) client.terminate();
    for (const client of this.#approvalWs.clients) client.terminate();
    for (const socket of this.#sockets) socket.destroy();
    this.#server.close(); this.#ws.close(); this.#approvalWs.close();
  }
  #save(): void {
    writeConnectorFile(this.#file, JSON.stringify({ version: 4, port: this.#port,
      credentials: [...this.#credentials.values()], profiles: [...this.#profiles.values()],
      defaultConnectionId: this.#defaultConnectionId, revoked: [...this.#revoked], approvalNotBefore: this.#approvalNotBefore }));
  }
  #authenticate(client: WebSocket, candidate: Credential, nonce: string): void {
    const serverNonce = hex(32);
    const transcript = `${candidate.id}:${nonce}:${serverNonce}`;
    const timer = setTimeout(() => { this.#observe('rejected', 'handshake_timeout', candidate.id); client.terminate(); }, this.options.handshakeTimeoutMs ?? 5000);
    client.once('close', () => clearTimeout(timer));
    client.on('error', () => {});
    const authenticate = (data: import('ws').RawData, binary: boolean) => {
      try {
        if (binary || data.toString().length > 8192) throw new Error('Invalid handshake');
        const message = JSON.parse(data.toString());
        const isPending = this.#pending === candidate && this.#pending.expiresAt > Date.now();
        if ((!isPending && this.#credentials.get(candidate.id) !== candidate) || message.type !== 'authenticate'
          || message.browser !== candidate.browser
          || !matches(String(message.proof), connectorProof(candidate.secret, `client:${transcript}:${message.browser}`))) throw new Error('Invalid proof');
        const previousProfile = this.#profiles.get(candidate.id);
        if (message.profileKey !== undefined && (!/^04[a-f0-9]{128}$/.test(message.profileKey)
          || (previousProfile && previousProfile.key !== message.profileKey)
          || !matches(String(message.profileProof), connectorProof(candidate.secret, `profile:${transcript}:${message.profileKey}`)))) throw new Error('Invalid profile identity');
        const attachProfile = message.profileKey !== undefined && !previousProfile;
        if (isPending) {
          if (this.#credentials.size >= 8) throw new Error('Browser connection limit reached');
          const previous = this.#defaultConnectionId;
          const { id, secret, browser, label } = candidate;
          this.#credentials.set(id, { id, secret, browser, label });
          if (attachProfile) this.#profiles.set(id, { id, browser, key: message.profileKey });
          if (!previous && this.#credentials.size === 1) this.#defaultConnectionId = id;
          try { this.#save(); } catch (error) {
            this.#credentials.delete(id); if (attachProfile) this.#profiles.delete(id);
            this.#defaultConnectionId = previous; throw error;
          }
          this.#pending = null;
        }
        if (attachProfile && !isPending) {
          this.#profiles.set(candidate.id, { id: candidate.id, browser: candidate.browser, key: message.profileKey });
          try { this.#save(); } catch (error) { this.#profiles.delete(candidate.id); throw error; }
        }
        clearTimeout(timer); client.off('message', authenticate);
        this.#clients.set(client, candidate.id);
        client.once('close', () => this.#clients.delete(client));
        const { id, browser, label } = candidate;
        this.connected(client, { id, browser, label });
        this.#observe('connected', undefined, id);
      } catch { this.#observe('rejected', 'handshake_failed', candidate.id); client.terminate(); }
    };
    client.on('message', authenticate);
    client.send(JSON.stringify({ type: 'challenge', protocol: browserConnectorProtocol, nonce: serverNonce,
      proof: connectorProof(candidate.secret, `server:${transcript}`) }));
  }
}
