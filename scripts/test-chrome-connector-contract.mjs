import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BUSH_MCP_SNAPSHOT_PROTOCOL } from '@cardbush/bush-protocol';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import { ToolExecutionCoordinator, ToolRegistry } from '@cardbush/bush-runtime';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';

const extensionRoot = path.resolve('assets', 'plugins', 'chrome', 'extension');
const packagedRoot = process.argv[2]?.trim() ? path.resolve(process.argv[2]) : '';
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const extensionId = extensionIdFromKey(manifest.key);
assert.equal(extensionId, 'iibaamkfgackofhhpadgnmgcjkhckeln');
assert.deepEqual(manifest.permissions.filter((permission) => [
  'alarms',
  'debugger',
  'nativeMessaging',
  'storage',
  'tabGroups',
  'tabs',
].includes(permission)).sort(), ['alarms', 'debugger', 'nativeMessaging', 'storage', 'tabGroups', 'tabs']);

const background = await readFile(path.join(extensionRoot, 'background.js'), 'utf8');
assert.match(background, /site_permission_required/);
assert.match(background, /unmanaged_tab/);
assert.match(background, /CONTROL_IDLE_TIMEOUT_MS/);
assert.match(background, /debugger\.detachAll/);
assert.match(background, /debugger\.suspendAll/);
assert.match(background, /debugger\.detachScope/);
assert.match(background, /chrome\.tabs\.group/);
assert.match(background, /chrome\.tabGroups\.update/);
assert.match(background, /SESSION_GRANTS_STORAGE_KEY/);
assert.match(background, /PENDING_AUTHORIZATIONS_STORAGE_KEY/);
assert.match(background, /chrome\.alarms\.create\(RECONNECT_ALARM/);
assert.doesNotMatch(background, /DevToolsActivePort|--remote-debugging-port|launch\(/);

const registration = await readFile(path.resolve('electron', 'chromeConnectorRegistration.ts'), 'utf8');
assert.match(registration, /HKCU\\\\Software\\\\Google\\\\Chrome\\\\NativeMessagingHosts/);
assert.match(registration, /allowed_origins: \[chromeConnectorExtensionOrigin\]/);

const runtimeWorker = await readFile(path.resolve('electron', 'runtimeHostWorker.mts'), 'utf8');
assert.match(runtimeWorker, /appsConfig\.chromeConnectionMode === 'remote_debugging'/);
assert.match(runtimeWorker, /permission: remoteDebugging \? 'ask' : 'allow'/);

const electronMain = await readFile(path.resolve('electron', 'main.ts'), 'utf8');
assert.match(electronMain, /activeChromeTurns\.add\(turnKey\)/);
assert.match(electronMain, /activeChromeTools\.size === 0 && activeChromeTurns\.size === 0/);
assert.match(electronMain, /chromeConnectorBroker\?\.suspendAll\('turn_terminal'\)/);

const root = await mkdtemp(path.join(tmpdir(), 'cardbush-chrome-connector-'));
const broker = new ChromeConnectorBroker(root);
let extension;
let manager;
try {
  await broker.start();
  const config = JSON.parse(await readFile(broker.configPath, 'utf8'));
  extension = net.createConnection(config.endpoint);
  extension.setEncoding('utf8');
  const messages = lineMessages(extension);
  await new Promise((resolve, reject) => {
    extension.once('connect', resolve);
    extension.once('error', reject);
  });
  extension.write(`${JSON.stringify({
    type: 'hello',
    protocol: config.protocol,
    role: 'extension',
    token: config.token,
    version: '1.0.0',
  })}\n`);
  assert.equal((await messages.next()).value.type, 'hello_ack');
  extension.write(`${JSON.stringify({
    type: 'status',
    version: '1.0.0',
    activeTabId: 42,
    activeTabTitle: 'CardBush test',
    activeTabUrl: 'https://example.test/',
    controlledTabCount: 1,
  })}\n`);
  await eventually(() => broker.status().activeTabId === 42);
  assert.equal(broker.status().extensionConnected, true);
  assert.equal(broker.status().extensionVersion, '1.0.0');

  const directScope = { scopeId: 'direct-contract', scopeTitle: 'Direct contract' };
  const pending = requestChromeConnector('tabs.list', directScope, { configPath: broker.configPath });
  const request = await messages.next();
  assert.equal(request.value.type, 'request');
  assert.equal(request.value.method, 'tabs.list');
  assert.deepEqual(request.value.params, directScope);
  extension.write(`${JSON.stringify({
    type: 'response',
    clientId: request.value.clientId,
    id: request.value.id,
    result: [{ id: 42, title: 'CardBush test', url: 'https://example.test/', active: true }],
  })}\n`);
  assert.deepEqual(await pending, [
    { id: 42, title: 'CardBush test', url: 'https://example.test/', active: true },
  ]);

  const registry = new ToolRegistry();
  manager = new McpClientManager({ registry });
  const connectorEntry = packagedRoot
    ? path.join(packagedRoot, 'resources', 'app.asar', 'packages', 'cardbush-chrome-mcp', 'dist', 'index.js')
    : path.resolve('packages', 'cardbush-chrome-mcp', 'dist', 'index.js');
  const connectorCommand = packagedRoot
    ? path.join(packagedRoot, 'CardBush.exe')
    : process.execPath;
  const connectorEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  );
  delete connectorEnvironment.NODE_OPTIONS;
  if (packagedRoot) connectorEnvironment.ELECTRON_RUN_AS_NODE = '1';
  const applied = await manager.apply({
    protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
    snapshotId: 'chrome-connector-contract',
    revision: 1,
    servers: [{
      id: 'chrome_devtools',
      transport: {
        kind: 'stdio',
        command: connectorCommand,
        args: [connectorEntry],
        env: {
          ...connectorEnvironment,
          CARDBUSH_CHROME_CONNECTOR_CONFIG: broker.configPath,
        },
      },
      versionMode: 'auto',
      defaultToolPolicy: { permission: 'allow', parallelSafe: false, visibleToChild: true },
      toolPolicies: {},
    }],
  });
  assert.equal(applied.servers[0].tools.length, 15);
  const runtimeToolName = 'mcp__chrome_devtools__list_pages';
  assert.ok(registry.resolve(runtimeToolName));
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error('permission was not expected'); } },
  });
  const execution = coordinator.execute({
    protocol: 'bush.tool_call.v1',
    id: 'chrome-call-1',
    name: runtimeToolName,
    argumentsText: '{}',
  }, {
    requestId: 'chrome-request-1',
    sessionId: 'chrome-session-1',
    turnId: 'chrome-turn-1',
    round: 1,
    ordinal: 0,
  });
  const mcpRequest = await messages.next();
  assert.equal(mcpRequest.value.method, 'tabs.list');
  assert.equal(mcpRequest.value.params.scopeId, 'chrome-session-1');
  assert.equal(mcpRequest.value.params.scopeTitle, 'Session chrome-s');
  extension.write(`${JSON.stringify({
    type: 'response',
    clientId: mcpRequest.value.clientId,
    id: mcpRequest.value.id,
    result: [{ id: 42, title: 'CardBush test', url: 'https://example.test/', active: true }],
  })}\n`);
  const outcome = await execution;
  assert.equal(outcome.kind, 'returned');
  assert.match(outcome.result.content[0].text, /\[42\] CardBush test/);

  const releaseExecution = coordinator.execute({
    protocol: 'bush.tool_call.v1',
    id: 'chrome-call-2',
    name: 'mcp__chrome_devtools__release_browser',
    argumentsText: '{}',
  }, {
    requestId: 'chrome-request-2',
    sessionId: 'chrome-session-1',
    turnId: 'chrome-turn-1',
    round: 1,
    ordinal: 1,
  });
  const scopedRelease = await messages.next();
  assert.equal(scopedRelease.value.method, 'debugger.detachScope');
  assert.equal(scopedRelease.value.params.scopeId, 'chrome-session-1');
  extension.write(`${JSON.stringify({
    type: 'response',
    clientId: scopedRelease.value.clientId,
    id: scopedRelease.value.id,
    result: { detached: true, scopeId: 'chrome-session-1' },
  })}\n`);
  const releaseOutcome = await releaseExecution;
  assert.equal(releaseOutcome.kind, 'returned');
  assert.match(releaseOutcome.result.content[0].text, /this CardBush session/i);

  broker.suspendAll('contract_test');
  const suspension = await messages.next();
  assert.deepEqual(
    { type: suspension.value.type, method: suspension.value.method, reason: suspension.value.reason },
    { type: 'control', method: 'debugger.suspendAll', reason: 'contract_test' },
  );

  broker.releaseAll('contract_release');
  const release = await messages.next();
  assert.deepEqual(
    { type: release.value.type, method: release.value.method, reason: release.value.reason },
    { type: 'control', method: 'debugger.detachAll', reason: 'contract_release' },
  );
} finally {
  await manager?.close();
  extension?.destroy();
  broker.stop();
  await rm(root, { recursive: true, force: true });
}

console.log(`Chrome Connector routing, consent, identity, and release contracts passed${packagedRoot ? ' from the packaged ASAR' : ''}`);

function extensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return [...digest].map((byte) => {
    const high = String.fromCharCode(97 + (byte >> 4));
    const low = String.fromCharCode(97 + (byte & 15));
    return `${high}${low}`;
  }).join('');
}

function lineMessages(socket) {
  const queued = [];
  const waiters = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const boundary = buffer.indexOf('\n');
      if (boundary < 0) break;
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else queued.push(message);
    }
  });
  return {
    next() {
      const value = queued.shift();
      if (value) return Promise.resolve({ value, done: false });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function eventually(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for Chrome Connector state.');
}
