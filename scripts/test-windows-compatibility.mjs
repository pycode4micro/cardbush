import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { minimumWindowsVersion, windowsReleaseSupported } from '@cardbush/platform';
import { uiText } from '@cardbush/platform/i18n';
import { chromeConnectorPlatformSupported } from '../dist-electron/chromeConnectorRegistration.js';
import { ChromeConnectorLifecycle } from '../dist-electron/chromeConnectorLifecycle.js';
import { resolveWindowAppearance } from '../dist-electron/windowAppearance.js';
import { createManifest } from './package-msix.mjs';

test('desktop and browser admit Windows 10 LTSC/22H2 and Windows 11, rejecting older or unknown versions', () => {
  for (const release of ['10.0.17763', '10.0.17763.0', '10.0.19044', '10.0.19045', '10.0.22000', '10.0.26200', '11.0.1']) {
    assert.equal(windowsReleaseSupported(release), true, release);
    assert.equal(chromeConnectorPlatformSupported('win32', release), true, release);
  }
  for (const release of ['6.1.7601', '6.3.9600', '6.3.99999', '10.0.10240', '10.0.17762', '', 'unknown', '10.0', '10.0.NaN', '10.0.19044x']) {
    assert.equal(windowsReleaseSupported(release), false, release);
    assert.equal(chromeConnectorPlatformSupported('win32', release), false, release);
  }
  for (const platform of ['linux', 'darwin']) assert.equal(chromeConnectorPlatformSupported(platform, '10.0.19044'), false);
});

test('desktop startup and MSIX installation enforce the same minimum version', async () => {
  const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.platform === 'win32' && !windowsReleaseSupported\(os\.release\(\)\)/);
  assert.match(source, /nativeText\(\)\('main\.windows_version_required'\)/);
  const manifest = createManifest({ identityName: 'CardBush.CompatibilityTest', publisher: 'CN=Compatibility Test',
    publisherDisplayName: 'Compatibility Test', displayName: 'CardBush', version: '1.0.0.0' });
  assert.equal(/MinVersion="([^"]+)"/.exec(manifest)?.[1], minimumWindowsVersion);
  assert.equal(minimumWindowsVersion, '10.0.17763.0');
  assert.doesNotMatch(manifest, /unvirtualizedResources|RegistryWriteVirtualization|FileSystemWriteVirtualization/);
});

test('Windows 10 retains an opaque usable window in both themes without requesting Mica', () => {
  for (const release of ['10.0.17763', '10.0.19044', '10.0.19045']) for (const theme of ['dark', 'bright']) {
    assert.equal(resolveWindowAppearance({ platform: 'win32', release, theme, preference: 'auto', customTheme: false,
      reducedTransparency: false, highContrast: false, gpuCompositing: 'enabled' }).material, 'none');
  }
});

test('unsupported browser lifecycle follows language changes and performs no setup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cardbush-windows-compatibility-'));
  let language = 'en';
  const lifecycle = new ChromeConnectorLifecycle({ userDataPath: root, nativeHostPath: process.execPath,
    uiLanguage: () => language }, () => {}, { supported: () => false,
    registry: { read: () => null, remove: () => assert.fail('No registry writes on unsupported Windows') },
    acquireLease: () => assert.fail('No connector starts on unsupported Windows') });
  try {
    for (language of ['en', 'zh', 'en']) {
      await assert.rejects(lifecycle.setEnabled(true), { message: uiText(language)('browserConnector.windowsVersionRequired') });
      assert.equal(lifecycle.broker, null);
      assert.equal(lifecycle.state, 'disabled');
      assert.match(uiText(language)('main.windows_version_required'), /Windows 10.*1809/);
      assert.match(uiText(language)('browserConnectionSettings.browser_use_windows'), /Windows 10 \/ 11/);
    }
  } finally {
    lifecycle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
