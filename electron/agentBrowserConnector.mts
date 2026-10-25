import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ChromeConnectorBroker } from './chromeConnectorBroker.js';
import { SharedBrowserConnector, type BrowserConnectorHandle } from './sharedBrowserConnector.js';

/** The Agent owns the same connector as the desktop app, under its own account
 * and data root. Browser extensions still use the existing authenticated pairing. */
export class AgentBrowserConnector {
  #broker?: BrowserConnectorHandle;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #enabled = false;
  #error = '';
  constructor(readonly root: string, readonly bundledRoot: string, readonly configurationRoot = root, readonly shared = false, readonly legacyRoot?: string) {}

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(run);
    this.#queue = next;
    return next;
  }
  sync() { return this.#serialize(() => this.#sync()); }
  async #sync() {
    if (this.#closed) return this.status();
    try {
      const apps = await readFile(join(this.configurationRoot, 'config', 'apps.json'), 'utf8').then(text => JSON.parse(text),
        (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {}; throw error; });
      const plugin = apps.plugins?.find((value: { id?: string }) => value.id === 'chrome');
      this.#enabled = apps.serviceEnabled === true && plugin?.installed === true && plugin.enabled === true && plugin.config?.connectionMode !== 'remote_debugging';
      if (this.shared) {
        const preference = await readFile(join(this.root, 'browser-connector', 'preference.json'), 'utf8').then(JSON.parse,
          (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
        if (preference?.enabled === false) this.#enabled = false;
      }
      if (!this.#enabled) { this.#broker?.stop(); this.#broker = undefined; this.#error = ''; return this.status(); }
      if (!this.#broker) {
        const installation = dirname(this.bundledRoot);
        const nativeHostPath = installation.endsWith('.asar')
          ? join(dirname(installation), 'chrome-native-host', 'CardBushBrowserHost.exe')
          : join(installation, 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
        if (process.platform === 'win32' && !await stat(nativeHostPath).then(file => file.isFile(), () => false))
          throw Error('Agent browser connector component is missing. Install the complete Agent package.');
        const broker = this.shared ? new SharedBrowserConnector(this.root, nativeHostPath, join(this.configurationRoot, 'config', 'apps.json')) : new ChromeConnectorBroker(this.root, { nativeHostPath });
        try { await broker.start();
          if (broker instanceof SharedBrowserConnector && this.legacyRoot) await broker.importLegacy(this.legacyRoot);
          this.#broker = broker; }
        catch (error) { broker.stop(); throw error; }
      }
      if (this.#broker instanceof SharedBrowserConnector) await this.#broker.refresh();
      this.#error = '';
    } catch (error) {
      this.#broker?.stop(); this.#broker = undefined;
      this.#error = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }
  status() {
    return { state: this.#error ? 'unavailable' : this.#broker ? 'running' : 'disabled', enabled: this.#enabled,
      shared: this.shared, extensionPath: join(this.bundledRoot, 'plugins', 'chrome', 'extension'),
      ...(this.#error ? { error: this.#error } : {}), ...(this.#broker ? { connector: this.#broker.status() } : {}) };
  }
  call(input: Record<string, unknown>) {
    return this.#serialize(async () => {
      if (this.#closed) throw Error('Agent browser connector is closed.');
      const action = z.enum(['status', 'pair', 'select-default', 'revoke']).default('status').parse(input.action);
      await this.#sync();
      if (action === 'status') return this.status();
      if (!this.#broker) throw Error(this.#error || 'Enable the Browser Use plugin before connecting a browser.');
      if (action === 'pair') return { ...await this.#broker.createPairing({ browser: z.enum(['chrome', 'edge']).parse(input.browser),
        label: z.string().trim().min(1).max(80).optional().parse(input.label) }), shared: this.shared, extensionPath: this.status().extensionPath };
      const id = z.string().regex(/^[a-f0-9]{32}$/).parse(input.id);
      if (action === 'select-default') await this.#broker.setDefaultConnection(id);
      else await this.#broker.revokeConnection(id);
      return this.status();
    });
  }
  close() {
    return this.#serialize(async () => { this.#closed = true; this.#broker?.stop(); this.#broker = undefined; });
  }
}
