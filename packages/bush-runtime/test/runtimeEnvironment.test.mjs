import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExecutionRegistry, RuntimeEnvironment, InMemoryRuntimeHost, SessionStore } from '../dist/index.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION, runtimeEnvironmentSnapshotSchema } from '@cardbush/bush-protocol';

const request = (sessionId, metadata = {}) => ({ protocol: 'bush.session_turn_request.v1', sessionId,
  turnId: `turn-${sessionId}`, requestId: `request-${sessionId}`, model: 'fixture', permissionMode: 'all_free',
  requestCapabilities: { interactiveRequests: false }, sessionMetadata: {},
  prefixMessages: [{ role: 'system', content: 'Stable instructions' }],
  inputMessages: [{ messageId: `input-${sessionId}`, message: { role: 'user', content: 'Private user request' } }],
  tools: [], metadata: { environmentContext: true, ...metadata } });
const until = async condition => { for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
async function* answer(req) {
  const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done' };
  yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
}
const terminal = (sessionId, turnId, status = 'completed') => ({ kind: 'turn_terminal', sessionId, turnId, payload: { status } });

test('every execution adapter is registered; scheduling policy does not exclude presence', () => {
  const agents = new AgentExecutionRegistry();
  for (const [id, metadata] of Object.entries({ root: {}, assistant: { personalAssistant: true },
    child: { agentRole: 'child', parentSessionId: 'root' }, shadow: { agentRole: 'child', parentSessionId: 'root', shadowMode: 'readonly' },
    team: { delegationOwner: 'root', registeredAgentReadOnly: true }, automation: { automationRunId: 'a' },
    hook: { pluginHookEvaluation: true }, internal: { runtimeTask: 'internal' } })) {
    agents.begin(request(id, { projectDir: '/project', ...metadata }), 'running');
  }
  assert.equal(agents.list().length, 8);
  assert.deepEqual(agents.list().filter(f => f.canWake).map(f => f.agentId), ['root']);
  assert.equal(agents.get('shadow').readOnly, true);
  assert.equal(agents.get('team').canDelegate, false);
  assert.equal(agents.get('assistant').canDelegate, true);
  assert.doesNotMatch(JSON.stringify(agents.list()), /Private user request|Stable instructions|inputMessages/);
  const copy = agents.list(); copy[0].status = 'failed'; assert.equal(agents.get('root').status, 'running');
});

test('lifecycle waits, terminal events, stale leases and bounded retention share one registry', () => {
  const agents = new AgentExecutionRegistry(() => 'fixed', 2);
  const a = request('a'); agents.begin(a);
  agents.observe({ kind: 'turn_started', sessionId: 'a', turnId: a.turnId });
  agents.observe({ kind: 'permission_requested', sessionId: 'a', turnId: a.turnId });
  assert.equal(agents.get('a').status, 'waiting');
  agents.observe({ kind: 'permission_answered', sessionId: 'a', turnId: a.turnId });
  assert.equal(agents.get('a').status, 'running');
  agents.observe(terminal('a', a.turnId));
  agents.begin({ ...a, turnId: 'new' }, 'running');
  agents.observe(terminal('a', a.turnId, 'stopped'));
  assert.equal(agents.get('a').executionId, 'new'); assert.equal(agents.get('a').status, 'running');
  assert.equal(agents.get('a', a.turnId).status, 'completed');
  for (let i = 0; i < 9; i++) { const r = request(`done-${i}`); agents.begin(r); agents.observe(terminal(r.sessionId, r.turnId)); }
  assert.equal(agents.list().length, 3); assert.equal(agents.get('a').status, 'running');
  agents.forget('a'); assert.equal(agents.get('a'), undefined);
});

test('environment scopes agents to the project or family and emits only changed sections', async () => {
  const registry = new AgentExecutionRegistry(), env = new RuntimeEnvironment(registry), root = request('root', { projectDir: '/p', workspaceDir: '/p/worktree' });
  registry.begin(root, 'running');
  registry.begin(request('same', { projectDir: '/p/./', workspaceDir: '/p/other' }), 'running');
  registry.begin(request('child', { parentSessionId: 'root', projectDir: '/elsewhere' }), 'running');
  registry.begin(request('foreign', { projectDir: '/secret', password: 'secret' }), 'running');
  registry.begin(request('blank'), 'running');
  let online = true; const remove = env.register('bridge', () => ({ online }));
  const first = await env.message(root, []), snapshot = JSON.parse(first.content);
  runtimeEnvironmentSnapshotSchema.parse(snapshot);
  assert.equal(first.role, 'user'); assert.equal(first.visibility, 'internal');
  assert.deepEqual(snapshot.sections.agents.items.map(f => f.agentId), ['root', 'same', 'child']);
  assert.doesNotMatch(first.content, /secret|Private user request|password/);
  assert.equal(snapshot.sections.capabilities.interactiveRequests, false);
  assert.equal(await env.message(root, [first]), undefined);
  online = false;
  const second = await env.message(root, [first]);
  assert.deepEqual(JSON.parse(second.content).sections, { bridge: { online: false } });
  assert.equal(JSON.parse(second.content).kind, 'update');
  assert.equal(await env.message(root, [first, second]), undefined);
  assert.equal(JSON.parse((await env.message(root, [])).content).kind, 'snapshot', 'compaction without facts gets a fresh snapshot');
  assert.equal(JSON.parse((await env.message(root, [second])).content).kind, 'snapshot', 'an orphaned update is not a full baseline');
  remove();
  assert.deepEqual(JSON.parse((await env.message(root, [first, second])).content).sections, { bridge: null }, 'removed sources invalidate old observations');
  env.close(); assert.equal(registry.get('root').status, 'running', 'closing observation does not own agent lifetime');
});

test('source failures cannot fail a turn, while cancellation remains cancellation', async () => {
  const env = new RuntimeEnvironment(), req = request('a');
  env.register('broken', () => { throw Error('credential must not leak'); });
  env.register('invalid', () => ({ value: 1n }));
  assert.deepEqual((await env.snapshot(req)).sections.broken, { status: 'unavailable' });
  assert.deepEqual((await env.snapshot(req)).sections.invalid, { status: 'unavailable' });
  assert.throws(() => env.register('agents', () => []), /already owned/);
  const abort = new AbortController(); abort.abort(Error('cancelled'));
  await assert.rejects(env.snapshot(req, abort.signal), /cancelled/);
});

test('a hung source is bounded and cannot block cancellation or other environment sections', async () => {
  const env = new RuntimeEnvironment(undefined, 20), req = request('a');
  env.register('hung', () => new Promise(() => {}));
  env.register('healthy', () => ({ ready: true }));
  env.register('huge', () => 'x'.repeat(70000));
  const snapshot = await env.snapshot(req);
  assert.deepEqual(snapshot.sections.hung, { status: 'unavailable' });
  assert.deepEqual(snapshot.sections.healthy, { ready: true });
  assert.equal(snapshot.sections.huge.reason, 'snapshot_too_large');
  const abort = new AbortController(), pending = env.snapshot(req, abort.signal); abort.abort(Error('cancel immediately'));
  await assert.rejects(pending, /cancel immediately/);
});

test('plugin sources are namespaced, revoked atomically, and cannot return stale snapshots', async () => {
  const env = new RuntimeEnvironment(), req = request('a'), gate = Promise.withResolvers();
  const sources = new Map([['connection', () => gate.promise]]);
  env.replaceOwned('plugin', sources, true);
  const pending = env.snapshot(req);
  env.setOwnerEnabled('plugin', false); env.setOwnerEnabled('plugin', true);
  gate.resolve({ online: true });
  assert.equal((await pending).sections.plugins, undefined, 'old generation is not published after re-enable');
  assert.equal((await env.snapshot(req)).sections.plugins.plugin.connection.online, true);
  const first = await env.message(req, []);
  env.removeOwned('plugin');
  assert.deepEqual(JSON.parse((await env.message(req, [first])).content).sections, { plugins: null });
});

test('completed history cannot displace live agents from the bounded environment view', async () => {
  const registry = new AgentExecutionRegistry(), env = new RuntimeEnvironment(registry), metadata = { projectDir: '/shared' };
  for (let i = 0; i < 80; i++) {
    const req = request(`old-${i}`, metadata); registry.begin(req); registry.observe(terminal(req.sessionId, req.turnId));
  }
  const self = request('self', metadata); registry.begin(self, 'running');
  registry.begin(request('live-peer', metadata), 'running');
  const agents = (await env.snapshot(self)).sections.agents;
  assert.equal(agents.total, 82); assert.equal(agents.items.length, 64);
  assert.deepEqual(agents.items.slice(0, 2).map(fact => fact.agentId), ['self', 'live-peer']);
});

test('host, extensions, parent and live Shadow read the same facts without altering the prefix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-environment-test-'));
  const gates = new Map(), requests = [], sessions = new SessionStore(); let extensionApi;
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, registerDefaultWorkspaceTools: false,
    extensions: [{ enabled: true, create: api => { extensionApi = api; return { id: 'fixture', features: [], commands: {} }; } }],
    provider: { async *stream(req) { requests.push(structuredClone(req)); const gate = Promise.withResolvers(); gates.set(req.sessionId, gate); await gate.promise; yield* answer(req); } } });
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); });
  const parent = host.runSessionTurn(request('root', { projectDir: root }));
  await until(() => gates.has('root'));
  const shadow = host.runSessionTurn(request('shadow', { projectDir: root, parentSessionId: 'root', agentRole: 'child', shadowMode: 'readonly' }));
  await until(() => gates.has('shadow'));
  const snapshot = await host.sendCommand({ kind: 'runtime.get_environment', payload: { sessionId: 'root' } });
  assert.equal(snapshot.sections.agents.items.length, 2);
  assert.deepEqual(snapshot, { ...(await extensionApi.environment.read('root')), effectiveAt: snapshot.effectiveAt });
  assert.deepEqual(extensionApi.conversations.list().map(f => f.agentId), ['root', 'shadow']);
  const shadowRequest = requests.find(r => r.sessionId === 'shadow');
  const observation = JSON.parse(shadowRequest.messages.find(m => m.name === 'runtime_environment').content);
  assert.equal(observation.sections.agents.self.readOnly, true);
  assert.equal(observation.sections.agents.self.canDelegate, false);
  assert.equal(shadowRequest.messages[0].content, 'Stable instructions');
  gates.get('shadow').resolve(); assert.equal((await shadow).payload.status, 'completed');
  assert.equal((await host.readEnvironment('root')).sections.agents.items.find(f => f.agentId === 'shadow').status, 'completed');
  gates.get('root').resolve(); assert.equal((await parent).payload.status, 'completed');
  assert.equal((await host.readEnvironment('root')).sections.agents.self.status, 'completed');
  await assert.rejects(host.runSessionTurn(request('root', { projectDir: root })), /already terminal/);
  assert.equal((await host.readEnvironment('root')).sections.agents.self.status, 'completed', 'rejected duplicates do not rewrite completed facts');
  assert.ok(sessions.snapshot('root').turns[0].messages.some(entry => entry.message.name === 'runtime_environment'), 'observation survives replay');
});

for (const mode of ['readonly', 'fork']) test(`closing a completed ${mode} Shadow removes its agent fact while its parent and sibling run`, async t => {
  const gates = new Map(), sessions = new SessionStore();
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, registerDefaultWorkspaceTools: false,
    provider: { async *stream(req) { const gate = Promise.withResolvers(); gates.set(req.sessionId, gate); await gate.promise; yield* answer(req); } } });
  const jobs = [];
  t.after(async () => { for (const gate of gates.values()) gate.resolve(); await Promise.allSettled(jobs); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); });
  const metadata = { parentSessionId: 'root', agentRole: 'child', shadowMode: mode,
    shadowOfSessionId: 'root', shadowConversationId: 'shadow-window', temporary: true };
  sessions.ensureSession('shadow', metadata);
  sessions.ensureSession('delegated', { parentSessionId: 'root', agentRole: 'child' });
  for (const [id, meta] of [['root', {}], ['sibling', { parentSessionId: 'root', agentRole: 'child' }], ['shadow', metadata]]) {
    jobs.push(host.runSessionTurn(request(id, meta)));
    await until(() => gates.has(id));
  }
  const remove = sessionId => host.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId } });
  await assert.rejects(remove('shadow'), /Wait for this conversation/, 'an executing Shadow still protects itself');
  await assert.rejects(remove('delegated'), /Wait for this conversation/, 'normal delegated children retain the parent guard');
  gates.get('shadow').resolve(); assert.equal((await jobs[2]).payload.status, 'completed');
  assert.equal((await host.readEnvironment('root')).sections.agents.items.find(f => f.agentId === 'shadow').status, 'completed');
  assert.equal((await remove('shadow')).deleted, true);
  assert.equal(sessions.snapshot('shadow'), undefined);
  const facts = (await host.readEnvironment('root')).sections.agents.items;
  assert.equal(facts.some(f => f.agentId === 'shadow'), false, 'deleted Shadow is absent from environment');
  for (const id of ['root', 'sibling']) {
    assert.equal(facts.find(f => f.agentId === id)?.status, 'running');
    assert.equal(host.hasActiveSession(id), true);
    gates.get(id).resolve();
  }
  for (const pending of jobs) assert.equal((await pending).payload.status, 'completed');
});

test('Assistant registers its own parent execution and refreshes environment in the shared journal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-assistant-environment-')), registry = new AgentExecutionRegistry(), env = new RuntimeEnvironment(registry), gate = Promise.withResolvers();
  const seen = []; const assistant = new AssistantConversation(new ConversationJournal(root), {
    environment: env, agents: registry, exists: () => true, tasks: () => [], checkpoint: () => ({}), delegate: async () => ({}),
    provider: { async *stream(req) { seen.push(req); await gate.promise; yield* answer(req); } } });
  t.after(async () => { gate.resolve(); assistant.close(); await rm(root, { recursive: true, force: true }); });
  const id = PERSONAL_ASSISTANT_SESSION;
  assistant.command({ action: 'turn', sessionId: id, parent: request(id), profile: assistantProfileSchema.parse({}),
    entry: { id: 'input', role: 'user', source: 'text', visibility: 'conversation', content: 'Hello', createdAt: new Date().toISOString() } });
  await until(() => seen.length);
  assert.equal(registry.get(id).status, 'running'); assert.equal(registry.get(id).canWake, false);
  assert.equal(JSON.parse(seen[0].messages.find(m => m.name === 'runtime_environment').content).sections.agents.self.agentId, id);
  gate.resolve(); await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
  assert.equal(registry.get(id).status, 'completed');
  assistant.forget(id); assert.equal(registry.get(id), undefined);
});

test('plugin state and tool ownership commit together; instructions use the separate notice channel', async t => {
  const sessions = new SessionStore(), seen = [];
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, registerDefaultWorkspaceTools: false,
    provider: { async *stream(req) { seen.push(req); yield* answer(req); } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  let calls = 0;
  const create = api => {
    api.environment.register('connection', () => ({ online: true }));
    api.tools.register({ definition: { name: 'fixture_action', description: 'Perform action', inputSchema: { type: 'object', properties: {} } },
      manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: input => input, execute: () => { calls++; return {}; } });
    return { id: 'fixture', features: [], commands: {}, conversationContext: async () => [{ role: 'user', content: 'Fixture collaboration notice' }] };
  };
  host.installExtension(create);
  sessions.ensureSession('root', {});
  assert.equal((await host.readEnvironment('root')).sections.plugins, undefined);
  host.setExtensionEnabled('fixture', true);
  assert.equal((await host.readEnvironment('root')).sections.plugins.fixture.connection.online, true);
  assert.equal(calls, 0, 'environment reads never execute a tool');
  await host.runSessionTurn(request('root'));
  assert.ok(seen[0].messages.some(m => m.name === 'agent_peer_context' && m.content.includes('Fixture collaboration notice')));
  assert.doesNotMatch(seen[0].messages.find(m => m.name === 'runtime_environment').content, /Fixture collaboration notice|botRouting/);
  assert.throws(() => host.installExtension(api => { api.environment.register('orphan', () => true); return { id: 'bad', features: [], commands: { 'runtime.get_environment': () => null } }; }), /conflicts/);
  assert.equal((await host.readEnvironment('root')).sections.plugins.bad, undefined);
  host.removeExtension('fixture');
  assert.equal((await host.readEnvironment('root')).sections.plugins, undefined);
});

test('voice lifetime and text turn are independent leases in the same environment', async t => {
  const gate = Promise.withResolvers(), sessions = new SessionStore();
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, registerDefaultWorkspaceTools: false,
    provider: { async *stream(req) { await gate.promise; yield* answer(req); } } });
  t.after(async () => { gate.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); });
  const text = host.runSessionTurn(request('root'));
  await until(() => host.hasActiveSession('root'));
  const observe = (executionId, status) => host.sendCommand({ kind: 'runtime.observe_agent', payload: { sessionId: 'root', executionId, status, channel: 'realtime_voice' } });
  await observe('call-a', 'running');
  let facts = (await host.readEnvironment('root')).sections.agents.items;
  assert.equal(facts.filter(f => f.status === 'running').length, 2);
  await observe('call-a', 'stopped'); await observe('call-b', 'running'); await observe('call-a', 'waiting');
  facts = (await host.readEnvironment('root')).sections.agents.items;
  assert.equal(facts.find(f => f.executionId === 'turn-root').status, 'running');
  assert.equal(facts.find(f => f.executionId === 'realtime_voice:call-b').status, 'running');
  assert.ok(!facts.some(f => f.executionId === 'realtime_voice:call-a' && f.status === 'waiting'));
  gate.resolve(); await text;
  assert.equal((await host.readEnvironment('root')).sections.agents.items.find(f => f.executionId === 'realtime_voice:call-b').status, 'running');
  await observe('call-b', 'stopped');
});

test('sandbox observation uses execution policy including all_free and required mode', async t => {
  const sessions = new SessionStore(); let mode = 'auto';
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, registerDefaultWorkspaceTools: false,
    loadCommandSandbox: async () => ({ mode, network: 'disabled', readableRoots: [], writableRoots: [] }), provider: { stream: answer } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  await host.runSessionTurn(request('root', { workspaceDir: process.cwd() }));
  assert.deepEqual((await host.readEnvironment('root')).sections.sandbox, { mode: 'auto', active: false, network: 'host', readableRoots: [], writableRoots: [] });
  mode = 'required';
  assert.equal((await host.readEnvironment('root')).sections.sandbox.network, 'disabled');
  assert.deepEqual((await host.readEnvironment('root')).sections.sandbox.writableRoots, [process.cwd()]);
});


test('remote projection uses the existing task ledger, scopes identity by host and excludes task content', async () => {
  const { remoteAgentFacts } = await import('../dist/environmentResources.js');
  const base = { childSessionId: 'remote-child', childTurnId: 't', parentSessionId: 'root', status: 'running',
    createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:01Z', prompt: 'PRIVATE', finalResponse: 'SECRET' };
  const facts = remoteAgentFacts([{ ...base, remote: { connectionId: 'host-a', worker: { instructions: 'PRIVATE' } } },
    { ...base, remoteAcceptedAt: base.createdAt, remote: { connectionId: 'host-b' }, observation: { state: 'input_required' } },
    { ...base, remote: { connectionId: 'host-c' }, status: 'unavailable', observationError: 'credential-secret' }]);
  assert.deepEqual(facts.map(f => [f.hostId, f.status]), [['host-a', 'queued'], ['host-b', 'waiting'], ['host-c', 'unavailable']]);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|SECRET|credential/);
  assert.ok(facts.every(f => f.transport === 'remote' && !f.canWake));
});


test('an automatic sandbox does not invent permissions for a voice-only session', async () => {
  const { registerSandboxEnvironment } = await import('../dist/environmentResources.js');
  const env = new RuntimeEnvironment();
  registerSandboxEnvironment(env, { commandSandbox: { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] } });
  assert.deepEqual((await env.snapshot({ sessionId: 'voice', turnId: 'call', metadata: {} })).sections.sandbox,
    { mode: 'auto', active: null, reason: 'request_policy_unknown' });
});
