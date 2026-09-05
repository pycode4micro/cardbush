import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';

import {
  chromeConnectorConfigDirectoryName,
  chromeConnectorConfigFileName,
  chromeConnectorProtocol,
} from './chromeConnectorConstants';

type PeerRole = 'extension' | 'mcp';

const maximumPeerMessageCharacters = 64 * 1024 * 1024;
const maximumNativeHostOutboundBytes = 1024 * 1024;

type Peer = {
  id: string;
  role: PeerRole;
  socket: Socket;
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
}

export class ChromeConnectorBroker {
  readonly configPath: string;
  readonly endpoint: string;
  readonly #token = randomBytes(32).toString('hex');
  readonly #server = net.createServer();
  readonly #peers = new Map<string, Peer>();
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

  constructor(readonly userDataPath: string) {
    const identity = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16);
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
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
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
    fs.writeFileSync(this.configPath, JSON.stringify({
      protocol: chromeConnectorProtocol,
      endpoint: this.endpoint,
      token: this.#token,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.#started = true;
    this.#publish();
  }

  stop(): void {
    if (!this.#started) return;
    for (const peer of this.#peers.values()) peer.socket.destroy();
    this.#peers.clear();
    this.#extension = null;
    this.#started = false;
    this.#server.close();
    try {
      fs.unlinkSync(this.configPath);
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
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  onStatus(listener: (status: ChromeConnectorStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  releaseAll(reason = 'explicit_release'): void {
    if (!this.#extension) return;
    writeLine(this.#extension.socket, {
      type: 'control',
      method: 'debugger.detachAll',
      reason,
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
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const temporaryId = randomUUID();
    const pending: Peer = { id: temporaryId, role: 'mcp', socket, buffer: '' };
    let authenticated = false;
    socket.on('data', (chunk: string) => {
      pending.buffer += chunk;
      if (pending.buffer.length > maximumPeerMessageCharacters) {
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
          const role = message.role === 'extension' || message.role === 'mcp'
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
          pending.role = role;
          pending.id = typeof message.clientId === 'string' && message.clientId
            ? message.clientId
            : temporaryId;
          this.#peers.set(pending.id, pending);
          if (role === 'extension') {
            this.#extension?.socket.destroy();
            this.#extension = pending;
            this.#extensionVersion = string(message.version);
            this.#connectedAt = new Date().toISOString();
            this.#lastError = '';
            this.#publish();
          }
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
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maximumNativeHostOutboundBytes) {
        writeLine(peer.socket, {
          type: 'response',
          id: message.id,
          error: {
            code: 'chrome_connector_request_too_large',
            message: 'This Chrome command exceeds the native messaging request limit.',
          },
        });
        return;
      }
      writeLine(this.#extension.socket, request);
      return;
    }
    if (message.type === 'response') {
      const clientId = string(message.clientId);
      const target = this.#peers.get(clientId);
      if (target?.role === 'mcp') writeLine(target.socket, message);
      return;
    }
    if (message.type === 'status') {
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

function writeLine(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
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
