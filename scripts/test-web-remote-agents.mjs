import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentHttpClient } from '../dist-electron/agentHttpClient.mjs';
import { WebRemoteAgents, remoteAgentToken, createRemoteClient, remoteAgentUrl } from '../dist-electron/webRemoteAgents.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { callWebRemoteAgent } from '../dist-electron/agentWebRemoteAgents.mjs';
import { csrfToken, WebError } from '../dist-electron/webCommon.mjs';
import { webToolDenial, webToolDefinition } from '../packages/bush-runtime/dist/webToolPolicy.js';
import { SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, registerSubagentTool } from '../packages/bush-runtime/dist/index.js';

class Repository {
  row;
  async initialize(payload) { this.row ??= { revision: 1, payload }; }
  async read() { return structuredClone(this.row); }
  async replace(revision, payload) { if (revision !== this.row.revision) return null; return this.row = { revision: revision + 1, payload }; }
}
const secret = 'registry-secret-'.repeat(5), users = new Set(['alice', 'bob']);
const agentInput = (overrides = {}) => ({ id: 'remote-test', name: 'Remote tester', description: 'Review documents', url: 'https://remote.test/', token: 'secret-access-token', enabled: true, userIds: ['alice'], ...overrides });
const info = id => ({ protocol: 'cardbush.agent.v1', apiVersion: 1, id, name: 'Remote service', platform: 'linux', eventStreams: ['sse', 'ndjson'], capabilities: { durableQueue: true, delegation: true } });
async function fixture(factory = async () => ({ async info() { return info('instance-a'); }, close() {} })) {
  const repository = new Repository(), registry = new WebRemoteAgents(secret, repository, factory);
  await registry.initialize(); return { repository, registry };
}
const save = (registry, agent = agentInput()) => registry.update({ action: 'save', revision: registry.view().revision, agent }, users);

test('admin registry encrypts tokens, retains them on edit, restores on restart and pins identity', async () => {
  let identity = 'instance-a';
  const factory = async () => ({ async info() { return info(identity); }, close() {} });
  const { repository, registry } = await fixture(factory);
  await save(registry);
  assert.ok(!repository.row.payload.includes('secret-access-token'));
  assert.ok(!JSON.stringify(registry.view()).includes('secret-access-token'));
  await save(registry, agentInput({ name: 'Edited', token: '' }));
  assert.equal((await registry.authorized('alice', 'remote-test')).token, 'secret-access-token');
  const restored = new WebRemoteAgents(secret, repository, factory); await restored.initialize();
  assert.equal(restored.view().agents[0].name, 'Edited');
  assert.equal((await restored.list('bob')).length, 0);
  identity = 'instance-b';
  await assert.rejects(save(registry), /身份/);
  await assert.rejects(save(registry, agentInput({ url: 'https://other.test' })), /地址不可替换/);
});

test('admin grants multiple people atomically, deduplicates and revokes without duplicating instances', async () => {
  const { registry } = await fixture(); await save(registry);
  await save(registry, agentInput({ userIds: ['alice', 'bob', 'bob'], token: '' }));
  assert.deepEqual(registry.view().agents[0].userIds, ['alice', 'bob']);
  assert.equal((await registry.list('bob')).length, 1);
  const revision = registry.view().revision;
  await assert.rejects(save(registry, agentInput({ userIds: ['alice', 'missing'] })), /授权人员/);
  assert.equal(registry.view().revision, revision);
  await save(registry, agentInput({ userIds: ['bob'], token: '' }));
  await assert.rejects(registry.authorized('alice', 'remote-test'), /授权/);
  assert.equal((await registry.list('bob')).length, 1);
  await assert.rejects(save(registry, agentInput({ id: 'alias', url: 'https://alias.test' })), /已经注册/);
  await registry.update({ action: 'delete', revision: registry.view().revision, id: 'remote-test' }, users);
  assert.deepEqual(registry.view().agents, []);
  await assert.rejects(registry.authorized('alice', 'remote-test'), /授权/);
  await assert.rejects(save(registry, agentInput()), /已删除/);
  await save(registry, agentInput({ id: 'replacement' }));
  assert.equal((await registry.list('alice')).length, 1);
});

test('revocation works offline and optimistic concurrency rejects conflicting writes', async () => {
  let online = true;
  const { repository, registry } = await fixture(async () => { if (!online) throw Error('offline secret-access-token'); return { async info() { return info('instance-a'); }, close() {} }; });
  await save(registry); online = false;
  await save(registry, agentInput({ enabled: false, token: '' }));
  await assert.rejects(registry.authorized('alice', 'remote-test'), /未启用/);
  await assert.rejects(save(registry, agentInput({ token: '' })), error => error.status === 502 && !error.message.includes('secret-access-token'));
  const restored = new WebRemoteAgents(secret, repository, registry.clientFactory); await restored.initialize();
  const revision = registry.view().revision;
  const results = await Promise.allSettled([registry, restored].map(item => item.update({ action: 'save', revision, agent: agentInput({ token: '', enabled: false }) }, users)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
});

test('remote address policy rejects local, link-local, embedded credentials and public plaintext HTTP', async () => {
  for (const url of ['http://127.0.0.1:4780', 'http://[::1]:4780', 'http://169.254.169.254', 'http://localhost', 'file:///tmp/a', 'https://name:token@remote.test', 'https://remote.test/?token=x'])
    assert.throws(() => remoteAgentUrl(url), undefined, url);
  assert.equal(remoteAgentUrl('http://192.168.1.20:4780/api/agent/v1'), 'http://192.168.1.20:4780/');
  await assert.rejects(createRemoteClient({ url: 'http://1.1.1.1/', token: 'secret' }), /HTTPS/);
  await assert.rejects(createRemoteClient({ url: 'https://[::ffff:127.0.0.1]/', token: 'secret' }));
});

test('the immutable web policy denies local forks, auto-assembly, extra parameters and arbitrary tools', async () => {
  const request = { metadata: { toolExecutionPolicy: 'web_restricted' } };
  for (const input of [{ prompt: 'x' }, { prompt: 'x', mode: 'fork' }, { prompt: 'x', target_agent: 'remote-test', settings: {} },
    { action: 'save', agent: {} }, { prompt: 'x', target_agent: 'remote-test', task_id: 'task' }, { prompt: 'x', target_agent: 'http://remote.test' }])
    assert.ok(await webToolDenial(request, 'subagent', input), JSON.stringify(input));
  assert.equal(await webToolDenial(request, 'subagent', { prompt: 'x', target_agent: 'remote-test' }), undefined);
  assert.ok(await webToolDenial(request, 'team', {}));
  assert.ok(await webToolDenial(request, 'list_subagent_options', { section: 'settings' }));
  const title = { zh: '查看授权目标', en: 'List authorized agents' };
  assert.equal(await webToolDenial(request, 'list_subagent_options', { _display_title: title }), undefined);
  assert.equal(await webToolDenial(request, 'subagent', { prompt: 'x', target_agent: 'remote-test', _display_title: title }), undefined);
  assert.ok(await webToolDenial(request, 'subagent', { prompt: 'x', target_agent: 'remote-test', mode: 'fork', _display_title: title }));
  const narrowed = webToolDefinition({ name: 'subagent', inputSchema: {} });
  assert.deepEqual(Object.keys(narrowed.inputSchema.properties), ['prompt', 'target_agent', 'task_id']);
});

test('native runtime discovers only remote targets and preserves async await/follow-up without local execution', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), pending = [], results = new Map();
  let serial = 0;
  registerSubagentTool(registry, tasks, () => assert.fail('Never create a local child'), {
    asyncDispatch: true, createTaskId: () => 'task_' + ++serial,
    models: { list: () => assert.fail('Never assemble local model settings') },
    loadPluginAgents: () => assert.fail('Never load local plugin agent roles'),
    remoteAgents: { list: async () => [{ id: 'remote-test', name: 'Remote', agentId: 'instance-a' }], run: input => new Promise(resolve => pending.push({ input, resolve })) },
    onAsyncResult: item => results.set(item.taskId, item.result),
    awaitAsyncResults: async ({ taskIds }) => Promise.all(taskIds.map(async taskId => ({ taskId, message: await results.get(taskId) }))),
  });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => assert.fail('Unexpected permission') } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'req', sessionId: 'parent', turnId: 'turn', model: 'private-model', permissionMode: 'task_free', messages: [], tools: registry.definitions(), metadata: { toolExecutionPolicy: 'web_restricted', uiLanguage: 'zh' } };
  let calls = 0;
  const invoke = (name, input, parent = request) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'call' + ++calls, name, argumentsText: JSON.stringify(input) }, { requestId: 'req', sessionId: parent.sessionId, turnId: 'turn', round: 1, ordinal: 0 }, undefined, { request: parent, contextMessages: [{ role: 'system', content: 'PRIVATE HISTORY' }] });
  assert.deepEqual((await invoke('list_subagent_options', { _display_title: { zh: '查看远程目标', en: 'List remote agents' } })).result.remote_agents.map(item => item.id), ['remote-test']);
  const result = await invoke('subagent', { prompt: 'Review', target_agent: 'remote-test', _display_title: { zh: '委派远程任务', en: 'Delegate remote task' } });
  assert.equal(result.kind, 'returned'); assert.equal(result.result.status, 'running');
  assert.doesNotMatch(JSON.stringify(pending[0].input), /PRIVATE HISTORY|private-model/);
  pending[0].resolve({ status: 'completed', finalResponse: 'Remote done', errorMessage: '', usage: {} });
  assert.equal((await invoke('await_subagents', { task_ids: [result.result.taskId], mode: 'all' })).result.count, 1);
  const follow = await invoke('subagent', { prompt: 'Continue', task_id: result.result.taskId });
  assert.equal(follow.result.childSessionId, result.result.childSessionId);
  pending[1].resolve({ status: 'completed', finalResponse: 'Continued', errorMessage: '', usage: {} }); await results.get(follow.result.taskId);
  assert.equal((await invoke('subagent', { prompt: 'Steal', task_id: result.result.taskId }, { ...request, sessionId: 'other' })).kind, 'failed');
  tasks.start({ taskId: 'old-local', parentSessionId: 'parent', parentTurnId: 'turn', childSessionId: 'local-child', childTurnId: 'local-turn', prompt: 'x', inheritContext: true, inheritedMessageCount: 1 });
  assert.equal((await invoke('subagent', { prompt: 'Continue local', task_id: 'old-local' })).kind, 'failed');
});

async function gatewayFixture(t, remoteFactory) {
  const { registry } = await fixture(remoteFactory); await save(registry);
  const store = {
    async authenticate(token) { return token.startsWith('admin') ? { id: 'admin', role: 'admin', is_active: true } : token.startsWith('alice') ? { id: 'alice', role: 'member', is_active: true } : null; },
    async user(id) { return users.has(id) ? { id, is_active: true } : undefined; },
    async users() { return [...users].map(id => ({ id })); },
    async conversation(userId, id) { if (id !== 'parent-' + userId) throw new WebError(404, 'Not owned'); return { id }; },
  };
  const server = await serveWeb({ modelSecret: secret, defaultModelId: 'm', models: [{ id: 'm' }], origin: 'http://fixture.test', host: '127.0.0.1', port: 0, staticRoot: 'dist-web' }, store, { close() {} }, undefined, registry);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.port;
  const configuration = { gateway: base + '/internal/remote-agents/alice', credential: remoteAgentToken(secret, 'alice') };
  return { registry, store, base, configuration };
}
test('admin endpoints require login, admin role, CSRF and validate authorized people', async t => {
  const f = await gatewayFixture(t, async () => ({ async info() { return info('instance-a'); }, close() {} }));
  const request = (who, body, csrf = true) => {
    const token = who.padEnd(54, '_');
    return fetch(f.base + '/api/web/v1/admin/remote-agents', { method: body ? 'POST' : 'GET', headers: { Cookie: 'cardbush_web=' + token, Origin: 'http://fixture.test', 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrfToken(token) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  assert.equal((await request('missing')).status, 401);
  assert.equal((await request('alice')).status, 403);
  assert.equal((await request('admin', { action: 'test', agent: agentInput() }, false)).status, 403);
  const result = await request('admin'); assert.equal(result.status, 200); assert.ok(!(await result.text()).includes('secret-access-token'));
  assert.equal((await request('admin', { action: 'test', agent: agentInput({ userIds: ['missing'] }) })).status, 400);
});

test('gateway scopes remote identifiers, returns async results, isolates reads and rejects arbitrary RPC', async t => {
  const submitted = [], operations = [], sessions = new Map(), jobs = new Map();
  const client = {
    async info() { return info('instance-a'); }, close() {},
    async call(operation, input) {
      operations.push(operation);
      if (operation === 'delegation.submit') {
        submitted.push(input);
        sessions.set(input.sessionId, { sessionId: input.sessionId, metadata: { delegationOwner: input.parentSessionId, providerKey: 'SECRET' }, turns: [{ turnId: input.turnId, status: 'completed', messages: [{ messageId: 'm', turnId: input.turnId, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'Remote result', toolCalls: [] } }], usage: {} }] });
        jobs.set(input.sessionId, [{ id: input.taskId, status: 'completed' }]); return {};
      }
      if (operation === 'chat.jobs') return jobs.get(input.sessionId) ?? [];
      if (operation === 'sessions.get') return sessions.get(input.sessionId);
      throw Error('Unexpected operation ' + operation);
    },
    async *events() { yield { type: 'end', afterSequence: 0 }; },
  };
  const f = await gatewayFixture(t, async () => client);
  const input = { connectionId: 'remote-test', agentId: 'instance-a', parentSessionId: 'parent-alice', parentTurnId: 'turn', sessionId: 'delegated-child', turnId: 'turn-task', taskId: 'task', prompt: 'Review', permissionMode: 'all_free', language: 'zh' };
  const result = await callWebRemoteAgent(f.configuration, 'agents.delegate', input);
  assert.equal(result.finalResponse, 'Remote result');
  assert.notEqual(submitted[0].parentSessionId, input.parentSessionId); assert.notEqual(submitted[0].sessionId, input.sessionId);
  assert.equal(submitted[0].permissionMode, 'all_free'); assert.equal(submitted[0].turnId, 'turn-' + submitted[0].taskId);
  const read = { connectionId: input.connectionId, agentId: input.agentId, parentSessionId: input.parentSessionId, sessionId: input.sessionId };
  assert.ok(!JSON.stringify(await callWebRemoteAgent(f.configuration, 'agents.read-child', read)).includes('SECRET'));
  await assert.rejects(callWebRemoteAgent(f.configuration, 'agents.read-child', { ...read, sessionId: 'delegated-foreign' }));
  await assert.rejects(callWebRemoteAgent(f.configuration, 'agents.delegate', { ...input, parentSessionId: 'parent-bob' }));
  const bob = { gateway: f.base + '/internal/remote-agents/bob', credential: remoteAgentToken(secret, 'bob') };
  assert.deepEqual(await callWebRemoteAgent(bob, 'agents.list', {}), []);
  await assert.rejects(callWebRemoteAgent(bob, 'agents.delegate', { ...input, parentSessionId: 'parent-bob' }));
  await save(f.registry, agentInput({ userIds: ['alice', 'bob'] }));
  assert.equal((await callWebRemoteAgent(bob, 'agents.list', {})).length, 1);
  await assert.rejects(callWebRemoteAgent(bob, 'agents.read-child', { ...read, parentSessionId: 'parent-bob' }));
  assert.equal((await callWebRemoteAgent(bob, 'agents.delegate', { ...input, parentSessionId: 'parent-bob' })).finalResponse, 'Remote result');
  assert.notEqual(submitted[0].sessionId, submitted[1].sessionId);
  assert.notEqual(submitted[0].taskId, submitted[1].taskId);
  assert.notEqual(submitted[0].parentSessionId, submitted[1].parentSessionId);
  await assert.rejects(callWebRemoteAgent({ ...f.configuration, credential: remoteAgentToken(secret, 'bob') }, 'agents.list', {}));
  await assert.rejects(callWebRemoteAgent(f.configuration, 'configuration.sync', {}));
  assert.ok(!operations.includes('configuration.sync'));
  await callWebRemoteAgent(f.configuration, 'agents.delegate', { ...input, taskId: 'task-full-access', turnId: 'turn-task-full-access', sessionId: 'delegated-full-access', permissionMode: 'task_free' });
  assert.equal(submitted.at(-1).permissionMode, 'all_free', 'The trusted gateway policy also applies to restricted parents');
});

test('real restricted tenant uses the private gateway and native HTTP delegation without spawning local children', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-remote-native-'));
  let service, submitted, parentRound = 0;
  const requests = [];
  const remote = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-access-token');
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-CardBush-Agent-ID', 'instance-a');
    if (req.url === '/api/agent/v1/info') { res.end(JSON.stringify(info('instance-a'))); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { operation, input } = JSON.parse(raw); requests.push(operation);
    let result;
    if (operation === 'delegation.submit') { submitted = input; result = { id: input.taskId, status: 'queued' }; }
    else if (operation === 'chat.jobs') result = [{ id: submitted.taskId, status: 'completed' }];
    else if (operation === 'sessions.get') result = { sessionId: submitted.sessionId, metadata: { delegationOwner: submitted.parentSessionId },
      turns: [{ turnId: submitted.turnId, status: 'completed', usage: {}, messages: [{ messageId: 'remote-final', turnId: submitted.turnId, message: { role: 'assistant', content: 'REMOTE_OK', toolCalls: [] } }] }] };
    else assert.fail('Unexpected remote RPC ' + operation);
    res.end(JSON.stringify({ result }));
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const f = await gatewayFixture(t, async connection => new AgentHttpClient(`http://127.0.0.1:${remote.address().port}/`, connection.token, connection.agentId));
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.end('{"input_tokens":100}'); return; }
    parentRound++;
    const names = body.tools.map(item => item.name ?? item.function?.name);
    assert.ok(names.includes('subagent')); assert.ok(names.includes('await_subagents')); assert.ok(!names.includes('terminal_exec'));
    const schema = body.tools.find(item => (item.name ?? item.function?.name) === 'subagent');
    assert.ok(!JSON.stringify(schema).includes('"mode"'));
    let item;
    if (parentRound === 1) item = { type: 'function_call', name: 'search_skills', arguments: JSON.stringify({ query: 'auto-video-slicing' }), call_id: 'search', id: 'search' };
    else if (parentRound === 2) {
      const search = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'search');
      assert.ok(search, 'A real skill search observation is required');
      assert.equal(JSON.parse(search.output).matches[0]?.name, 'auto-video-slicing');
      item = { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: resolve('assets/skills/auto-video-slicing/SKILL.md') }), call_id: 'skill', id: 'skill' };
    } else if (parentRound === 3) {
      assert.match(JSON.stringify(body), /login_mobile/); assert.match(JSON.stringify(body), /补齐前不委派/);
      item = { type: 'function_call', name: 'subagent', arguments: JSON.stringify({ prompt: 'Return REMOTE_OK', target_agent: 'remote-test' }), call_id: 'dispatch', id: 'dispatch' };
    } else if (parentRound === 4) {
      const match = JSON.stringify(body).replaceAll('\\"', '"').match(/"taskId"\s*:\s*"([^"]+)"/);
      assert.ok(match, 'A native asynchronous task receipt must be returned');
      item = { type: 'function_call', name: 'await_subagents', arguments: JSON.stringify({ task_ids: [match[1]], mode: 'all' }), call_id: 'wait', id: 'wait' };
    } else {
      assert.match(JSON.stringify(body), /REMOTE_OK/);
      assert.ok(parentRound < 8);
      item = { type: 'message', role: 'assistant', id: 'final-' + parentRound, content: [{ type: 'output_text', text: 'Remote work finished.', annotations: [] }] };
    }
    if (item.type === 'function_call') item.arguments = JSON.stringify({ ...JSON.parse(item.arguments), _display_title: { zh: '验证远程能力', en: 'Verify remote capability' } });
    item.status = 'completed';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    const response = { id: 'response-' + parentRound, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit(item.type === 'function_call' ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments } :
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Remote work finished.' });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }); res.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(async () => { await service?.close(); remote.closeAllConnections(); remote.close(); model.closeAllConnections(); model.close(); await rm(root, { recursive: true, force: true }); });
  service = await AgentService.open({ dataRoot: root, webRestricted: true, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
  assert.equal(service.bundledRoot, resolve('assets'), 'Production entrypoints omitting bundledRoot must still load release-owned web skills');
  assert.equal(service.info().capabilities.webRemoteAgents, true);
  await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'private-parent-model', baseURL: `http://127.0.0.1:${model.address().port}/v1` }] } });
  await service.call('web.configure', { imageEnabled: false, gateway: f.base + '/internal/image/alice/images/generations', credential: 'i'.repeat(64), remoteAgents: f.configuration });
  await service.call('sessions.create', { sessionId: 'parent-alice' });
  await service.call('chat.send', { requestId: 'parent-request', sessionId: 'parent-alice', text: 'Delegate to remote tester.', modelId: 'fixture' });
  let jobs;
  for (let i = 0; i < 500; i++) {
    jobs = await service.call('chat.jobs', {});
    if (jobs.length && jobs.every(job => !['running', 'queued'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.equal(jobs[0].status, 'completed', JSON.stringify(jobs));
  assert.ok(parentRound >= 5);
  assert.equal(requests.filter(operation => operation === 'delegation.submit').length, 1);
  assert.doesNotMatch(JSON.stringify(submitted), /private-parent-model|Delegate to remote tester/);
  const sessions = await service.call('sessions.list', {});
  assert.equal(sessions.length, 1, 'No local child session may be created');
});

test('concurrent delegates are bounded and live revocation cancels remote work', { timeout: 25000 }, async t => {
  const jobs = new Map(); let stopped = 0;
  const client = {
    async info() { return info('instance-a'); }, close() {},
    async call(operation, input) {
      if (operation === 'delegation.submit') { jobs.set(input.sessionId, { ...input, id: input.taskId, status: 'running' }); return {}; }
      if (operation === 'chat.jobs') return jobs.has(input.sessionId) ? [jobs.get(input.sessionId)] : [];
      if (operation === 'chat.stop') { const job = [...jobs.values()].find(item => item.id === input.id); job.status = 'stopped'; stopped++; return {}; }
      if (operation === 'sessions.get') return { turns: [] };
      assert.fail(operation);
    },
    async *events(_input, signal) {
      await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    },
  };
  const f = await gatewayFixture(t, async () => client), controllers = [];
  const input = n => ({ connectionId: 'remote-test', agentId: 'instance-a', parentSessionId: 'parent-alice', parentTurnId: 'turn',
    sessionId: 'delegated-child-' + n, turnId: 'turn-task-' + n, taskId: 'task-' + n, prompt: 'Review', permissionMode: 'task_free', language: 'zh' });
  const pending = Array.from({ length: 4 }, (_, n) => {
    const controller = new AbortController(); controllers.push(controller);
    return callWebRemoteAgent(f.configuration, 'agents.delegate', input(n), controller.signal).catch(error => ({ error: error.message }));
  });
  t.after(() => controllers.forEach(controller => controller.abort()));
  for (let i = 0; i < 100 && jobs.size < 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(jobs.size, 4);
  await assert.rejects(callWebRemoteAgent(f.configuration, 'agents.delegate', input(5)), /并发已满/);
  controllers[0].abort();
  for (let i = 0; i < 100 && stopped < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, 1, 'Canceling a tenant request must reach the remote task');
  await save(f.registry, agentInput({ enabled: false, token: '' }));
  await Promise.all(pending);
  assert.equal(stopped, 4, 'Revoking the remote Agent must cancel the other running tasks');
});
