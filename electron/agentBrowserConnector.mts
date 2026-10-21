import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ChromeConnectorBroker } from './chromeConnectorBroker.js';

/** The Agent owns the same connector as the desktop app, under its own account
 * and data root. Browser extensions still use the existing authenticated pairing. */
export class AgentBrowserConnector {
  #broker?: ChromeConnectorBroker;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #enabled = false;
  #error = '';
  constructor(readonly root: string, readonly bundledRoot: string) {}

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(run);
    this.#queue = next;
    return next;
  }
  sync() { return this.#serialize(() => this.#sync()); }
  async #sync() {
    if (this.#closed) return this.status();
    try {
      const apps = await readFile(join(this.root, 'config', 'apps.json'), 'utf8').then(text => JSON.parse(text),
        (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {}; throw error; });
      const plugin = apps.plugins?.find((value: { id?: string }) => value.id === 'chrome');
      this.#enabled = apps.serviceEnabled === true && plugin?.installed === true && plugin.enabled === true && plugin.config?.connectionMode !== 'remote_debugging';
      if (!this.#enabled) { this.#broker?.stop(); this.#broker = undefined; this.#error = ''; return this.status(); }
      if (!this.#broker) {
        const nativeHostPath = join(dirname(this.bundledRoot), 'dist-native', 'chrome-connector', 'CardBushBrowserHost.exe');
        if (process.platform === 'win32' && !await stat(nativeHostPath).then(file => file.isFile(), () => false))
          throw Error('Agent browser connector component is missing. Install the complete Agent package.');
        const broker = new ChromeConnectorBroker(this.root, { nativeHostPath });
        try { await broker.start(); this.#broker = broker; }
        catch (error) { broker.stop(); throw error; }
      }
      this.#error = '';
    } catch (error) {
      this.#broker?.stop(); this.#broker = undefined;
      this.#error = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }
  status() {
    return { state: this.#error ? 'unavailable' : this.#broker ? 'running' : 'disabled', enabled: this.#enabled,
      ...(this.#error ? { error: this.#error } : {}), ...(this.#broker ? { connector: this.#broker.status() } : {}) };
  }
  call(input: Record<string, unknown>) {
    return this.#serialize(async () => {
      if (this.#closed) throw Error('Agent browser connector is closed.');
      const action = z.enum(['status', 'pair', 'select-default', 'revoke']).default('status').parse(input.action);
      await this.#sync();
      if (action === 'status') return this.status();
      if (!this.#broker) throw Error(this.#error || 'Enable the Browser Use plugin before connecting a browser.');
      if (action === 'pair') return this.#broker.createPairing({ browser: z.enum(['chrome', 'edge']).parse(input.browser),
        label: z.string().trim().min(1).max(80).optional().parse(input.label) });
      const id = z.string().regex(/^[a-f0-9]{32}$/).parse(input.id);
      if (action === 'select-default') this.#broker.setDefaultConnection(id);
      else this.#broker.revokeConnection(id);
      return this.status();
    });
  }
  close() {
    return this.#serialize(async () => { this.#closed = true; this.#broker?.stop(); this.#broker = undefined; });
  }
}
