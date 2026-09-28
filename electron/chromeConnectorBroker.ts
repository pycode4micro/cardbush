import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { createWebSocketStream, type WebSocket } from 'ws';
import type { Duplex } from 'node:stream';
import { ChromeConnectorWebSocket } from './chromeConnectorWebSocket';
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
};

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
  #extension: Peer | null = null;
  #started = false;
  #extensionVersion = '';
  #connectedAt = '';
  #activeTabId: number | undefined;
  #activeTabTitle = '';
  #activeTabUrl = '';
  #controlledTabCount = 0;
  #lastError = '';

  constructor(readonly userDataPath: string, readonly options: {
    nativeHostPath?: string; handshakeTimeoutMs?: number; maximumPeers?: number;
  } = {}) {
    this.#webSocket = new ChromeConnectorWebSocket(connectorDirectory(userDataPath), socket => this.#acceptExtension(socket), options);
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
    this.#extension = null;
    this.#extensionVersion = '';
    this.#connectedAt = '';
    this.#activeTabId = undefined;
    this.#activeTabTitle = '';
    this.#activeTabUrl = '';
    this.#controlledTabCount = 0;
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
    return {
      protocol: chromeConnectorProtocol,
      bridgeRunning: this.#started,
      extensionConnected: this.#extension != null,
      ...(this.#extensionVersion ? { extensionVersion: this.#extensionVersion } : {}),
      ...(this.#connectedAt ? { connectedAt: this.#connectedAt } : {}),
      ...(this.#activeTabId != null ? { activeTabId: this.#activeTabId } : {}),
      ...(this.#activeTabTitle ? { activeTabTitle: this.#activeTabTitle } : {}),
      ...(this.#activeTabUrl ? { activeTabUrl: this.#activeTabUrl } : {}),
      controlledTabCount: this.#controlledTabCount,
      paired: this.#webSocket.paired,
      transport: 'loopback_websocket',
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  onStatus(listener: (status: ChromeConnectorStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  createPairing(): { code: string; expiresAt: string } { return this.#webSocket.createPairing(); }

  releaseAll(reason = 'explicit_release'): void {
    if (!this.#extension) return;
    writeLine(this.#extension.socket, {
      type: 'control',
      method: 'debugger.detachAll',
      reason,
    });
  }

  async disableExtension(): Promise<void> {
    const extension = this.#extension;
    if (!extension) return;
    // Give the extension time to persist its disabled state and release Chrome
    // debugger sessions before closing the transport.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      extension.socket.once('close', () => { clearTimeout(timer); resolve(); });
      writeLine(extension.socket, { type: 'control', method: 'connector.disable' });
    });
  }

  suspendAll(reason = 'turn_terminal'): void {
    if (!this.#extension) return;
    writeLine(this.#extension.socket, {
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
        socket.destroy(new Error('Chrome Connector peer exceeded the message buffer limit.'));
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
          socket.destroy(new Error('Chrome Connector peer sent invalid JSON.'));
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
            socket.destroy(new Error('Chrome Connector peer authentication failed.'));
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
      if (this.#extension === pending) {
        this.#extension = null;
        this.#extensionVersion = '';
        this.#connectedAt = '';
        this.#activeTabId = undefined;
        this.#activeTabTitle = '';
        this.#activeTabUrl = '';
        this.#controlledTabCount = 0;
        this.#publish();
      }
    });
  }

  #acceptExtension(client: WebSocket): void {
    this.#extension?.socket.destroy();
    const socket = createWebSocketStream(client, { encoding: 'utf8', decodeStrings: false });
    client.once('close', () => socket.destroy());
    const peer: Peer = { id: randomUUID(), role: 'extension', socket, buffer: '' };
    this.#extension = peer;
    this.#sockets.add(socket); this.#peers.set(peer.id, peer);
    this.#extensionVersion = ''; this.#connectedAt = new Date().toISOString(); this.#lastError = '';
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
      if (this.#extension !== peer) return;
      this.#extension = null; this.#extensionVersion = ''; this.#connectedAt = '';
      this.#activeTabId = undefined; this.#activeTabTitle = ''; this.#activeTabUrl = ''; this.#controlledTabCount = 0;
      this.#publish();
    });
    writeLine(socket, { type: 'connector_ready', protocol: chromeConnectorProtocol });
    this.#publish();
  }

  #route(peer: Peer, message: Record<string, unknown>): void {
    if (peer.role === 'mcp') {
      if (message.type !== 'request') return;
      if (!this.#extension) {
        writeLine(peer.socket, {
          type: 'response',
          id: message.id,
          error: {
            code: 'chrome_connector_unavailable',
            message: 'The CardBush Browser Connector extension is not connected. Open Chrome and enable the extension.',
          },
        });
        return;
      }
      const request = { ...message, clientId: peer.id };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maximumCommandBytes) {
        writeLine(peer.socket, {
          type: 'response',
          id: message.id,
          error: {
            code: 'chrome_connector_request_too_large',
            message: 'This Chrome command exceeds the connector request limit.',
          },
        });
        return;
      }
      writeLine(this.#extension.socket, request);
      writeLine(peer.socket, { type: 'progress', id: message.id, stage: 'broker_forwarded' });
      return;
    }
    if (message.type === 'response' || message.type === 'progress') {
      if (this.#extension !== peer) return;
      const clientId = string(message.clientId);
      const target = this.#peers.get(clientId);
      if (target?.role === 'mcp') writeLine(target.socket, message);
      return;
    }
    if (message.type === 'status') {
      if (this.#extension !== peer) return;
      this.#extensionVersion = string(message.version) || this.#extensionVersion;
      this.#activeTabId = finiteInteger(message.activeTabId);
      this.#activeTabTitle = string(message.activeTabTitle);
      this.#activeTabUrl = string(message.activeTabUrl);
      this.#controlledTabCount = finiteInteger(message.controlledTabCount) ?? 0;
      this.#lastError = string(message.lastError);
      this.#publish();
    }
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
