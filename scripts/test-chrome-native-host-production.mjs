import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';

// Production has no arbitrary config injection. Exercise its actual boundary
// without overwriting the user's registration or connecting to their browser.
const executable = path.resolve(process.argv[2] || 'dist-native/chrome-connector-validation/CardBushBrowserHost.exe');
const binary = await readFile(executable);
assert.equal(binary.includes(Buffer.from('CARDBUSH_CHROME_CONNECTOR_CONFIG', 'utf16le')), false,
  'a test host with a configuration override must never ship in a production package');
const run = args => {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 5000, input: Buffer.alloc(0) });
  assert.ifError(result.error);
  return result;
};
for (const view of ['32', '64']) {
  const result = run(['--registry-read', view]);
  assert.equal(result.status, 0, result.stderr.toString());
  const value = JSON.parse(result.stdout.toString('utf8'));
  assert.ok(value.manifestPath === null || typeof value.manifestPath === 'string');
  assert.equal(typeof value.empty, 'boolean');
}
const rejected = run(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/']);
assert.equal(rejected.status, 2);
assert.equal(rejected.stdout.readUInt32LE(0), rejected.stdout.length - 4);
assert.equal(JSON.parse(rejected.stdout.subarray(4)).code, 'extension_origin_rejected');
const root = await mkdtemp(path.join(tmpdir(), 'cardbush-production-host-'));
const broker = new ChromeConnectorBroker(root, { nativeHostPath: executable });
try {
  await broker.start(); // Sets and reads back real Windows directory/pipe ACLs.
  assert.equal(broker.status().bridgeRunning, true);
  assert.equal(broker.status().extensionConnected, false);
} finally {
  broker.stop();
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('cardbush-production-host-'));
  await rm(root, { recursive: true, force: true });
}
console.log('Production native host: no test override, read-only registry queries, origin rejection and ACL checks passed. Installed Chrome round-trip remains a separate check.');
