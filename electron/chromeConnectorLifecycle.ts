import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { ChromeConnectorBroker } from './chromeConnectorBroker';
import { ChromeConnectorRegistration, chromeConnectorPlatformSupported, type ConnectorRegistry, type ConnectorRegistrationInput } from './chromeConnectorRegistration';
import { assertConnectorFile, connectorDirectory, secureConnectorResource, writeConnectorFile } from './chromeConnectorFiles';

export type ConnectorLifecycleState = 'disabled' | 'enabling' | 'enabled' | 'disabling' | 'needs_repair';

// A per-user OS lease coordinates Store, standalone and development processes.
// The OS releases it on crash; no stale lockfile can block the next startup.
export async function acquireConnectorLease(identity = os.homedir().toLowerCase()): Promise<() => void> {
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\cardbush-connector-owner-${hash}`
    : path.join(os.tmpdir(), `cardbush-connector-owner-${hash}.sock`);
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Another CardBush instance is managing the connector. Close its connector first.')));
    server.listen(endpoint, resolve);
  });
  let released = false;
  return () => { if (!released) { released = true; server.close(); } };
}

export class ChromeConnectorLifecycle {
  broker: ChromeConnectorBroker | null = null;
  state: ConnectorLifecycleState = 'disabled';
  enabled = false;
  error = '';
  cleanupWarning = '';
  #releaseLease: (() => void) | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #unsubscribe: (() => void) | null = null;
  readonly #registration: ChromeConnectorRegistration;
  readonly #statePath: string;

  constructor(readonly input: ConnectorRegistrationInput & { legacyUserDataPath?: string }, readonly changed: () => void, readonly dependencies: {
    registry?: ConnectorRegistry;
    acquireLease?: () => Promise<() => void>;
    createBroker?: () => ChromeConnectorBroker;
    supported?: () => boolean;
    secureDirectory?: (directory: string) => void;
  } = {}) {
    this.#registration = new ChromeConnectorRegistration({ ...input, userDataPath: input.legacyUserDataPath ?? input.userDataPath }, dependencies.registry);
    this.#statePath = path.join(connectorDirectory(input.userDataPath), 'preference.json');
  }
  async restore(): Promise<void> {
    try { await this.#restore(); }
    catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.state = 'needs_repair';
      this.changed();
      throw error;
    }
  }
  async #restore(): Promise<void> {
    assertConnectorFile(this.#statePath);
    if (fs.existsSync(this.#statePath)) {
      const state = JSON.parse(fs.readFileSync(this.#statePath, 'utf8'));
      if (![1, 2].includes(state?.version) || typeof state.enabled !== 'boolean') throw new Error('Invalid connector preference. Enable or remove the connector to repair it.');
      if (state.version === 2 && state.enabled === true) { await this.setEnabled(true); return; }
    }
    // Old installations had implicit registration, not an explicit enable choice.
    // Clean only a verified legacy registration and leave foreign installs alone.
    if (fs.existsSync(this.#registration.manifestPath) && (this.dependencies.supported ?? chromeConnectorPlatformSupported)()) {
      await this.setEnabled(false);
    }
  }
  setEnabled(enabled: boolean, remove = false): Promise<void> {
    const operation = this.#queue.catch(() => {}).then(async () => {
      if (this.#disposed) throw new Error('Connector is shutting down.');
      if (!(this.dependencies.supported ?? chromeConnectorPlatformSupported)()) throw new Error('Browser Use requires Windows 11.');
      this.error = '';
      this.state = enabled ? 'enabling' : 'disabling'; this.changed();
      try {
        this.#releaseLease ??= await (this.dependencies.acquireLease ?? acquireConnectorLease)();
        if (this.#disposed) throw new Error('Connector is shutting down.');
        const directory = connectorDirectory(this.input.userDataPath);
        if (!this.broker) this.#assertNoLiveLegacyBroker(directory);
        if (this.#registration.directory !== directory) this.#assertNoLiveLegacyBroker(this.#registration.directory);
        fs.mkdirSync(directory, { recursive: true });
        this.#cleanupLegacy();
        if (enabled) {
          (this.dependencies.secureDirectory ?? (dir => secureConnectorResource(this.input.nativeHostPath, 'directory', dir)))(directory);
          await this.#enable();
        }
        else await this.#disable(remove);
      } catch (error) {
        if (!enabled) { this.enabled = false; this.#stopBroker(); }
        if (!this.broker && this.#releaseLease) {
          try { this.#persist(false, remove); } catch { /* Report the original repair error; never restart a broker here. */ }
        }
        this.error = error instanceof Error ? error.message : String(error);
        this.state = 'needs_repair';
        if (!this.broker) { this.#releaseLease?.(); this.#releaseLease = null; }
        throw error;
      } finally { this.changed(); }
    });
    this.#queue = operation;
    return operation;
  }
  #persist(enabled: boolean, removed = false): void {
    connectorDirectory(this.input.userDataPath);
    writeConnectorFile(this.#statePath, JSON.stringify({ version: 2, enabled, removed }));
    this.enabled = enabled;
  }
  #assertNoLiveLegacyBroker(directory: string): void {
    const file = path.join(directory, 'bridge.json');
    assertConnectorFile(file);
    if (!fs.existsSync(file)) return;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(config.pid) && config.pid > 0) {
      try { process.kill(config.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      throw new Error('A previous CardBush process still owns the connector. Exit that application before enabling or removing it.');
    }
  }
  async #enable(): Promise<void> {
    if (this.broker) { this.#persist(true); this.state = 'enabled'; return; }
    const broker = this.dependencies.createBroker?.() ?? new ChromeConnectorBroker(this.input.userDataPath, { nativeHostPath: this.input.nativeHostPath });
    try {
      await broker.start();
      if (this.#disposed) throw new Error('Connector is shutting down.');
      this.#persist(true);
      this.broker = broker;
      this.#unsubscribe = broker.onStatus(this.changed);
      this.state = 'enabled';
    } catch (error) {
      try { broker.stop(); } finally { this.#persist(false); }
      throw error;
    }
  }
  async #disable(remove: boolean): Promise<void> {
    // Persist first: even a crash during cleanup must not re-enable the connector.
    try { this.#persist(false, remove); await this.broker?.disableExtension(); }
    finally { this.#stopBroker(); }
    const bridge = path.join(connectorDirectory(this.input.userDataPath), 'bridge.json');
    assertConnectorFile(bridge);
    fs.rmSync(bridge, { force: true });
    const pairing = path.join(connectorDirectory(this.input.userDataPath), 'pairing.json');
    assertConnectorFile(pairing); fs.rmSync(pairing, { force: true });
    if (remove) {
      const routes = path.join(connectorDirectory(this.input.userDataPath), 'routes.json');
      assertConnectorFile(routes); fs.rmSync(routes, { force: true });
    }
    // preference.json is intentionally retained as an explicit disabled marker.
    // Never recursively remove this directory or unrelated files.
    this.state = 'disabled';
    this.#releaseLease?.(); this.#releaseLease = null;
  }
  #stopBroker(): void {
    this.#unsubscribe?.(); this.#unsubscribe = null;
    this.broker?.stop(); this.broker = null;
  }
  #cleanupLegacy(): void {
    this.cleanupWarning = '';
    if (!fs.existsSync(this.#registration.manifestPath)) return;
    const status = this.#registration.inspect();
    if (status.registrationConflict) { this.cleanupWarning = status.registrationConflict; return; }
    if (this.input.msixPackage && status.bridgeRegistered) {
      // Without a virtualization opt-out, a packaged deletion can only create a
      // tombstone. Keep the evidence and report the required external migration.
      this.cleanupWarning = 'legacy_external_registration';
      return;
    }
    this.#registration.remove();
    const bridge = path.join(this.#registration.directory, 'bridge.json');
    assertConnectorFile(bridge); fs.rmSync(bridge, { force: true });
  }
  dispose(): void {
    this.#disposed = true;
    this.#stopBroker();
    void this.#queue.finally(() => { this.#releaseLease?.(); this.#releaseLease = null; }).catch(() => {});
    // Ordinary app exit preserves pairing and intent only inside app data.
  }
}
