import { readFile, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ChromeConnectorBroker } from './chromeConnectorBroker.js';
import { SharedBrowserConnector, type BrowserConnectorHandle } from './sharedBrowserConnector.js';
import { connectorDirectory, assertConnectorFile } from './chromeConnectorFiles.js';
import { writePrivateJson } from './atomicJsonFile.mjs';
import { redactTroubleshootingText } from './pluginTroubleshooting.mjs';

function startupFailure(error: unknown) {
  const message = redactTroubleshootingText(error instanceof Error ? error.message : String(error))
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]').slice(0, 1500);
  const code = /older CardBush process/.test(message) ? 'browser_connector_legacy_active'
    : /component is missing/.test(message) ? 'browser_connector_component_missing'
    : /EPERM|EACCES|denied|Cannot verify the previous/.test(message) ? 'browser_connector_access_denied'
    : /Invalid|JSON|configuration must/.test(message) ? 'browser_connector_config_invalid' : 'browser_connector_start_failed';
  const nextStep = code === 'browser_connector_legacy_active'
    ? 'Close the older CardBush App and CLI normally, then retry /browser status. Saved browser connections are retained.'
    : code === 'browser_connector_component_missing'
      ? 'For a source checkout, run npm run build:agent and reopen the CLI. Otherwise reinstall the complete Agent package.'
      : 'Check /browser status and the current CLI /logs for this host error. Fix the reported host failure, then retry; reinstalling or re-pairing the browser extension will not fix host startup.';
  return { code, message, nextStep };
}

/** The Agent owns the same connector as the desktop app, under its own account
 * and data root. Browser extensions still use the existing authenticated pairing. */
export class AgentBrowserConnector {
  #broker?: BrowserConnectorHandle;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #enabled = false;
  #error = '';
  #failure?: ReturnType<typeof startupFailure>;
  #timer?: ReturnType<typeof setTimeout>;
  #lastDiagnostic = '';
  #failureCount = 0;
  #configurationSignature = '';
  readonly healthPath: string;
  constructor(readonly root: string, readonly bundledRoot: string, readonly configurationRoot = root, readonly shared = false, readonly legacyRoot?: string,
    private readonly diagnostic: (stream: 'stderr', text: string) => void = (_stream, text) => process.stderr.write(text)) {
    // One health file per host lifetime: another App/CLI cannot overwrite its
    // diagnostics, and a restarted host never reads an old failure as current.
    this.healthPath = join(connectorDirectory(legacyRoot ?? root), `health-${randomUUID()}.json`);
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => {}).then(run);
    this.#queue = next;
    return next;
  }
  #report(text: string) {
    try { this.diagnostic('stderr', text); } catch { /* Logging cannot interrupt connector recovery. */ }
  }
  sync() { return this.#serialize(() => this.#sync()); }
  async #sync(retry = false) {
    if (this.#closed) return this.status();
    if (retry) this.#failureCount = 0;
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
      const signature = JSON.stringify([this.#enabled, plugin?.config?.connectionMode]);
      if (signature !== this.#configurationSignature) { this.#configurationSignature = signature; this.#failureCount = 0; }
      if (!this.#enabled) { this.#broker?.stop(); this.#broker = undefined; this.#error = ''; this.#failure = undefined; this.#failureCount = 0; return this.status(); }
      if (this.#failureCount >= 3) return this.status();
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
      if (this.#broker instanceof SharedBrowserConnector) {
        const shared = await this.#broker.refresh(retry);
        if (shared.recoveryPaused) throw new Error(shared.lastError || 'Shared browser connector recovery paused.');
      }
      this.#error = ''; this.#failure = undefined; this.#failureCount = 0;
    } catch (error) {
      if (this.#broker?.status().recoveryPaused) this.#failureCount = 3;
      else { this.#broker?.stop(); this.#broker = undefined; this.#failureCount++; }
      this.#failure = startupFailure(error); this.#error = this.#failure.message;
      if (this.#failureCount >= 3) this.#failure.nextStep += ' Automatic recovery has stopped after repeated failures. Use /browser retry when ready.';
    } finally {
      if (!this.#closed) {
        const health = { protocol: 'cardbush.browser_connector_health.v1', configPath: join(this.root, 'browser-connector', 'bridge.json'),
          updatedAt: new Date().toISOString(), state: this.status().state, ...(this.#failure ? { error: this.#failure } : {}) };
        const signature = JSON.stringify([health.state, health.error]);
        if (signature !== this.#lastDiagnostic) {
          this.#lastDiagnostic = signature;
          this.#report(JSON.stringify({ type: 'browser_connector_health', ...health }) + '\n');
        }
        try { assertConnectorFile(this.healthPath); await writePrivateJson(this.healthPath, health); }
        catch (error) { this.#report(`Browser connector health publication failed: ${startupFailure(error).message}\n`); }
        clearTimeout(this.#timer);
        if (!this.#closed && this.#failure && this.#failureCount < 3) {
          this.#timer = setTimeout(() => { void this.sync().catch(() => {}); }, 5000);
          this.#timer.unref();
        }
      }
    }
    return this.status();
  }
  status() {
    return { state: this.#error ? 'unavailable' : this.#broker ? 'running' : 'disabled', enabled: this.#enabled,
      shared: this.shared, extensionPath: join(this.bundledRoot, 'plugins', 'chrome', 'extension'),
      recoveryPaused: this.#failureCount >= 3 || this.#broker?.status().recoveryPaused === true,
      ...(this.#error ? { error: this.#error, errorCode: this.#failure?.code, nextStep: this.#failure?.nextStep } : {}),
      ...(this.#broker ? { connector: this.#broker.status() } : {}) };
  }
  call(input: Record<string, unknown>) {
    return this.#serialize(async () => {
      if (this.#closed) throw Error('Agent browser connector is closed.');
      const action = z.enum(['status', 'retry', 'pair', 'select-default', 'revoke']).default('status').parse(input.action);
      await this.#sync(action === 'retry' || action === 'pair');
      if (action === 'status' || action === 'retry') return this.status();
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
    this.#closed = true; clearTimeout(this.#timer);
    return this.#serialize(async () => { this.#broker?.stop(); this.#broker = undefined;
      await rm(this.healthPath, { force: true }); });
  }
}
