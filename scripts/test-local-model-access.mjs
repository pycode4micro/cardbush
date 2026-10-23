import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SIWC, modelRequestSchema } from '@cardbush/bush-protocol';
import { executeModelRound } from '@cardbush/bush-runtime';
import { ModelProviderRegistry, OpenAIResponsesProvider } from '@cardbush/bush-provider-openai';
import { LocalModelAccessBroker, LocalModelAccessClient } from '../dist-electron/localModelAccess.mjs';
import { SiwcAccounts } from '../dist-electron/siwcAccounts.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';

const native = resolve('dist-native/chrome-connector/CardBushBrowserHost.exe');
const signal = () => new AbortController().signal;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const binding = accountId => ({ protocol: 'bush.provider_binding_config.v1', bindingId: 'plan', adapter: 'openai_responses', authentication: { kind: 'chatgpt', accountId } });
const request = providerBinding => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
  messages: [{ role: 'user', content: 'Hello' }], tools: [], providerBinding });
async function until(read, predicate) {
  for (let i = 0; i < 100; i++) { const value = read(); if (predicate(value)) return value; await delay(20); }
  assert.fail('Timed out waiting for local account bridge');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-local-model-')), profile = join(root, 'profile'); await mkdir(profile);
  const id = randomUUID(); let now = Date.now(), sequence = 1, refreshes = 0;
  const tokens = () => ({ access_token: `PRIVATE_ACCESS_${sequence}`, refresh_token: `PRIVATE_REFRESH_${sequence}`, expires_in: 3600, token_type: 'Bearer', scope: SIWC.scopes });
  let stored = { version: 1, hostId: `urn:uuid:${randomUUID()}`, welcomeShown: true,
    accounts: [{ id, clientId: 'oaiapp_fixture', subject: 'fixture-user', tokens: tokens(), expiresAt: now + 3_600_000 }] };
  const state = { barrier: undefined };
  let broker;
  const accounts = new SiwcAccounts({ read: async () => structuredClone(stored), write: async data => { stored = structuredClone(data); }, now: () => now,
    fetch: async (url, init) => {
      if (String(url).includes('openid-configuration')) return Response.json({ issuer: SIWC.issuer, jwks_uri: `${SIWC.issuer}/jwks`, revocation_endpoint: `${SIWC.issuer}/oauth/revoke` });
      if (String(url).endsWith('/oauth/revoke')) return new Response(null, { status: 200 });
      assert.equal(String(url), SIWC.token); assert.equal(init.body.get('grant_type'), 'refresh_token'); refreshes++;
      await state.barrier?.promise; sequence++; return Response.json(tokens());
    }, openUrl: async () => assert.fail('Existing login must be reused'), changed() {}, invalidated: value => broker?.invalidate(value) });
  const clients = [], services = [];
  const start = async () => { broker = new LocalModelAccessBroker((payload, abort) => accounts.accessPayload(payload, abort)); await broker.start(profile, native); };
  t.after(async () => {
    state.barrier?.resolve();
    for (const service of services) await service.close();
    for (const client of clients) client.close();
    await broker?.close(); await accounts.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-local-model-'));
    await rm(root, { force: true, recursive: true, maxRetries: 4, retryDelay: 100 });
  });
  await start();
  return { root, profile, id, accounts, state, services, start, close: () => broker.close(), stored: () => stored, refreshes: () => refreshes,
    expire: () => { now += 3_600_000; }, descriptor: () => readFile(join(profile, 'model-access', 'bridge.json'), 'utf8').then(JSON.parse),
    client: () => { const client = new LocalModelAccessClient(profile); clients.push(client); return client; } };
}

test('GUI and multiple CLI callers share one rotating account without copying registrations or refresh tokens', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  assert.equal(await a.access({ accountId: f.id }, signal()), 'PRIVATE_ACCESS_1');
  f.expire(); f.state.barrier = deferred();
  const desktop = f.accounts.access(f.id), cli = Promise.all([a.access({ accountId: f.id }, signal()), b.access({ accountId: f.id }, signal())]);
  await until(f.refreshes, value => value === 1); f.state.barrier.resolve();
  assert.deepEqual(await cli, ['PRIVATE_ACCESS_2', 'PRIVATE_ACCESS_2']); assert.equal(await desktop, 'PRIVATE_ACCESS_2');
  assert.equal(f.refreshes(), 1); assert.equal(f.stored().accounts[0].tokens.refresh_token, 'PRIVATE_REFRESH_2');
  assert.doesNotMatch(JSON.stringify(await f.descriptor()), /PRIVATE_|accountId|refresh_token|clientId/);
  assert.equal(await b.access({ accountId: f.id, rejectedToken: 'PRIVATE_ACCESS_1' }, signal()), 'PRIVATE_ACCESS_2');
  assert.equal(f.refreshes(), 1, 'a late 401 must not rotate the replacement again');
});

test('CLI account model authenticates through the shared Responses adapter and refreshes a rejected token once', async t => {
  const f = await fixture(t), client = f.client(), headers = [], bodies = [];
  const providers = new ModelProviderRegistry({ chatGptAccess: (accountId, input) => client.access({ accountId, rejectedToken: input.rejectedToken }, input.signal ?? signal()),
    createProvider: config => new OpenAIResponsesProvider({ ...config, fetch: async (url, init) => {
      assert.equal(String(url), `${SIWC.resource}/responses`);
      headers.push(new Headers(init.headers).get('authorization')); bodies.push(JSON.parse(init.body));
      if (headers.length === 1) return Response.json({ error: { code: 'invalid_token' } }, { status: 401 });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp', status: 'completed', model: 'fixture', store: false,
        output: [{ type: 'message', id: 'msg', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Authorized locally.', annotations: [] }] }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    } }) });
  const result = await executeModelRound(providers, request(providers.upsert(binding(f.id)).binding));
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Authorized locally.');
  assert.deepEqual(headers, ['Bearer PRIVATE_ACCESS_1', 'Bearer PRIVATE_ACCESS_2']); assert.equal(f.refreshes(), 1);
  assert.ok(bodies.every(body => body.store === false && body.stream === true));
  assert.doesNotMatch(JSON.stringify([bodies, result]), /PRIVATE_/);
});

test('desktop sign-out aborts an in-flight CLI account request and denies further token access', async t => {
  const f = await fixture(t), client = f.client(), started = deferred();
  const providers = new ModelProviderRegistry({ chatGptAccess: (accountId, input) => client.access({ accountId }, input.signal ?? signal()),
    createProvider: config => new OpenAIResponsesProvider({ ...config, fetch: async (_url, init) => {
      started.resolve(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } }) });
  client.onInvalidated(id => providers.invalidateChatGptAccount(id));
  const running = executeModelRound(providers, request(providers.upsert(binding(f.id)).binding));
  await started.promise; await f.accounts.logout(f.id);
  assert.equal((await running).status, 'failed');
  await assert.rejects(client.access({ accountId: f.id }, signal()), error => error.code === 'siwc_auth_required');
});

test('cancelling one CLI waiter preserves the shared GUI refresh and other callers', async t => {
  const f = await fixture(t), a = f.client(), b = f.client(); f.expire(); f.state.barrier = deferred();
  const abort = new AbortController();
  const waiting = a.access({ accountId: f.id }, abort.signal); const denied = assert.rejects(waiting, /cancel/i);
  const desktop = f.accounts.access(f.id), other = b.access({ accountId: f.id }, signal());
  await until(f.refreshes, value => value === 1); abort.abort(); await denied;
  f.state.barrier.resolve(); assert.equal(await other, 'PRIVATE_ACCESS_2'); assert.equal(await desktop, 'PRIVATE_ACCESS_2'); assert.equal(f.refreshes(), 1);
});

test('desktop disconnect invalidates used accounts; restart reconnects with a rotated descriptor', async t => {
  const f = await fixture(t), client = f.client(), invalidated = [];
  client.onInvalidated(id => invalidated.push(id));
  await client.access({ accountId: f.id }, signal()); const prior = await f.descriptor(); await f.close();
  await until(() => invalidated, value => value.includes(f.id));
  await assert.rejects(client.access({ accountId: f.id }, signal()), error => error.code === 'siwc_desktop_unavailable' && !error.message.includes('remote'));
  await f.start(); assert.notEqual((await f.descriptor()).token, prior.token);
  assert.equal(await client.access({ accountId: f.id }, signal()), 'PRIVATE_ACCESS_1');
});

test('private IPC rejects unauthenticated peers, unsupported operations, and nonlocal endpoints', async t => {
  const f = await fixture(t), data = await f.descriptor();
  for (const authenticated of [false, true]) {
    const socket = createConnection(data.endpoint); socket.on('error', () => {});
    await once(socket, 'connect'); const closed = once(socket, 'close');
    if (authenticated) {
      const ready = once(socket, 'data'); socket.write(JSON.stringify({ protocol: data.protocol, type: 'hello', token: data.token }) + '\n'); await ready;
      socket.write(JSON.stringify({ protocol: 'cardbush.mcp_host.v1', type: 'request', id: randomUUID(), operation: 'credentials.read', payload: { key: 'anything' } }) + '\n');
    } else socket.write(JSON.stringify({ protocol: data.protocol, type: 'hello', token: '0'.repeat(64) }) + '\n');
    await closed;
  }
  const descriptor = join(f.profile, 'model-access', 'bridge.json');
  await writeFile(descriptor, JSON.stringify({ ...data, endpoint: 'tcp://remote.example:1234' }));
  await assert.rejects(f.client().access({ accountId: f.id }, signal()), { code: 'siwc_desktop_unavailable' });
  await writeFile(descriptor, JSON.stringify(data));
  assert.equal(f.refreshes(), 0);
});

test('actual local Runtime accepts account bindings; service mode cannot inherit local authorization', async t => {
  const f = await fixture(t), access = f.client();
  const local = await AgentService.open({ dataRoot: join(f.root, 'local'), local: true, localProfileRoot: f.profile, localModelAccess: access, toolsEnabled: false }); f.services.push(local);
  const result = await local.runtime.transport.sendCommand({ kind: 'runtime.upsert_provider_binding', payload: binding(f.id) });
  assert.equal(result.status, 'configured');
  const remote = await AgentService.open({ dataRoot: join(f.root, 'remote'), toolsEnabled: false, env: { CARDBUSH_LOCAL_ACCOUNT_ACCESS: '1', CARDBUSH_MCP_DESKTOP_BRIDGE: '1' } }); f.services.push(remote);
  await assert.rejects(remote.runtime.transport.sendCommand({ kind: 'runtime.upsert_provider_binding', payload: binding(f.id) }), /does not provide ChatGPT account authorization/);
  await assert.rejects(AgentService.open({ dataRoot: join(f.root, 'rejected'), localModelAccess: access, toolsEnabled: false }), /requires a local CLI profile/);
});

test('missing desktop produces an actionable nonretrying model failure instead of a remote-Agent message', async t => {
  const f = await fixture(t), client = f.client(); await f.close(); let requests = 0;
  const provider = new OpenAIResponsesProvider({ apiKey: '', chatGpt: { accountId: f.id,
    access: (accountId, input) => client.access({ accountId }, input.signal ?? signal()) }, fetch: async () => { requests++; assert.fail('No authorization, no provider call'); } });
  const result = await executeModelRound(provider, request());
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'chatgpt_desktop_unavailable'); assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /Open CardBush App on this computer/); assert.equal(requests, 0);
});

for (const mode of ['siwc', 'anthropic']) test(`real local CLI: ${mode} authorization, file tool, receipt and final answer`, async t => {
  const f = await fixture(t), config = join(f.profile, 'product-host', 'config'), cwd = join(f.root, 'workspace');
  await mkdir(config, { recursive: true }); await mkdir(cwd);
  const file = join(cwd, 'fixture.txt'), log = join(f.root, 'provider.jsonl'), dataRoot = join(f.root, 'cli');
  await writeFile(file, 'LOCAL_FILE_EVIDENCE');
  const model = { id: 'fixture', provider: mode === 'siwc' ? 'openai' : 'anthropic', model: 'fixture', apiKey: mode === 'siwc' ? '' : 'PRIVATE_CLAUDE_KEY',
    apiProtocol: mode === 'siwc' ? 'openai_responses' : 'anthropic_messages',
    ...(mode === 'siwc' ? { authentication: { kind: 'chatgpt', accountId: f.id } } : { baseURL: 'https://opencode.ai/zen/go/v1' }) };
  const configText = JSON.stringify({ version: 1, defaultModelId: 'fixture', models: [model] });
  await writeFile(join(config, 'models.json'), configText);
  await writeFile(join(config, 'network.json'), JSON.stringify({ mode: 'none' }));
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/helpers/local-model-access-provider.mjs')).href,
    resolve('dist-electron/agentChatCli.mjs'), '--local', '--prompt', 'Read fixture.txt and report the verified result.'], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CARDBUSH_CLI_DATA_DIR: dataRoot,
      CARDBUSH_CLI_PROFILE_DIR: f.profile, CARDBUSH_CLI_CONFIG: join(f.root, 'cli.json'), CARDBUSH_AGENT_TOKEN: '', CARDBUSH_AGENT_URL: '',
      CB_TEST_MODEL_PROTOCOL: mode, CB_TEST_MODEL_FILE: file, CB_TEST_MODEL_LOG: log },
  });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  const timer = setTimeout(() => child.kill(), 30_000); void done.finally(() => clearTimeout(timer));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await done; } });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8').on('data', text => { stderr += text; }); child.stdin.end();
  const code = await done;
  assert.equal(code, 0, stderr); assert.match(stdout, /CLI verified local file/); assert.doesNotMatch(stdout + stderr, /PRIVATE_/);
  const logged = await readFile(log, 'utf8'), requests = logged.trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, mode === 'siwc' ? 3 : 2); assert.doesNotMatch(logged, /PRIVATE_/);
  assert.equal(f.refreshes(), mode === 'siwc' ? 1 : 0); assert.equal(await readFile(join(config, 'models.json'), 'utf8'), configText);
  const state = JSON.parse(await readFile(join(dataRoot, 'agent.json'), 'utf8'));
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'completed');
});
