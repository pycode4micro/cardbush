import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { createWebSocketStream, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import { ChromeConnectorWebSocket, type BrowserConnection, type ConnectorBrowser } from './chromeConnectorWebSocket';
import { assertConnectorFile, connectorDirectory, secureConnectorResource, writeConnectorFile } from './chromeConnectorFiles';

import {
  chromeConnectorConfigDirectoryName,
  chromeConnectorConfigFileName,
  chromeConnectorProtocol,
} from './chromeConnectorConstants';

type PeerRole = 'extension' | 'mcp';

const maximumPeerMessageCharacters = 64 * 1024 * 1024;
const maximumCommandBytes = 1024 * 1024;

type Peer = {
  id: string;
  role: PeerRole;
  socket: Duplex;
  buffer: string;
  connection?: BrowserConnection;
  status?: Partial<ChromeConnectorStatus>;
};

type Pending = { client: Peer; extension: Peer; id: string; scopeId: string; switchTo?: string };

export interface ChromeConnectorStatus {
  protocol: typeof chromeConnectorProtocol;
  bridgeRunning: boolean;
  extensionConnected: boolean;
  extensionVersion?: string;
  connectedAt?: string;
  activeTabId?: number;
  activeTabTitle?: string;
  activeTabUrl?: string;
  controlledTabCount: number;
  lastError?: string;
  paired: boolean;
  transport: 'loopback_websocket';
  defaultConnectionId: string;
  connections: Array<BrowserConnection & { connected: boolean; extensionVersion?: string; controlledTabCount: number }>;
}

export class ChromeConnectorBroker {
  readonly configPath: string;
  readonly endpoint: string;
  readonly #token = randomBytes(32).toString('hex');
  readonly #server = net.createServer();
  readonly #peers = new Map<string, Peer>();
  readonly #sockets = new Set<Duplex>();
  readonly #webSocket: ChromeConnectorWebSocket;
  readonly #listeners = new Set<(status: ChromeConnectorStatus) => void>();
  readonly #extensions = new Map<string, Peer>();
  readonly #pending = new Map<string, Pending>();
  readonly #scopeBindings = new Map<string, string>();
  readonly #routesPath: string;
  #started = false;
  #lastError = '';

  constructor(readonly userDataPath: string, readonly options: {
    nativeHostPath?: string; handshakeTimeoutMs?: number; maximumPeers?: number;
  } = {}) {
    this.#routesPath = path.join(connectorDirectory(userDataPath), 'routes.json');
    this.#webSocket = new ChromeConnectorWebSocket(connectorDirectory(userDataPath), (socket, connection) => this.#acceptExtension(socket, connection), options);
    const identity = createHash('sha256').update(userDataPath + randomUUID()).digest('hex').slice(0, 24);
    this.endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\cardbush-browser-connector-${identity}`
      : path.join(userDataPath, chromeConnectorConfigDirectoryName, 'bridge.sock');
    this.configPath = path.join(
      userDataPath,
      chromeConnectorConfigDirectoryName,
      chromeConnectorConfigFileName,
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    const directory = connectorDirectory(this.userDataPath);
    fs.mkdirSync(directory, { recursive: true });
    const nativeHost = this.options.nativeHostPath ?? path.resolve('dist-native/chrome-connector/CardBushBrowserHost.exe');
    secureConnectorResource(nativeHost, 'directory', directory);
    assertConnectorFile(this.#routesPath);
    if (fs.existsSync(this.#routesPath)) {
      const saved = JSON.parse(fs.readFileSync(this.#routesPath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.bindings) || saved.bindings.length > 4096) throw new Error('Invalid browser session routes.');
      for (const entry of saved.bindings) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 512
          || !/^[a-f0-9]{32}$/.test(entry[1]) || this.#scopeBindings.has(entry[0])) throw new Error('Invalid browser session route.');
        this.#scopeBindings.set(entry[0], entry[1]);
      }
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.endpoint);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    this.#server.on('connection', (socket) => this.#accept(socket));
    this.#server.on('error', (error) => {
      this.#lastError = error.message;
      this.#publish();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off('error', onError);
        resolve();
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen(this.endpoint);
    });
    try {
      secureConnectorResource(nativeHost, 'pipe', this.endpoint);
      await this.#webSocket.start();
      writeConnectorFile(this.configPath, JSON.stringify({
        protocol: chromeConnectorProtocol,
        endpoint: this.endpoint,
        token: this.#token,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (error) {
      this.#webSocket.stop();
      for (const socket of this.#sockets) socket.destroy();
      this.#sockets.clear();
      this.#server.close();
      throw error;
    }
    this.#started = true;
    this.#publish();
  }

  stop(): void {
    this.#webSocket.stop();
    if (!this.#started) return;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#peers.clear();
    this.#extensions.clear();
    this.#pending.clear();
    this.#started = false;
    this.#server.close();
    try {
      connectorDirectory(this.userDataPath);
      assertConnectorFile(this.configPath);
      const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (config.token === this.#token) fs.unlinkSync(this.configPath);
    } catch (error) {
      if (!isMissing(error)) console.error('[chrome-connector] failed to remove bridge config', error);
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.endpoint);
      } catch (error) {
        if (!isMissing(error)) console.error('[chrome-connector] failed to remove socket', error);
      }
    }
    this.#publish();
  }

  status(): ChromeConnectorStatus {
    const preferred = this.#extensions.get(this.#webSocket.defaultConnectionId)?.status;
    return {
      protocol: chromeConnectorProtocol,
      bridgeRunning: this.#started,
      ...preferred,
      extensionConnected: this.#extensions.size > 0,
      controlledTabCount: [...this.#extensions.values()].reduce((sum, peer) => sum + (peer.status?.controlledTabCount ?? 0), 0),
      paired: this.#webSocket.paired,
      transport: 'loopback_websocket',
      defaultConnectionId: this.#webSocket.defaultConnectionId,
      connections: this.#webSocket.connections().map(connection => ({ ...connection,
        connected: this.#extensions.has(connection.id), extensionVersion: this.#extensions.get(connection.id)?.status?.extensionVersion,
        controlledTabCount: this.#extensions.get(connection.id)?.status?.controlledTabCount ?? 0 })),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  onStatus(listener: (status: ChromeConnectorStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  createPairing(input: { browser?: ConnectorBrowser; label?: string } = {}) { return this.#webSocket.createPairing(input); }
  setDefaultConnection(id: string): void { this.#webSocket.setDefault(id); this.#publish(); }
  revokeConnection(id: string): void {
    const peer = this.#extensions.get(id);
    this.#webSocket.revoke(id);
    if (peer) this.#extensions.delete(id);
    // Retain the binding as a tombstone: revoked sessions must never fall through to another browser.
    this.#publish();
  }

  releaseAll(reason = 'explicit_release'): void {
    for (const peer of this.#extensions.values()) writeLine(peer.socket, {
      type: 'control',
      method: 'debugger.detachAll',
      reason,
    });
  }

  async disableExtension(): Promise<void> {
    await Promise.all([...this.#extensions.values()].map(extension => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      extension.socket.once('close', () => { clearTimeout(timer); resolve(); });
      writeLine(extension.socket, { type: 'control', method: 'connector.disable' });
    })));
  }

  suspendAll(reason = 'turn_terminal'): void {
    for (const peer of this.#extensions.values()) writeLine(peer.socket, {
      type: 'control',
      method: 'debugger.suspendAll',
      reason,
    });
  }

  #accept(socket: Socket): void {
    if (this.#sockets.size >= (this.options.maximumPeers ?? 32)) { socket.destroy(); return; }
    this.#sockets.add(socket);
    const handshakeTimer = setTimeout(() => socket.destroy(), this.options.handshakeTimeoutMs ?? 5000);
    handshakeTimer.unref();
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const temporaryId = randomUUID();
    const pending: Peer = { id: temporaryId, role: 'mcp', socket, buffer: '' };
    let authenticated = false;
    socket.on('data', (chunk: string) => {
      pending.buffer += chunk;
      if (pending.buffer.length > (authenticated ? maximumPeerMessageCharacters : 8192)) {
        socket.destroy(new Error('Browser Use peer exceeded the message buffer limit.'));
        return;
      }
      while (true) {
        const boundary = pending.buffer.indexOf('\n');
        if (boundary < 0) break;
        const line = pending.buffer.slice(0, boundary).trim();
        pending.buffer = pending.buffer.slice(boundary + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = asRecord(JSON.parse(line));
        } catch {
          socket.destroy(new Error('Browser Use peer sent invalid JSON.'));
          return;
        }
        if (!authenticated) {
          // The private pipe is MCP-only. Extensions must use the paired socket.
          const role = message.role === 'mcp'
            ? message.role
            : null;
          if (
            message.type !== 'hello' ||
            message.protocol !== chromeConnectorProtocol ||
            message.token !== this.#token ||
            !role
          ) {
            socket.destroy(new Error('Browser Use peer authentication failed.'));
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimer);
          pending.role = role;
          pending.id = temporaryId;
          this.#peers.set(pending.id, pending);
          writeLine(socket, {
            type: 'hello_ack',
            protocol: chromeConnectorProtocol,
            clientId: pending.id,
          });
          continue;
        }
        this.#route(pending, message);
      }
    });
    socket.on('error', (error) => {
      if (authenticated) this.#lastError = error.message;
    });
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      this.#sockets.delete(socket);
      this.#peers.delete(pending.id);
      // A timed-out MCP caller does not cancel a command already running in the
      // browser. Keep its bounded request record until a response or disconnect,
      // so an explicit browser switch cannot race an uncertain mutation.
    });
  }

  #acceptExtension(client: WebSocket, connection: BrowserConnection): void {
    this.#extensions.get(connection.id)?.socket.destroy();
    const socket = createWebSocketStream(client, { encoding: 'utf8', decodeStrings: false });
    client.once('close', () => socket.destroy());
    const peer: Peer = { id: randomUUID(), role: 'extension', socket, buffer: '', connection,
      status: { connectedAt: new Date().toISOString(), controlledTabCount: 0 } };
    this.#extensions.set(connection.id, peer);
    this.#sockets.add(socket); this.#peers.set(peer.id, peer);
    this.#lastError = '';
    // Application messages keep Chrome's service worker alive and detect an
    // abandoned browser even if TCP never reports a close.
    let heartbeat = setTimeout(() => socket.destroy(), 60_000);
    socket.on('data', (data: string) => {
      try {
        const message = asRecord(JSON.parse(data));
        clearTimeout(heartbeat); heartbeat = setTimeout(() => socket.destroy(), 60_000);
        if (message.type === 'heartbeat') writeLine(socket, { type: 'heartbeat_ack' });
        else this.#route(peer, message);
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(heartbeat); this.#sockets.delete(socket); this.#peers.delete(peer.id);
      for (const [key, pending] of this.#pending) if (pending.extension === peer) {
        this.#pending.delete(key);
        this.#reply(pending.client, pending.id, undefined, 'browser_disconnected',
          'The selected browser disconnected during the request. Its action may have run; reconnect and observe before retrying. No other browser was used.');
      }
      if (this.#extensions.get(connection.id) === peer) this.#extensions.delete(connection.id);
      this.#publish();
    });
    writeLine(socket, { type: 'connector_ready', protocol: chromeConnectorProtocol });
    this.#publish();
  }

  #route(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role === 'mcp') {
      if (message.type !== 'request') return;
      const id = string(message.id), params = asRecord(message.params), scopeId = string(params.scopeId);
      try {
        if (!id || id.length > 256 || !scopeId || scopeId.length > 512) throw new Error('A request id and CardBush session scope are required.');
        if (message.method === 'browser.list') {
          this.#reply(peer, id, { connections: this.status().connections, defaultConnectionId: this.#webSocket.defaultConnectionId,
            selectedConnectionId: this.#scopeBindings.get(scopeId) ?? null }); return;
        }
        if ([...this.#pending.values()].some(pending => pending.scopeId === scopeId && pending.switchTo)) {
          this.#reply(peer, id, undefined, 'browser_session_busy', 'Wait for the browser switch to finish.'); return;
        }
        let connectionId = this.#scopeBindings.get(scopeId);
        let switchTo: string | undefined;
        if (message.method === 'browser.select') {
          const target = string(params.connectionId);
          if (!this.#extensions.has(target)) {
            this.#reply(peer, id, undefined, 'browser_unavailable', 'Select a connected browser returned by list_browsers.'); return;
          }
          if ([...this.#pending.values()].some(pending => pending.scopeId === scopeId)) {
            this.#reply(peer, id, undefined, 'browser_session_busy', 'Wait for the current browser operation to finish before switching.'); return;
          }
          if (!connectionId || connectionId === target || !this.#extensions.has(connectionId)) {
            this.#bind(scopeId, target); this.#reply(peer, id, { connectionId: target }); return;
          }
          // Release the old browser before switching. A failed release leaves the binding unchanged.
          switchTo = target;
          message = { ...message, method: 'debugger.detachScope' };
        }
        if (!connectionId) {
          connectionId = this.#webSocket.defaultConnectionId;
          if (!connectionId) { this.#reply(peer, id, undefined, 'browser_selection_required', 'Call list_browsers then select_browser, or choose a default browser in Browser Use settings.'); return; }
          if (this.#extensions.has(connectionId)) this.#bind(scopeId, connectionId);
        }
        const extension = this.#extensions.get(connectionId);
        if (!extension) {
          this.#reply(peer, id, undefined, 'browser_unavailable', 'This session’s browser is offline or its pairing was removed. Reconnect it, or explicitly use list_browsers and select_browser.'); return;
        }
        const request = { ...message, clientId: peer.id };
        if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maximumCommandBytes) {
          this.#reply(peer, id, undefined, 'browser_request_too_large', 'This browser command exceeds the connector request limit.'); return;
        }
        const key = `${peer.id}:${id}`;
        if (this.#pending.size >= 256) throw new Error('Too many in-flight browser requests.');
        if (this.#pending.has(key)) throw new Error('Duplicate in-flight browser request.');
        this.#pending.set(key, { client: peer, extension, id, scopeId, switchTo });
        writeLine(extension.socket, request);
        writeLine(peer.socket, { type: 'progress', id, stage: 'broker_forwarded' });
      } catch (error) { this.#reply(peer, id, undefined, 'browser_routing_failed', error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (message.type === 'response' || message.type === 'progress') {
      const key = `${string(message.clientId)}:${string(message.id)}`;
      const pending = this.#pending.get(key);
      if (!pending || pending.extension !== peer) return;
      if (message.type === 'response') {
        this.#pending.delete(key);
        if (pending.client.socket.destroyed) return;
        if (pending.switchTo && !message.error) {
          try {
            if (!this.#extensions.has(pending.switchTo)) throw new Error('The target browser disconnected; select a connected browser again.');
            this.#bind(pending.scopeId, pending.switchTo);
            message = { ...message, result: { connectionId: pending.switchTo } };
          } catch (error) { this.#reply(pending.client, pending.id, undefined, 'browser_switch_failed', String(error)); return; }
        }
      }
      writeLine(pending.client.socket, message);
      return;
    }
    if (message.type === 'status') {
      if (this.#extensions.get(peer.connection!.id) !== peer) return;
      peer.status = { ...peer.status, extensionVersion: string(message.version).slice(0, 80), activeTabId: finiteInteger(message.activeTabId),
        activeTabTitle: string(message.activeTabTitle).slice(0, 1024), activeTabUrl: string(message.activeTabUrl).slice(0, 4096),
        controlledTabCount: Math.max(0, finiteInteger(message.controlledTabCount) ?? 0), lastError: string(message.lastError).slice(0, 1024) };
      this.#publish();
    }
  }

  #reply(peer: Peer, id: string, result?: unknown, code?: string, message?: string): void {
    writeLine(peer.socket, { type: 'response', id, ...(code ? { error: { code, message } } : { result }) });
  }
  #bind(scopeId: string, connectionId: string): void {
    const previous = this.#scopeBindings.get(scopeId);
    if (previous === connectionId) return;
    if (!previous && this.#scopeBindings.size >= 4096) throw new Error('Browser session route limit reached. Remove connector configuration to reset routes.');
    this.#scopeBindings.set(scopeId, connectionId);
    try { writeConnectorFile(this.#routesPath, JSON.stringify({ version: 1, bindings: [...this.#scopeBindings] })); }
    catch (error) { if (previous) this.#scopeBindings.set(scopeId, previous); else this.#scopeBindings.delete(scopeId); throw error; }
  }

  #publish(): void {
    const value = this.status();
    for (const listener of this.#listeners) listener(value);
  }
}

function writeLine(socket: Duplex, value: unknown): void {
  if (socket.destroyed) return;
  if (socket.writableLength > maximumPeerMessageCharacters) { socket.destroy(); return; }
  socket.write(`${JSON.stringify(value)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
