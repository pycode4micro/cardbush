import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  chromeConnectorConfigDirectoryName,
  chromeConnectorExtensionOrigin,
  chromeConnectorNativeHostName,
} from './chromeConnectorConstants';

export interface ChromeConnectorRegistrationStatus {
  platformSupported: boolean;
  packagedApplication: boolean;
  bridgeRegistered: boolean;
  nativeHostAvailable: boolean;
  nativeHostPath: string;
  extensionDirectory: string;
  extensionId: string;
  storeUrl?: string;
  setupMessage?: string;
}

export function chromeConnectorRegistrationStatus(input: {
  userDataPath: string;
  appPath: string;
  resourcesPath: string;
  nativeHostPath: string;
  packaged: boolean;
}): ChromeConnectorRegistrationStatus {
  const extensionDirectory = input.packaged
    ? path.join(input.resourcesPath, 'chrome-extension')
    : path.join(input.appPath, 'assets', 'plugins', 'chrome', 'extension');
  const manifestPath = nativeHostManifestPath(input.userDataPath);
  const platformSupported = process.platform === 'win32';
  const nativeHostAvailable = fs.existsSync(input.nativeHostPath);
  let bridgeRegistered = false;
  if (platformSupported && fs.existsSync(manifestPath)) {
    try {
      const nativeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        path?: unknown;
        allowed_origins?: unknown;
      };
      const output = execFileSync('reg.exe', [
        'query',
        windowsRegistryKey(),
        '/ve',
      ], { encoding: 'utf8', windowsHide: true });
      const registeredManifestMatches = output.toLowerCase().includes(manifestPath.toLowerCase());
      const executableMatches = typeof nativeManifest.path === 'string'
        && path.resolve(nativeManifest.path).toLowerCase()
          === path.resolve(input.nativeHostPath).toLowerCase();
      const originMatches = Array.isArray(nativeManifest.allowed_origins)
        && nativeManifest.allowed_origins.length === 1
        && nativeManifest.allowed_origins[0] === chromeConnectorExtensionOrigin;
      bridgeRegistered = registeredManifestMatches && executableMatches && originMatches;
    } catch {
      bridgeRegistered = false;
    }
  }
  const storeUrl = normalizedStoreUrl(process.env.CARDBUSH_CHROME_CONNECTOR_STORE_URL);
  return {
    platformSupported,
    packagedApplication: input.packaged,
    bridgeRegistered,
    nativeHostAvailable,
    nativeHostPath: input.nativeHostPath,
    extensionDirectory,
    extensionId: chromeConnectorExtensionOrigin.slice('chrome-extension://'.length, -1),
    ...(storeUrl ? { storeUrl } : {}),
    ...(!nativeHostAvailable ? {
      setupMessage: 'Build the CardBush Native Messaging host before configuring Chrome.',
    } : {}),
  };
}

export function registerChromeConnectorNativeHost(input: {
  userDataPath: string;
  nativeHostPath: string;
}): void {
  if (process.platform !== 'win32') {
    throw new Error('Chrome Connector setup is currently available on Windows only.');
  }
  if (!fs.existsSync(input.nativeHostPath)) {
    throw new Error('The CardBush Native Messaging host executable is missing. Run the application build first.');
  }
  const directory = path.join(input.userDataPath, chromeConnectorConfigDirectoryName);
  fs.mkdirSync(directory, { recursive: true });
  const manifestPath = nativeHostManifestPath(input.userDataPath);
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: chromeConnectorNativeHostName,
    description: 'CardBush Browser Connector native messaging bridge',
    path: path.resolve(input.nativeHostPath),
    type: 'stdio',
    allowed_origins: [chromeConnectorExtensionOrigin],
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  execFileSync('reg.exe', [
    'add',
    windowsRegistryKey(),
    '/ve',
    '/t',
    'REG_SZ',
    '/d',
    manifestPath,
    '/f',
  ], { encoding: 'utf8', windowsHide: true });
}

function nativeHostManifestPath(userDataPath: string): string {
  return path.join(
    userDataPath,
    chromeConnectorConfigDirectoryName,
    `${chromeConnectorNativeHostName}.json`,
  );
}

function windowsRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${chromeConnectorNativeHostName}`;
}

function normalizedStoreUrl(value: string | undefined): string {
  const candidate = value?.trim() ?? '';
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}
