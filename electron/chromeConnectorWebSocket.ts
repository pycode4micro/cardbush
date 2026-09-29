import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { chromeConnectorExtensionId, chromeConnectorProtocol } from './chromeConnectorConstants';
import { assertConnectorFile, writeConnectorFile } from './chromeConnectorFiles';

export type ConnectorBrowser = 'chrome' | 'edge';
export type BrowserConnection = { id: string; browser: ConnectorBrowser; label: string };
type Credential = BrowserConnection & { secret: string };
type Pairing = Credential & { expiresAt: number };
const hex = (size: number) => randomBytes(size).toString('hex');
export function connectorProof(secret: string, text: string): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(text).digest('hex');
}
function matches(proof: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'));
}

/** Extension transport. Secrets travel only in the explicitly copied pairing
 * code, never in URLs, HTTP responses, status broadcasts or diagnostics. */
export class ChromeConnectorWebSocket {
  readonly #file: string;
  readonly #server = http.createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { Connection: 'close' }); response.end();
  });
  readonly #ws = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024,
    perMessageDeflate: false, handleProtocols: () => 'cardbush-v2' });
  readonly #sockets = new Set<Socket>();
  readonly #nonces = new Set<string>();
  #credentials = new Map<string, Credential>();
  #defaultConnectionId = '';
  readonly #clients = new Map<WebSocket, string>();
  #pending: Pairing | null = null;
  #port = 0;
  #running = false;

  constructor(directory: string, readonly connected: (socket: WebSocket, connection: BrowserConnection) => void,
    readonly options: { handshakeTimeoutMs?: number; pairingTtlMs?: number } = {}) {
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
      const reject = () => socket.destroy();
      if (!this.#running || request.method !== 'GET' || request.url !== '/connect'
        || request.headers.host !== `127.0.0.1:${this.#port}`
        || request.headers.origin !== `chrome-extension://${chromeConnectorExtensionId}`
        || request.socket.remoteAddress !== '127.0.0.1' || this.#ws.clients.size >= 16) return reject();
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
      if (protocols?.length !== 2 || protocols[0] !== 'cardbush-v2') return reject();
      const match = /^auth\.([a-f0-9]{32})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(protocols[1]!);
      if (!match) return reject();
      const id = match[1]!, nonce = match[2]!, proof = match[3]!;
      const candidate = this.#pending?.id === id && this.#pending.expiresAt > Date.now()
        ? this.#pending : this.#credentials.get(id);
      if (!candidate || this.#nonces.has(nonce)
        || !matches(proof, connectorProof(candidate.secret, `upgrade:${id}:${nonce}`))) return reject();
      // Bound memory; a fresh server nonce still makes old handshakes unusable.
      if (this.#nonces.size >= 512) this.#nonces.delete(this.#nonces.values().next().value!);
      this.#nonces.add(nonce);
      this.#ws.handleUpgrade(request, socket, head, client => {
        request.socket.setTimeout(0);
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
      if (![2, 3].includes(saved.version) || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535
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
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, '127.0.0.1', () => { this.#server.off('error', reject); resolve(); });
    });
    this.#port = (this.#server.address() as { port: number }).port;
    try { this.#save(); this.#running = true; }
    catch (error) { this.stop(); throw error; }
  }

  createPairing(input: { browser?: ConnectorBrowser; label?: string } = {}): { code: string; expiresAt: string; id: string; browser: ConnectorBrowser } {
    if (!this.#running) throw new Error('Enable the connector before pairing.');
    const browser = input.browser ?? 'chrome';
    if (browser !== 'chrome' && browser !== 'edge') throw new Error('Browser Use supports Chrome and Edge on Windows 11.');
    if (this.#credentials.size >= 8) throw new Error('Remove an unused browser pairing before adding another (maximum 8).');
    if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80)) throw new Error('Connection name must be at most 80 characters.');
    const label = input.label?.trim() || (browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome');
    this.#pending = { id: hex(16), secret: hex(32), browser, label, expiresAt: Date.now() + (this.options.pairingTtlMs ?? 300_000) };
    return { code: `CB2.${this.#port}.${this.#pending.id}.${this.#pending.secret}`,
      expiresAt: new Date(this.#pending.expiresAt).toISOString(), id: this.#pending.id, browser };
  }
  get port(): number { return this.#port; }
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
    this.#credentials.delete(id);
    if (previous === id) this.#defaultConnectionId = '';
    try { this.#save(); } catch (error) { this.#credentials.set(id, credential); this.#defaultConnectionId = previous; throw error; }
    for (const [client, connectionId] of this.#clients) if (connectionId === id) {
      client.send(JSON.stringify({ type: 'control', method: 'connector.disable' }));
      client.close(1008, 'Pairing removed');
      const timer = setTimeout(() => client.terminate(), 1000);
      timer.unref(); client.once('close', () => clearTimeout(timer));
    }
  }
  stop(): void {
    this.#running = false; this.#pending = null; this.#nonces.clear();
    for (const client of this.#ws.clients) client.terminate();
    for (const socket of this.#sockets) socket.destroy();
    this.#server.close(); this.#ws.close();
  }
  #save(): void {
    writeConnectorFile(this.#file, JSON.stringify({ version: 3, port: this.#port,
      credentials: [...this.#credentials.values()], defaultConnectionId: this.#defaultConnectionId }));
  }
  #authenticate(client: WebSocket, candidate: Credential, nonce: string): void {
    const serverNonce = hex(32);
    const transcript = `${candidate.id}:${nonce}:${serverNonce}`;
    const timer = setTimeout(() => client.terminate(), this.options.handshakeTimeoutMs ?? 5000);
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
        if (isPending) {
          const previous = this.#defaultConnectionId;
          const { id, secret, browser, label } = candidate;
          this.#credentials.set(id, { id, secret, browser, label });
          if (!previous && this.#credentials.size === 1) this.#defaultConnectionId = id;
          try { this.#save(); } catch (error) { this.#credentials.delete(id); this.#defaultConnectionId = previous; throw error; }
          this.#pending = null;
        }
        clearTimeout(timer); client.off('message', authenticate);
        this.#clients.set(client, candidate.id);
        client.once('close', () => this.#clients.delete(client));
        const { id, browser, label } = candidate;
        this.connected(client, { id, browser, label });
      } catch { client.terminate(); }
    };
    client.on('message', authenticate);
    client.send(JSON.stringify({ type: 'challenge', protocol: chromeConnectorProtocol, nonce: serverNonce,
      proof: connectorProof(candidate.secret, `server:${transcript}`) }));
  }
}
