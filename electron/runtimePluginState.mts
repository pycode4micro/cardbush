import { join } from 'node:path';
import type { RuntimeExtensionFactory } from '@cardbush/bush-runtime';

/** Installed bundle bytes are the identity. Unchanged packages retain their live state. */
export class RuntimePluginState {
  #pending?: Promise<string | undefined>;
  #loaded = new Map<string, string>();
  #reportedError?: string;
  constructor(readonly options: {
    dataRoot: string;
    host: {
      installExtension: (create: RuntimeExtensionFactory, options: { id: string; enabled: boolean; dataDirectory: string; replace: boolean }) => string;
      setExtensionEnabled: (id: string, enabled: boolean) => void;
      removeExtension: (id: string) => void;
      hasActiveTurns: () => boolean;
      isExtensionBusy: (id: string) => boolean;
    };
    loadEnabled: () => Promise<Array<{ id: string; hash: string; source: string }>>;
    reportError: (message: string) => void;
  }) {}

  refresh(): Promise<string | undefined> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #refresh(): Promise<string | undefined> {
    const errors: string[] = [];
    try {
      const packages = await this.options.loadEnabled();
      const enabled = new Set(packages.map(pkg => pkg.id));
      for (const id of this.#loaded.keys()) if (!enabled.has(id)) {
        this.options.host.removeExtension(id);
        if (!this.options.host.isExtensionBusy(id)) this.#loaded.delete(id);
      }
      for (const pkg of packages) {
        try {
          if (this.#loaded.get(pkg.id) === pkg.hash) { this.options.host.setExtensionEnabled(pkg.id, true); continue; }
          if (this.#loaded.has(pkg.id) && this.options.host.isExtensionBusy(pkg.id)) {
            this.options.host.setExtensionEnabled(pkg.id, false);
            errors.push(`${pkg.id}: update pending until active turns finish`);
            continue;
          }
          // Give stack traces a bounded, recognizable identity instead of embedding the entire bundle.
          const source = `${pkg.source}\n//# sourceURL=cardbush-plugin://${encodeURIComponent(pkg.id)}/runtime-${pkg.hash}.mjs\n`;
          const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
          if (typeof module.default !== 'function' || module.apiVersion !== 1) throw new Error('Invalid Runtime plugin entry or API version.');
          this.options.host.installExtension(module.default as RuntimeExtensionFactory, { id: pkg.id, enabled: true, replace: true, dataDirectory: join(this.options.dataRoot, pkg.id) });
          this.#loaded.set(pkg.id, pkg.hash);
        } catch (error) {
          if (this.#loaded.has(pkg.id)) this.options.host.setExtensionEnabled(pkg.id, false);
          errors.push(`${pkg.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      for (const id of this.#loaded.keys()) this.options.host.setExtensionEnabled(id, false);
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const message = errors.length ? errors.join('; ') : undefined;
    if (message && message !== this.#reportedError) this.options.reportError(message);
    this.#reportedError = message;
    return message;
  }
}
