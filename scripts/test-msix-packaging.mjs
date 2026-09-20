import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createManifest, validateIdentity } from './package-msix.mjs';
import { verifySdkArchive } from './msix-sdk.mjs';
import { chromeConnectorLaunchPath, chromeConnectorLaunchPathExists } from '../dist-electron/chromeConnectorRegistration.js';

test('rejects an unverified Windows SDK download before running tools', () => {
  assert.throws(() => verifySdkArchive(Buffer.from('incomplete or modified SDK archive')), /SHA-256 mismatch/);
});

const identity = {
  identityName: '12345.ExampleApp', publisher: 'CN=00000000-0000-0000-0000-000000000001',
  publisherDisplayName: 'Example', displayName: 'CardBush', version: '1.0.0.0',
};

test('fails before building when Store identity or placeholders are incomplete', () => {
  for (const key of Object.keys(identity)) {
    assert.throws(() => validateIdentity({ ...identity, [key]: '' }));
    assert.throws(() => validateIdentity({ ...identity, [key]: 'REPLACE_WITH_VALUE' }));
  }
  assert.throws(() => validateIdentity({ ...identity, publisher: 'publisher name without CN' }));
  assert.throws(() => validateIdentity({ ...identity, identityName: '../wrong/path' }));
  assert.throws(() => validateIdentity({ ...identity, displayName: '${publisher}' }));
});

test('requires a Store-compatible four-part version and prevents silent beta collisions', () => {
  for (const version of ['1.0.0-beta.3', '1.0.0', '1.0.0.1', '0.1.0.0', '65536.0.0.0', '1.01.0.0']) {
    assert.throws(() => validateIdentity({ ...identity, version }));
  }
  assert.equal(validateIdentity({ ...identity, version: '1.0.3.0' }).version, '1.0.3.0');
});

test('Store names cannot inject XML or builder macros; numeric identity prefix is retained', () => {
  const manifest = createManifest({ ...identity, publisherDisplayName: 'A&B <"Studio">', displayName: "CardBush's tools" });
  assert.ok(manifest.includes('Name="12345.ExampleApp"'));
  assert.ok(manifest.includes('<PublisherDisplayName>A&amp;B &lt;&quot;Studio&quot;&gt;</PublisherDisplayName>'));
  assert.ok(manifest.includes('DisplayName="CardBush&apos;s tools"'));
  assert.ok(manifest.includes('Application Id="CardBush" Executable="app\\CardBush.exe"'));
});

test('MSIX exposes only the native messaging registry key on Windows 11 and retains file virtualization', () => {
  const manifest = createManifest(identity);
  assert.deepEqual([...manifest.matchAll(/<virtualization:ExcludedKey>(.*?)<\/virtualization:ExcludedKey>/g)]
    .map(match => match[1]), ['HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.cardbush.browser_connector']);
  assert.match(manifest, /<desktop6:RegistryWriteVirtualization>disabled<\/desktop6:RegistryWriteVirtualization>/);
  assert.match(manifest, /<rescap:Capability Name="unvirtualizedResources" \/>/);
  assert.doesNotMatch(manifest, /FileSystemWriteVirtualization|ExcludedDirector/);
  assert.match(manifest, /MinVersion="10\.0\.19041\.0"/);
});

test('MSIX activates the console bridge through its declared execution alias', () => {
  const manifest = createManifest(identity);
  assert.match(manifest, /Category="windows\.appExecutionAlias" Executable="app\\resources\\chrome-native-host\\CardBushBrowserHost\.exe" EntryPoint="Windows\.FullTrustApplication"/);
  assert.match(manifest, /<uap5:AppExecutionAlias desktop4:Subsystem="console">/);
  assert.match(manifest, /<Application [^>]*desktop4:SupportsMultipleInstances="true"/);
  assert.match(manifest, /<uap5:ExecutionAlias Alias="CardBushBrowserHost\.exe"/);
  const executable = 'C:\\Program Files\\WindowsApps\\test\\app\\resources\\chrome-native-host\\CardBushBrowserHost.exe';
  assert.equal(chromeConnectorLaunchPath(executable, false), executable, 'non-MSIX installs retain direct execution');
  assert.equal(chromeConnectorLaunchPath(executable, true, 'C:\\Users\\Test\\AppData\\Local'),
    path.join('C:\\Users\\Test\\AppData\\Local', 'Microsoft', 'WindowsApps', 'CardBushBrowserHost.exe'));
  assert.throws(() => chromeConnectorLaunchPath(executable, true, ''), /LOCALAPPDATA/);
});

test('activation aliases remain available when following their reparse point is denied', (t) => {
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('Activation-only reparse point'), { code: 'EACCES' }); });
  const entry = t.mock.method(fs, 'lstatSync', () => ({ isFile: () => false, isSymbolicLink: () => true }));
  assert.equal(chromeConnectorLaunchPathExists('activation-alias.exe'), true);
  entry.mock.mockImplementation(() => ({ isFile: () => false, isSymbolicLink: () => false }));
  assert.equal(chromeConnectorLaunchPathExists('directory'), false);
  entry.mock.mockImplementation(() => { throw Object.assign(new Error('Missing alias'), { code: 'ENOENT' }); });
  assert.equal(chromeConnectorLaunchPathExists('missing-alias.exe'), false);
});
