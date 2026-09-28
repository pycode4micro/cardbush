import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';

// Legacy stdio callers must not bypass the new explicit pairing boundary.
const executable = path.resolve(process.argv[2] || 'dist-native/chrome-connector-test/CardBushBrowserHost.exe');
const root = await mkdtemp(path.join(tmpdir(), 'cardbush-native-host-'));
const broker = new ChromeConnectorBroker(root, { nativeHostPath: executable });
async function nativeAttempt(origin, config) {
  const child = spawn(executable, [origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CARDBUSH_CHROME_CONNECTOR_CONFIG: config } });
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, null, stderr);
    const output = Buffer.concat(chunks), messages = [];
    for (let offset = 0; offset < output.length;) {
      const length = output.readUInt32LE(offset); offset += 4;
      assert.ok(offset + length <= output.length);
      messages.push(JSON.parse(output.subarray(offset, offset + length).toString('utf8'))); offset += length;
    }
    assert.ok(!messages.some(message => message.type === 'connector_ready'), 'legacy native transport cannot authorize a browser');
    return { ...result, messages };
  } finally { clearTimeout(timer); if(child.exitCode == null)child.kill(); }
}
try {
  await broker.start();
  await nativeAttempt('chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/', broker.configPath);
  assert.equal(broker.status().extensionConnected, false);
  const unavailable = await nativeAttempt('chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/', path.join(root, 'missing.json'));
  assert.equal(unavailable.code, 3);
  assert.equal(unavailable.messages[0].code, 'cardbush_bridge_unavailable');
  const rejected = await nativeAttempt('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', broker.configPath);
  assert.equal(rejected.code, 2); assert.equal(rejected.messages[0].code, 'extension_origin_rejected');
  console.log('Legacy Native Messaging cannot bypass pairing; missing config and foreign origin fail closed.');
} finally {
  broker.stop();
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('cardbush-native-host-'));
  await rm(root, { recursive: true, force: true });
}
