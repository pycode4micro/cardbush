import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';

const executable = path.resolve(process.argv[2] || 'dist-native/chrome-connector/CardBushBrowserHost.exe');
const root = await mkdtemp(path.join(tmpdir(), 'cardbush-native-host-'));
const broker = new ChromeConnectorBroker(root);
let child;
try {
  await broker.start();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  environment.CARDBUSH_CHROME_CONNECTOR_CONFIG = broker.configPath;
  child = spawn(executable, [
    'chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/',
  ], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exited = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-10_000); });
  child.once('exit', (code, signal) => { exited = `exit=${code} signal=${signal}`; });
  const output = nativeMessages(child.stdout);
  await eventually(
    () => broker.status().extensionConnected,
    () => `${stderr} ${exited} native=${JSON.stringify(output.seen)}`,
  );

  child.stdin.write(nativeFrame({
    type: 'status',
    version: 'packaged-host-test',
    activeTabId: 73,
    activeTabTitle: 'Native host test',
    activeTabUrl: 'https://example.test/',
    controlledTabCount: 1,
  }));
  await eventually(() => broker.status().activeTabId === 73, () => stderr);
  assert.equal(broker.status().extensionVersion, 'packaged-host-test');

  broker.releaseAll('packaged_native_host_test');
  const message = await withTimeout(output.next(), 5_000, () => stderr);
  assert.deepEqual(
    { type: message.value.type, method: message.value.method, reason: message.value.reason },
    {
      type: 'control',
      method: 'debugger.detachAll',
      reason: 'packaged_native_host_test',
    },
  );
  child.stdin.end();
  const exit = await withTimeout(new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }), 5_000, () => stderr);
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  await eventually(() => !broker.status().extensionConnected, () => stderr);

  // A CardBush crash/restart closes the broker while Chrome keeps its native
  // stdin open. The dedicated host must still exit so the MV3 extension gets
  // onDisconnect and can reconnect to the new app process.
  child = spawn(executable, [
    'chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/',
  ], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let restartStderr = '';
  child.stderr.on('data', (chunk) => { restartStderr = `${restartStderr}${chunk}`.slice(-10_000); });
  await eventually(
    () => broker.status().extensionConnected,
    () => restartStderr,
  );
  const brokerClosedExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  broker.stop();
  const restartedExit = await withTimeout(brokerClosedExit, 5_000, () => restartStderr);
  assert.equal(restartedExit.signal, null);
  assert.equal(restartedExit.code, 0);

  child = spawn(executable, ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rejectedOutput = nativeMessages(child.stdout);
  const rejectedExitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const rejectedMessage = await withTimeout(rejectedOutput.next(), 5_000, () => 'no rejection frame');
  assert.equal(rejectedMessage.value.code, 'extension_origin_rejected');
  const rejectedExit = await withTimeout(rejectedExitPromise, 5_000, () => 'origin rejection did not exit');
  assert.equal(rejectedExit.signal, null);
  assert.equal(rejectedExit.code, 2);
  console.log('CardBush Native Messaging host round-trip, restart recovery, and origin rejection passed');
} finally {
  if (child && child.exitCode == null) child.kill();
  broker.stop();
  await rm(root, { recursive: true, force: true });
}

function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function nativeMessages(stream) {
  let buffer = Buffer.alloc(0);
  const queued = [];
  const waiters = [];
  const seen = [];
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) break;
      const value = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
      seen.push(value);
      buffer = buffer.subarray(length + 4);
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else queued.push(value);
    }
  });
  return {
    seen,
    next() {
      const value = queued.shift();
      return value
        ? Promise.resolve({ value, done: false })
        : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function eventually(predicate, diagnostic) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for packaged native host. ${diagnostic()}`);
}

function withTimeout(promise, timeoutMs, diagnostic) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Packaged native host timed out. ${diagnostic()}`)),
      timeoutMs,
    )),
  ]);
}
