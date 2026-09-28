import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { chromeConnectorExtensionOrigin, chromeConnectorNativeHostName } from './chromeConnectorConstants';
import { assertConnectorFile, connectorDirectory } from './chromeConnectorFiles';

export const chromeConnectorRegistryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${chromeConnectorNativeHostName}`;
type RegistryView = '32' | '64';
export interface ConnectorRegistry {
  read(view: RegistryView): string | null;
  remove(view: RegistryView, expectedPath: string): void;
}
function reg(args: string[]): string {
  return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
}
function samePath(left: string | null, right: string): boolean {
  return left != null && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
export function windowsConnectorRegistry(nativeHostPath: string): ConnectorRegistry {
  const inspect = (view: RegistryView): { manifestPath: string | null; empty: boolean } => JSON.parse(execFileSync(
    nativeHostPath, ['--registry-read', view], { encoding: 'utf8', windowsHide: true, timeout: 5000 },
  ));
  return {
    read(view) {
      return inspect(view).manifestPath;
    },
    remove(view, expectedPath) {
      if (!samePath(this.read(view), expectedPath)) throw new Error('Chrome host registration changed; cleanup was stopped.');
      reg(['delete', chromeConnectorRegistryKey, '/ve', '/f', `/reg:${view}`]);
      // Preserve any other values/subkeys. Never delete the parent registration tree.
      if (inspect(view).empty) reg(['delete', chromeConnectorRegistryKey, '/f', `/reg:${view}`]);
    },
  };
}

export interface ConnectorRegistrationInput {
  userDataPath: string;
  nativeHostPath: string;
  msixPackage?: boolean;
}
export function chromeConnectorPlatformSupported(): boolean {
  return process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22000;
}
export function chromeConnectorLaunchPath(nativeHostPath: string, msixPackage = process.windowsStore === true,
  localAppData = process.env.LOCALAPPDATA): string {
  if (!msixPackage) return nativeHostPath;
  if (!localAppData) throw new Error('LOCALAPPDATA is required to locate the browser bridge app execution alias.');
  return path.join(localAppData, 'Microsoft', 'WindowsApps', 'CardBushBrowserHost.exe');
}
export class ChromeConnectorRegistration {
  readonly directory: string;
  readonly manifestPath: string;
  readonly launchPath: string;
  readonly owner: string;
  constructor(readonly input: ConnectorRegistrationInput, readonly registry: ConnectorRegistry = windowsConnectorRegistry(input.nativeHostPath)) {
    this.directory = connectorDirectory(input.userDataPath);
    this.manifestPath = path.join(this.directory, `${chromeConnectorNativeHostName}.json`);
    this.launchPath = chromeConnectorLaunchPath(input.nativeHostPath, input.msixPackage);
    // Stable across Store updates; independent installs/profiles have different roots.
    this.owner = createHash('sha256').update(fs.realpathSync.native(input.userDataPath).toLowerCase()).digest('hex');
  }
  #manifest(): Record<string, unknown> | null {
    connectorDirectory(this.input.userDataPath);
    assertConnectorFile(this.manifestPath);
    return fs.existsSync(this.manifestPath) ? JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) : null;
  }
  #ownedManifest(manifest: Record<string, unknown> | null): boolean {
    if (!manifest || manifest.name !== chromeConnectorNativeHostName || manifest.type !== 'stdio') return false;
    if (typeof manifest.path !== 'string' || !samePath(manifest.path, this.launchPath)) return false;
    const origins = manifest.allowed_origins;
    if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== chromeConnectorExtensionOrigin) return false;
    if (manifest.cardbush_owner != null) return manifest.cardbush_owner === this.owner;
    // One-time migration of the exact previous manifest in our own data directory.
    return true;
  }
  inspect(): { bridgeRegistered: boolean; registrationConflict?: string } {
    const manifest = this.#manifest();
    const expected = fs.existsSync(this.manifestPath) ? fs.realpathSync.native(this.manifestPath) : this.manifestPath;
    let registered = false;
    for (const view of ['32', '64'] as const) {
      const existing = this.registry.read(view);
      if (!existing) continue;
      if (!samePath(existing, expected) || !this.#ownedManifest(manifest)) {
        return { bridgeRegistered: false, registrationConflict: 'Another installation owns the Chrome connector registration. Close or remove its connector first.' };
      }
      registered = true;
    }
    if (manifest && !this.#ownedManifest(manifest)) {
      return { bridgeRegistered: false, registrationConflict: 'Connector manifest ownership could not be verified.' };
    }
    return { bridgeRegistered: registered };
  }
  remove(): void {
    const status = this.inspect();
    if (status.registrationConflict) throw new Error(status.registrationConflict);
    if (!fs.existsSync(this.manifestPath)) return;
    const physicalPath = fs.realpathSync.native(this.manifestPath);
    for (const view of ['32', '64'] as const) {
      if (this.registry.read(view)) this.registry.remove(view, physicalPath);
    }
    if (this.#ownedManifest(this.#manifest())) fs.unlinkSync(this.manifestPath);
  }
}

export function chromeConnectorRegistrationStatus(input: ConnectorRegistrationInput & {
  appPath: string; resourcesPath: string; packaged: boolean;
}) {
  const platformSupported = chromeConnectorPlatformSupported();
  let registration: { bridgeRegistered: boolean; registrationConflict?: string } = { bridgeRegistered: false };
  if (platformSupported) {
    try { registration = new ChromeConnectorRegistration(input).inspect(); }
    catch (error) { registration.registrationConflict = error instanceof Error ? error.message : String(error); }
  }
  const storeUrl = process.env.CARDBUSH_CHROME_CONNECTOR_STORE_URL?.trim();
  return {
    platformSupported, packagedApplication: input.packaged, ...registration,
    nativeHostAvailable: fs.existsSync(input.nativeHostPath),
    nativeHostPath: input.nativeHostPath,
    extensionDirectory: input.packaged ? path.join(input.resourcesPath, 'chrome-extension')
      : path.join(input.appPath, 'assets', 'plugins', 'chrome', 'extension'),
    extensionId: chromeConnectorExtensionOrigin.slice('chrome-extension://'.length, -1),
    ...(storeUrl?.startsWith('https://') ? { storeUrl } : {}),
    ...(!platformSupported ? { setupMessage: 'The Chrome connector requires Windows 11.' } : {}),
  };
}
