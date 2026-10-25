import fs from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeConnectorBroker, type ChromeConnectorStatus } from './chromeConnectorBroker';
import { assertConnectorFile, connectorDirectory } from './chromeConnectorFiles';
import { chromeConnectorProtocol } from './chromeConnectorConstants';
import { requestBrowserConnectionApproval } from './browserConnectionApproval';

export type BrowserConnectorHandle = Pick<ChromeConnectorBroker, 'configPath' | 'status' | 'onStatus' | 'stop'> & {
  start(): Promise<void>;
  createPairing(input?: Parameters<ChromeConnectorBroker['createPairing']>[0]): ReturnType<ChromeConnectorBroker['createPairing']> | Promise<ReturnType<ChromeConnectorBroker['createPairing']>>;
  setDefaultConnection(id: string): void | Promise<unknown>;
  revokeConnection(id: string): void | Promise<unknown>;
  disableExtension(forget?: boolean): Promise<void>;
};

/** App and local CLI clients elect one broker for the same profile. A crash or
 * normal owner exit hands ownership to a surviving client; only connections are
 * restored, never an interrupted browser command. Remote Agents do not use this. */
export class SharedBrowserConnector implements BrowserConnectorHandle {
  readonly configPath: string;
  readonly #managerPath: string;
  #owner?: ChromeConnectorBroker;
  #socket?: Socket;
  #stopped = true;
  #recovering?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  #watcher?: ReturnType<typeof setInterval>;
  #status: ChromeConnectorStatus = { protocol: chromeConnectorProtocol, bridgeRunning: false,
    extensionConnected: false, controlledTabCount: 0, paired: false, transport: 'loopback_websocket',
    defaultConnectionId: '', connections: [] };
  readonly #listeners = new Set<(status: ChromeConnectorStatus) => void>();
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly root: string, readonly nativeHostPath: string, readonly appsConfigPath?: string) {
    this.configPath = path.join(connectorDirectory(root), 'bridge.json');
    this.#managerPath = path.join(connectorDirectory(root), 'manager.json');
  }
  status() { return this.#status; }
  async refresh() { if (this.#permitted()) this.#publish(await this.#call('status') as ChromeConnectorStatus); return this.#status; }
  async importLegacy(root: string) {
    const directory = connectorDirectory(root), pairingPath = path.join(directory, 'pairing.json');
    assertConnectorFile(pairingPath);
    if (!fs.existsSync(pairingPath)) return;
    const saved = JSON.parse(fs.readFileSync(pairingPath, 'utf8'));
    if (![2, 3].includes(saved.version)) throw new Error('Invalid legacy CLI browser pairing configuration.');
    const routesPath = path.join(directory, 'routes.json'); assertConnectorFile(routesPath);
    const routes = fs.existsSync(routesPath) ? JSON.parse(fs.readFileSync(routesPath, 'utf8')) : { version: 1, bindings: [] };
    if (routes.version !== 1) throw new Error('Invalid legacy CLI browser routes.');
    const credentials = saved.version === 2 ? (saved.credential ? [{ ...saved.credential, browser: 'chrome', label: 'Google Chrome' }] : []) : saved.credentials;
    await this.#call('import', { credentials, defaultConnectionId: saved.version === 2 ? saved.credential?.id : saved.defaultConnectionId, bindings: routes.bindings });
  }
  onStatus(listener: (status: ChromeConnectorStatus) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #publish(status: ChromeConnectorStatus) { this.#status = status; for (const listener of this.#listeners) listener(status); }
  async start() {
    this.#stopped = false;
    await this.#recover();
    this.#watcher ??= setInterval(() => {
      if (this.#stopped) return;
      if (!this.#permitted()) {
        this.#socket?.destroy(); this.#owner?.stop(); this.#owner = undefined;
      } else if (!this.#socket) void this.#recover().catch(() => {});
    }, 1000);
    this.#watcher.unref();
  }
  #permitted(): boolean {
    try {
      const preferencePath = path.join(connectorDirectory(this.root), 'preference.json');
      assertConnectorFile(preferencePath);
      if (fs.existsSync(preferencePath) && JSON.parse(fs.readFileSync(preferencePath, 'utf8')).enabled === false) return false;
      if (this.appsConfigPath) {
        const apps = JSON.parse(fs.readFileSync(this.appsConfigPath, 'utf8'));
        const plugin = apps.plugins?.find((value: { id?: string }) => value.id === 'chrome');
        return apps.serviceEnabled === true && plugin?.installed === true && plugin.enabled === true && plugin.config?.connectionMode !== 'remote_debugging';
      }
      return true;
    } catch { return false; }
  }
  #recover(): Promise<void> {
    if (this.#recovering) return this.#recovering;
    this.#recovering = this.#connect().finally(() => { this.#recovering = undefined; });
    return this.#recovering;
  }
  async #connect() {
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (!this.#stopped && Date.now() < deadline) {
      if (!this.#permitted()) return;
      try { await this.#attach(); return; } catch (error) { lastError = error; }
      if (this.#stopped) return;
      if (!this.#owner) {
        const owner = new ChromeConnectorBroker(this.root, { nativeHostPath: this.nativeHostPath, shared: true,
          requestApproval: (browser, signal) => requestBrowserConnectionApproval(this.nativeHostPath, browser, signal) });
        try {
          assertConnectorFile(this.configPath);
          if (fs.existsSync(this.configPath)) {
            const previous = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            if (previous.endpoint !== owner.endpoint && Number.isInteger(previous.pid) && previous.pid > 0) {
              let alive = true;
              try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; alive = false; }
              if (alive) throw new Error('An older CardBush process is using this browser connection. Restart the App and local CLI to enable shared connections.');
            }
          }
          await owner.start(); if (this.#stopped) { owner.stop(); return; } this.#owner = owner;
        }
        catch (error) {
          owner.stop(); lastError = error;
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        }
      }
      await delay(100);
    }
    if (!this.#stopped) throw lastError ?? new Error('The shared browser connector could not start.');
  }
  async #attach(): Promise<void> {
    connectorDirectory(this.root); assertConnectorFile(this.#managerPath);
    if (fs.statSync(this.#managerPath).size > 4096) throw new Error('Invalid browser manager configuration.');
    const config = JSON.parse(fs.readFileSync(this.#managerPath, 'utf8'));
    if (config.protocol !== chromeConnectorProtocol || !/^[a-f0-9]{64}$/.test(config.token)
      || typeof config.endpoint !== 'string' || (process.platform === 'win32'
        ? !/^\\\\\.\\pipe\\cardbush-browser-connector-[a-f0-9]{24}$/.test(config.endpoint)
        : config.endpoint !== path.join(this.root, 'browser-connector', 'bridge.sock'))) throw new Error('Invalid browser manager endpoint.');
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(config.endpoint);
      let ready = false, buffer = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Browser manager handshake timed out.')); }, 1500);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', role: 'manager', protocol: chromeConnectorProtocol, token: config.token }) + '\n'));
      socket.on('error', error => { if (!ready) reject(error); });
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 128 * 1024) { socket.destroy(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          let message;
          try { message = JSON.parse(buffer.slice(0, end)); } catch { socket.destroy(); return; }
          buffer = buffer.slice(end + 1);
          if (!ready) {
            if (message.type !== 'hello_ack' || message.protocol !== chromeConnectorProtocol || !message.status) { socket.destroy(); return; }
            if (this.#stopped) { socket.destroy(); resolve(); return; }
            ready = true; clearTimeout(timer); this.#socket = socket; this.#publish(message.status); resolve();
          } else if (message.type === 'status') this.#publish(message.status);
          else if (message.type === 'managed') {
            const pending = this.#pending.get(message.id);
            if (pending) { this.#pending.delete(message.id); clearTimeout(pending.timer);
              if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result); }
          }
        }
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!ready) { reject(new Error('Browser manager disconnected.')); return; }
        if (this.#socket !== socket) return;
        this.#socket = undefined;
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser connector disconnected; the operation was not replayed.')); }
        this.#pending.clear();
        this.#publish({ ...this.#status, bridgeRunning: false, extensionConnected: false,
          connections: this.#status.connections.map(connection => ({ ...connection, connected: false })) });
        this.#scheduleRecovery();
      });
    });
  }
  #scheduleRecovery() {
    clearTimeout(this.#timer);
    if (!this.#stopped) this.#timer = setTimeout(() => { void this.#recover().catch(error => {
      this.#publish({ ...this.#status, lastError: error instanceof Error ? error.message : String(error) }); this.#scheduleRecovery();
    }); }, 500);
    this.#timer?.unref();
  }
  async #call(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#stopped) throw new Error('Browser connector is closed.');
    if (action !== 'disable' && !this.#permitted()) throw new Error('Browser connector is disabled.');
    if (!this.#socket) await this.#recover();
    const socket = this.#socket;
    if (!socket || socket.destroyed) throw new Error('Browser connector is reconnecting.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Browser management timed out; the operation was not replayed.')); }, 5000);
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ type: 'manage', id, action, input }) + '\n');
    });
  }
  async createPairing(input: Parameters<ChromeConnectorBroker['createPairing']>[0] = {}) {
    return await this.#call('pair', input) as ReturnType<ChromeConnectorBroker['createPairing']>;
  }
  async setDefaultConnection(id: string) { this.#publish(await this.#call('default', { id }) as ChromeConnectorStatus); }
  async revokeConnection(id: string) { this.#publish(await this.#call('revoke', { id }) as ChromeConnectorStatus); }
  async disableExtension(forgetPairing = false) { await this.#call('disable', { forgetPairing }); }
  stop() {
    this.#stopped = true; clearTimeout(this.#timer); clearInterval(this.#watcher); this.#watcher = undefined;
    this.#socket?.destroy(); this.#owner?.stop(); this.#owner = undefined;
  }
}
