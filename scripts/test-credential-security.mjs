import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProtectedJson, writeProtectedJson, secureConfigDirectory } from '@cardbush/platform/credentials';
import { ProductModelConfigStore } from '@cardbush/product-host';
import { modelApiBaseURL, storedModelHeader } from '@cardbush/bush-protocol';
import { AgentHttpClient } from '../dist-electron/agentHttpClient.mjs';
import { openHeadlessWorkers } from '../dist-electron/headlessWorkerStore.mjs';
import { BrowserConnectorWebSocket } from '../dist-electron/browserConnectorWebSocket.js';
import { watchCapabilityCatalog } from '../dist-electron/capabilityCatalogWatcher.js';

const run = promisify(execFile), cwd = resolve(import.meta.dirname, '..');
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'cardbush-security-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test('reading protected config does not trigger a capability refresh loop', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), directory = join(root, 'config'), file = join(directory, 'models.json');
  const store = new ProductModelConfigStore(file);
  await store.write({ models: [{ id: 'one', provider: 'openai', model: 'fixture', apiKey: 'fixture-api' }] });
  const before = await fs.readFile(file, 'utf8');
  let changes = 0;
  const stop = watchCapabilityCatalog([directory], () => { changes++; });
  t.after(stop);
  const settle = () => new Promise(resolve => setTimeout(resolve, 500));
  await settle(); // Initial catalog discovery is expected.
  const initial = changes;
  for (let index = 0; index < 4; index++) await store.read();
  await settle();
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(changes, initial, 'read-side ACL checks must not announce configuration changes');
  await store.updateReasoning('one', 'high');
  await settle();
  assert.ok(changes > initial, 'actual configuration edits still refresh the catalog');
});

test('idempotent directory protection still repairs changed access permissions', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t), directory = join(root, 'config');
  secureConfigDirectory(directory);
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const acl = async script => (await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop';$target=$env:CARDBUSH_TEST_CREDENTIAL_DIRECTORY;" + script], {
    env: { ...process.env, CARDBUSH_TEST_CREDENTIAL_DIRECTORY: directory }, windowsHide: true,
  })).stdout.trim();
  const readAcl = "[System.IO.Directory]::GetAccessControl($target).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)";
  const expected = await acl(readAcl);
  await acl("$access=[System.IO.Directory]::GetAccessControl($target);" +
    "$users=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');" +
    "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($users,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow');" +
    "$access.AddAccessRule($rule);[System.IO.Directory]::SetAccessControl($target,$access)");
  assert.notEqual(await acl(readAcl), expected);
  secureConfigDirectory(directory);
  assert.equal(await acl(readAcl), expected, 'extra access is removed instead of trusting a cached successful check');
});

test('sensitive config fields are sealed on disk and decode in a separate process', async t => {
  const root = await fixture(t), file = join(root, 'config', 'models.json');
  const input = { apiKey: 'fixture-api-key', headers: { 'x-unusual-name': 'fixture-header' },
    env: { NONSTANDARD_NAME: 'fixture-env' }, args: ['--token=fixture-argument'], url: 'https://service.test/?access_token=fixture-url' };
  writeProtectedJson(file, input);
  const disk = await fs.readFile(file, 'utf8');
  for (const value of ['fixture-api-key', 'fixture-header', 'fixture-env', 'fixture-argument', 'fixture-url']) assert.ok(!disk.includes(value));
  assert.deepEqual(readProtectedJson(file), input);
  const child = await run(process.execPath, ['--input-type=module', '-e',
    "import{readProtectedJson}from'@cardbush/platform/credentials';process.stdout.write(JSON.stringify(readProtectedJson(process.argv[1])))", file], { cwd, windowsHide: true });
  assert.deepEqual(JSON.parse(child.stdout), input);
  assert.deepEqual(await fs.readdir(dirname(file)), ['models.json']);
});

test('corrupt ciphertext fails closed without overwriting configuration; hard links are refused', async t => {
  const root = await fixture(t), file = join(root, 'config', 'models.json');
  writeProtectedJson(file, { apiKey: 'fixture-secret' });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.apiKey = saved.apiKey.slice(0, -12) + 'AAAAAAAAAAAA';
  await fs.writeFile(file, JSON.stringify(saved)); const before = await fs.readFile(file, 'utf8');
  await assert.rejects(new ProductModelConfigStore(file).read(), /credential_decryption_failed/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const linked = join(root, 'linked.json'); await fs.link(file, linked);
  assert.throws(() => writeProtectedJson(linked, { apiKey: 'new' }), /credential_config_redirected/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('public model headers remain opaque, can be kept, replaced or removed, and reject forged markers', async t => {
  const root = await fixture(t), store = new ProductModelConfigStore(join(root, 'models.json'));
  const saved = await store.write({ models: [{ id: 'one', provider: 'openai', model: 'fixture', apiKey: 'fixture-api',
    defaultHeaders: { 'X-Whatever': 'fixture-header', 'x-session-id': '{{sessionId}}' } }] });
  const view = store.publicPayload(saved);
  assert.equal(view.models[0].defaultHeaders['X-Whatever'], storedModelHeader);
  assert.ok(!JSON.stringify(view).includes('fixture-header'));
  assert.equal((await store.write(view)).models[0].defaultHeaders['X-Whatever'], 'fixture-header');
  view.models[0].defaultHeaders = { 'x-whatever': storedModelHeader };
  assert.equal((await store.write(view)).models[0].defaultHeaders['x-whatever'], 'fixture-header');
  view.models[0].defaultHeaders = { 'x-new': storedModelHeader };
  await assert.rejects(store.write(view), /stored_model_header_missing/);
  view.models[0].defaultHeaders = { 'x-whatever': 'replacement' };
  assert.equal((await store.write(view)).models[0].defaultHeaders['x-whatever'], 'replacement');
  view.models[0].defaultHeaders = {};
  assert.deepEqual((await store.write(view)).models[0].defaultHeaders, {});
});

test('App and CLI config updates are serialized across processes', async t => {
  const root = await fixture(t), file = join(root, 'models.json'), store = new ProductModelConfigStore(file);
  await store.write({ models: ['a', 'b', 'c'].map(id => ({ id, provider: 'openai', model: id, apiKey: 'fixture-' + id })) });
  await Promise.all(['a', 'b', 'c'].map(id => run(process.execPath, ['--input-type=module', '-e',
    "import{ProductModelConfigStore}from'@cardbush/product-host';await new ProductModelConfigStore(process.argv[1]).updateReasoning(process.argv[2],'high')", file, id], { cwd, windowsHide: true })));
  assert.deepEqual((await store.read()).models.map(model => model.reasoningEffort), ['high', 'high', 'high']);
});

test('headless workers discard the old adjacent key and retain new protected credentials over restart', async t => {
  const root = await fixture(t), directory = join(root, 'workers'); await fs.mkdir(directory);
  await fs.writeFile(join(directory, 'credentials.key'), randomBytes(32));
  await fs.writeFile(join(directory, 'connections.json'), JSON.stringify([{ old: true }]));
  const store = await openHeadlessWorkers(root);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(join(directory, 'credentials.key')), { code: 'ENOENT' });
  const [connection] = await store.save({ name: 'fixture', transport: 'http', url: 'https://worker.test/', token: 'fixture-worker-secret' });
  await store.close();
  const reopened = await openHeadlessWorkers(root);
  assert.equal((await reopened.list())[0].id, connection.id);
  const persisted = JSON.parse(await fs.readFile(join(directory, 'connections.json'), 'utf8'));
  assert.equal(reopened.cipher.decrypt(persisted[0].token), 'fixture-worker-secret');
  await reopened.close();
  assert.ok(!(await fs.readFile(join(directory, 'credentials.protected'), 'utf8')).includes('fixture-worker-secret'));
});

test('old browser credentials are discarded and replaced with a new empty versioned store', async t => {
  const root = await fixture(t), file = join(root, 'pairing.json');
  await fs.writeFile(file, JSON.stringify({ version: 4, port: 60123, credentials: [{ secret: 'old-plaintext' }] }));
  const server = new BrowserConnectorWebSocket(root, () => {});
  try {
    await server.start(); const saved = readProtectedJson(file);
    assert.equal(saved.version, 5); assert.deepEqual(saved.credentials, []);
    assert.ok(!(await fs.readFile(file, 'utf8')).includes('old-plaintext'));
  } finally { server.stop(); }
});

test('remote plaintext connections are rejected at client and model boundaries', () => {
  for (const url of ['http://worker.test', 'http://192.168.1.20', 'http://10.0.0.2']) {
    assert.throws(() => new AgentHttpClient(url, 'fixture-secret'));
    assert.throws(() => modelApiBaseURL('openai_responses', url), /requires_https/);
  }
  assert.equal(modelApiBaseURL('openai_responses', 'http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => AgentHttpClient.forIsolatedContainer('http://remote.test/', 'fixture-secret'));
  const privateClient = AgentHttpClient.forIsolatedContainer(`http://cbweb-${'a'.repeat(24)}:4780/`, 'fixture-secret'); privateClient.close();
});

test('a private gateway exception is restricted to the exact host setting and model path', () => {
  const previous = process.env.CARDBUSH_PRIVATE_MODEL_ORIGIN;
  try {
    process.env.CARDBUSH_PRIVATE_MODEL_ORIGIN = 'http://cardbush-web:4880';
    assert.equal(modelApiBaseURL('openai_responses', 'http://cardbush-web:4880/internal/model/user/model'), 'http://cardbush-web:4880/internal/model/user/model');
    for (const url of ['http://cardbush-web:4880/elsewhere', 'http://evil.test/internal/model/user/model', 'http://cardbush-web:4881/internal/model/user/model'])
      assert.throws(() => modelApiBaseURL('openai_responses', url), /requires_https/);
  } finally { if (previous === undefined) delete process.env.CARDBUSH_PRIVATE_MODEL_ORIGIN; else process.env.CARDBUSH_PRIVATE_MODEL_ORIGIN = previous; }
});

test('service-managed encryption keys work across processes and missing keys cannot erase ciphertext', async t => {
  const root = await fixture(t), file = join(root, 'models.json');
  const env = { ...process.env, CARDBUSH_CREDENTIAL_KEY: randomBytes(32).toString('hex') }; delete env.CARDBUSH_CREDENTIAL_KEY_FILE;
  // Exercise the portable crypto backend on Windows too. No OS keyring or real
  // user profile is involved; filesystem permission enforcement remains OS-specific.
  const prelude = "Object.defineProperty(process,'platform',{value:'linux'});const c=await import('@cardbush/platform/credentials');";
  await run(process.execPath, ['--input-type=module', '-e', prelude + "c.writeProtectedJson(process.argv[1],{apiKey:'fixture-portable-secret'});", file], { cwd, env, windowsHide: true });
  const before = await fs.readFile(file, 'utf8'); assert.ok(!before.includes('fixture-portable-secret'));
  const restored = await run(process.execPath, ['--input-type=module', '-e', prelude + "if(c.readProtectedJson(process.argv[1]).apiKey!=='fixture-portable-secret')throw Error('lost credential')", file], { cwd, env, windowsHide: true });
  assert.equal(restored.stdout, '');
  delete env.CARDBUSH_CREDENTIAL_KEY;
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', prelude + 'c.readProtectedJson(process.argv[1]);', file], { cwd, env, windowsHide: true }), /credential_decryption_failed/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
