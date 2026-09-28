import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { chromeConnectorExtensionId, chromeConnectorProtocol } from './chromeConnectorConstants';
import { assertConnectorFile, writeConnectorFile } from './chromeConnectorFiles';

type Credential = { id: string; secret: string };
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
  #credential: Credential | null = null;
  #pending: Pairing | null = null;
  #port = 0;
  #running = false;

  constructor(directory: string, readonly connected: (socket: WebSocket) => void,
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
        || request.socket.remoteAddress !== '127.0.0.1' || this.#ws.clients.size >= 4) return reject();
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
      if (protocols?.length !== 2 || protocols[0] !== 'cardbush-v2') return reject();
      const match = /^auth\.([a-f0-9]{32})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(protocols[1]!);
      if (!match) return reject();
      const id = match[1]!, nonce = match[2]!, proof = match[3]!;
      const candidate = this.#pending?.id === id && this.#pending.expiresAt > Date.now()
        ? this.#pending : this.#credential?.id === id ? this.#credential : null;
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
      if (saved?.version !== 2 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535
        || (saved.credential != null && (!/^[a-f0-9]{32}$/.test(saved.credential.id)
          || !/^[a-f0-9]{64}$/.test(saved.credential.secret)))) throw new Error('Invalid browser pairing configuration. Remove the connector configuration and pair again.');
      this.#port = saved.port; this.#credential = saved.credential;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, '127.0.0.1', () => { this.#server.off('error', reject); resolve(); });
    });
    this.#port = (this.#server.address() as { port: number }).port;
    try { this.#save(); this.#running = true; }
    catch (error) { this.stop(); throw error; }
  }

  createPairing(): { code: string; expiresAt: string } {
    if (!this.#running) throw new Error('Enable the connector before pairing.');
    this.#pending = { id: hex(16), secret: hex(32), expiresAt: Date.now() + (this.options.pairingTtlMs ?? 300_000) };
    return { code: `CB2.${this.#port}.${this.#pending.id}.${this.#pending.secret}`,
      expiresAt: new Date(this.#pending.expiresAt).toISOString() };
  }
  get port(): number { return this.#port; }
  get paired(): boolean { return this.#credential != null; }
  stop(): void {
    this.#running = false; this.#pending = null; this.#nonces.clear();
    for (const client of this.#ws.clients) client.terminate();
    for (const socket of this.#sockets) socket.destroy();
    this.#server.close(); this.#ws.close();
  }
  #save(): void {
    writeConnectorFile(this.#file, JSON.stringify({ version: 2, port: this.#port, credential: this.#credential }));
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
        if ((!isPending && this.#credential !== candidate) || message.type !== 'authenticate'
          || !matches(String(message.proof), connectorProof(candidate.secret, `client:${transcript}`))) throw new Error('Invalid proof');
        if (isPending) {
          const previous = this.#credential;
          this.#credential = { id: candidate.id, secret: candidate.secret };
          try { this.#save(); } catch (error) { this.#credential = previous; throw error; }
          this.#pending = null;
        }
        clearTimeout(timer); client.off('message', authenticate);
        this.connected(client);
      } catch { client.terminate(); }
    };
    client.on('message', authenticate);
    client.send(JSON.stringify({ type: 'challenge', protocol: chromeConnectorProtocol, nonce: serverNonce,
      proof: connectorProof(candidate.secret, `server:${transcript}`) }));
  }
}
