import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createManifest, validateIdentity } from './package-msix.mjs';
import { verifySdkArchive } from './msix-sdk.mjs';
import { chromeConnectorLaunchPath } from '../dist-electron/chromeConnectorRegistration.js';

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

test('MSIX keeps default virtualization and needs no external registry capability', () => {
  const manifest = createManifest(identity);
  assert.deepEqual([...manifest.matchAll(/<virtualization:ExcludedKey>(.*?)<\/virtualization:ExcludedKey>/g)]
    .map(match => match[1]), []);
  assert.doesNotMatch(manifest, /<desktop6:RegistryWriteVirtualization>/);
  assert.doesNotMatch(manifest, /unvirtualizedResources/);
  assert.doesNotMatch(manifest, /FileSystemWriteVirtualization|ExcludedDirector/);
  assert.match(manifest, /MinVersion="10\.0\.22000\.0"/);
});

test('MSIX no longer exposes a Native Messaging execution alias; legacy paths remain identifiable', () => {
  const manifest = createManifest(identity);
  assert.doesNotMatch(manifest, /appExecutionAlias|AppExecutionAlias/);
  assert.match(manifest, /<Application [^>]*desktop4:SupportsMultipleInstances="true"/);
  assert.doesNotMatch(manifest, /ExecutionAlias/);
  const executable = 'C:\\Program Files\\WindowsApps\\test\\app\\resources\\chrome-native-host\\CardBushBrowserHost.exe';
  assert.equal(chromeConnectorLaunchPath(executable, false), executable, 'non-MSIX installs retain direct execution');
  assert.equal(chromeConnectorLaunchPath(executable, true, 'C:\\Users\\Test\\AppData\\Local'),
    path.join('C:\\Users\\Test\\AppData\\Local', 'Microsoft', 'WindowsApps', 'CardBushBrowserHost.exe'));
  assert.throws(() => chromeConnectorLaunchPath(executable, true, ''), /LOCALAPPDATA/);
});
