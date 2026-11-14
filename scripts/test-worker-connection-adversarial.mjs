import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { callRemoteWorker } from '../dist-electron/remoteWorkers.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { agentApiPath } from '../dist-electron/agentTypes.js';
import { InMemoryRuntimeHost, SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { registerWorkerConnectionTool } from '../packages/bush-runtime/dist/workerConnectionTool.js';
import { AssistantConversation } from '../packages/bush-runtime/dist/assistantConversation.js';
import { ConversationJournal } from '../packages/bush-runtime/dist/conversationJournal.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';

const snapshot = { id: 'saved-worker', name: 'Fixture', connected: false, connectionState: 'unverified', hasToken: true };
async function temporary(t, close = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-worker-adversarial-'));
  t.after(async () => { await close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.match(root, /cardbush-worker-adversarial-/); await rm(root, { recursive: true, force: true }); });
  return root;
}

function toolFixture() {
  const registry = new ToolRegistry(), calls = [];
  registerWorkerConnectionTool(registry, { connection: async (input, signal) => { calls.push({ input, signal }); return snapshot; } });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => assert.fail('Unexpected permission escalation') } });
  const invoke = (args, metadata = {}, options = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'worker_connection', argumentsText: JSON.stringify(args) },
    { requestId: 'request', sessionId: 'parent', turnId: 'turn', round: 1, ordinal: 0 }, options.signal,
    { request: { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'parent', turnId: 'turn', model: 'fixture',
      messages: [], tools: options.tools ?? registry.definitions(), permissionMode: 'all_free', metadata }, contextMessages: [] });
  return { calls, registry, invoke };
}

test('worker tool rejects credential, endpoint, command and authority injection before host dispatch', async () => {
  const f = toolFixture();
  const attacks = [null, [], {}, { action: 'restart', connection_id: 'saved-worker' }, { action: 'verify', connection_id: '' },
    { action: 'verify', connection_id: 'x'.repeat(201) },
    ...['url', 'token', 'sshTunnel', 'command', 'sessionId', 'parent', 'metadata', 'permissionMode', '__proto__', 'constructor'].map(key =>
      JSON.parse(`{"action":"reconnect","connection_id":"saved-worker","${key}":"attacker-controlled"}`))];
  for (const input of attacks) {
    const result = await f.invoke(input);
    assert.notEqual(result.kind, 'returned', JSON.stringify(input));
  }
  assert.equal(f.calls.length, 0);
  assert.equal({}.polluted, undefined);
  const controller = new AbortController(); controller.abort();
  assert.notEqual((await f.invoke({ action: 'reconnect', connection_id: 'saved-worker' }, {}, { signal: controller.signal })).kind, 'returned');
  assert.equal(f.calls.length, 0);
});

test('worker tool cannot bypass Web, child allowlist, disabled-tool or read-only restrictions', async () => {
  const f = toolFixture(), input = { action: 'reconnect', connection_id: 'saved-worker' };
  for (const metadata of [
    { toolExecutionPolicy: 'web_restricted' },
    { agentRole: 'child', registeredAgentReadOnly: true },
    { agentRole: 'child', shadowReadOnly: true },
    { agentRole: 'child', shadowMode: 'readonly' },
    { agentRole: 'child', childToolAllowlist: ['read_file'] },
    { agentRole: 'child', disabledTools: ['worker_connection'] },
  ]) assert.notEqual((await f.invoke(input, metadata)).kind, 'returned', JSON.stringify(metadata));
  assert.notEqual((await f.invoke(input, {}, { tools: [] })).kind, 'returned');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.invoke(input, { agentRole: 'child', childToolAllowlist: ['worker_connection'] })).kind, 'returned');
  assert.equal(f.calls.length, 1, 'permitted diagnostics remain available');
});

for (const operation of ['agents.verify', 'agents.reconnect']) {
  test(`${operation}: an abort during registration lookup prevents the operation from starting`, async () => {
    const lookup = Promise.withResolvers(), controller = new AbortController(); let operations = 0;
    const manager = { list: () => lookup.promise, verify: async () => { operations++; }, reconnect: async () => { operations++; } };
    const pending = assert.rejects(callRemoteWorker(manager, operation, { connectionId: snapshot.id }, controller.signal), { name: 'AbortError' });
    controller.abort(); lookup.resolve([snapshot]); await pending;
    assert.equal(operations, 0, 'cancelled lookup must not start a verification or close any connection');
  });
}

test('worker management failure receipts never expose an unexpected teardown error', async () => {
  const marker = 'isolated-private-fixture-credential';
  const manager = { list: async () => [snapshot], reconnect: async () => { throw Error(`tunnel teardown ${marker}`); } };
  await assert.rejects(callRemoteWorker(manager, 'agents.reconnect', { connectionId: snapshot.id }), error => {
    assert.doesNotMatch(error.message, /isolated-private|tunnel teardown/);
    return true;
  });
});

test('saved IDs are opaque and cannot become arbitrary network or process targets', async () => {
  let calls = 0;
  const manager = { list: async () => [snapshot], verify: async () => { calls++; }, reconnect: async () => { calls++; } };
  for (const connectionId of ['https://attacker.invalid/', 'http://169.254.169.254/', '../workers.json', '__proto__', 'constructor', 'saved-worker\u0000']) {
    await assert.rejects(callRemoteWorker(manager, 'agents.verify', { connectionId }));
  }
  assert.equal(calls, 0);
});

test('runtime cancellation reaches an in-flight worker operation through the realtime entry', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(); let receivedSignal, host;
  host = new InMemoryRuntimeHost({ dataRoot: await temporary(t, async () => { finish.resolve(); await host?.sendCommand({ kind: 'runtime.shutdown' }); }), remoteAgents: { list: async () => [snapshot],
    connection: async (_input, signal) => { receivedSignal = signal; entered.resolve(); await finish.promise; return snapshot; } } });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} }), controller = new AbortController();
  const pending = host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: { sessionId: 'parent', callId: 'connection', action: 'worker_connection',
    nativeArguments: { action: 'verify', connection_id: snapshot.id },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'parent', turnId: 'turn', model: 'fixture', tools, prefixMessages: [],
      inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Verify' } }], permissionMode: 'all_free', metadata: {} } } }, controller.signal);
  const result = Promise.allSettled([pending]);
  await entered.promise; controller.abort(); await yieldTurn(); finish.resolve();
  assert.ok(receivedSignal?.aborted, 'the runtime boundary must preserve cancellation');
  assert.equal((await result)[0].status, 'rejected');
});

test('Assistant stop cancels its pending worker call and rejects a late successful reply', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), { registry } = toolFixture();
  let receivedSignal, requests = 0, assistant;
  assistant = new AssistantConversation(new ConversationJournal(await temporary(t, async () => { finish.resolve(); assistant?.close(); await yieldTurn(); })), {
    checkpoint: () => ({ name: 'checkpoint', description: 'Fixture', inputSchema: {} }), exists: () => true, tasks: () => [],
    delegationTools: () => registry.definitions(),
    delegate: async (input, signal) => { assert.equal(input.action, 'worker_connection'); receivedSignal = signal; entered.resolve(); await finish.promise; return snapshot; },
    provider: { async *stream(request) {
      requests++;
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'verify', nameDelta: 'worker_connection',
        argumentsDelta: JSON.stringify({ action: 'verify', connection_id: snapshot.id }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } },
  });
  const sessionId = PERSONAL_ASSISTANT_SESSION;
  assistant.command({ action: 'turn', sessionId,
    entry: { id: 'input', content: 'Verify the worker', role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId, turnId: 't', model: 'fixture', prefixMessages: [],
      inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Verify the worker' } }], tools: registry.definitions(),
      metadata: { assistantOutputMode: 'text' }, permissionMode: 'task_free' }, profile: assistantProfileSchema.parse({}),
  });
  await entered.promise;
  assistant.command({ action: 'stop', sessionId });
  assert.ok(receivedSignal?.aborted);
  finish.resolve(); await yieldTurn(); await yieldTurn();
  assert.equal(requests, 1, 'late tool receipt cannot restart the stopped parent');
  assert.equal(assistant.journal.modelHistory(sessionId).read().messages.filter(message => message.role === 'tool').length, 0);
});

test('cancelling a realtime parent does not cancel an already admitted independent child', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), tasks = new SubagentTaskStore(); let childSignal, host;
  host = new InMemoryRuntimeHost({ dataRoot: await temporary(t, async () => { finish.resolve(); await host?.sendCommand({ kind: 'runtime.shutdown' }); }), subagentTaskStore: tasks, provider: { async *stream(request, { signal }) {
    assert.equal(request.metadata.agentRole, 'child'); childSignal = signal; entered.resolve(); await finish.promise;
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Independent work completed.' };
    yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
  } } });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} }), controller = new AbortController();
  const receipt = await host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: { sessionId: 'parent', callId: 'delegation', action: 'subagent', prompt: 'Independent fixture',
    parent: { protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 'parent', turnId: 't', model: 'fixture', tools, prefixMessages: [],
      inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Inspect' } }], permissionMode: 'task_free', metadata: {} } } }, controller.signal);
  assert.equal(receipt.status, 'running'); await entered.promise; controller.abort(); await yieldTurn();
  assert.ok(childSignal && !childSignal.aborted);
  finish.resolve();
  const deadline = AbortSignal.timeout(3000);
  while (tasks.get('parent', receipt.taskId).status === 'running') {
    await tasks.waitForChange('parent', receipt.taskId, tasks.get('parent', receipt.taskId).revision, deadline);
  }
  assert.equal(tasks.get('parent', receipt.taskId).status, 'completed');
});

test('Web-restricted runtime never advertises local worker management and rejects raw worker API access', async t => {
  const service = await AgentService.open({ dataRoot: await temporary(t), webRestricted: true });
  try {
    const tools = await service.runtime.transport.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
    assert.ok(!tools.some(tool => tool.name === 'worker_connection'));
    await assert.rejects(service.call('runtime.command', { kind: 'runtime.get_tool_catalog', payload: {} }));
    await assert.rejects(service.call('workers.command', { action: 'verify', id: snapshot.id }));
    await assert.rejects(service.call('workers.command', { action: 'list' }));
  } finally { await service.close(); }
});

test('hostile HTTP responses cannot redirect credentials or replace a pinned worker identity', async t => {
  let manager;
  const token = 'synthetic-worker-adversarial-secret', root = await temporary(t, () => manager?.close());
  let mode = 'valid', redirectStatus = 302, trapRequests = 0;
  const trap = createServer((_req, res) => { trapRequests++; res.end('{}'); });
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
  t.after(() => { trap.closeAllConnections(); trap.close(); });
  const endpoint = createServer((req, res) => {
    if (req.url !== `${agentApiPath}/info`) {
      // Also detect a redirect to a different path on the same origin.
      trapRequests++; res.end('{}'); return;
    }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    if (mode === 'redirect' || mode === 'same-origin') {
      res.writeHead(redirectStatus, { location: mode === 'redirect' ? `http://127.0.0.1:${trap.address().port}/trap` : '/trap' }).end(); return;
    }
    if (mode === '401' || mode === '500') { res.writeHead(Number(mode)).end(JSON.stringify({ error: { message: token, code: token } })); return; }
    res.setHeader('x-cardbush-agent-id', 'pinned-worker');
    if (mode === 'malformed') { res.end(`not json ${token}`); return; }
    res.end(JSON.stringify({ protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'],
      id: mode === 'wrong-body-identity' ? 'replacement-worker' : 'pinned-worker', name: 'Fixture', platform: 'test', capabilities: { durableQueue: true } }));
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  t.after(() => { endpoint.closeAllConnections(); endpoint.close(); });
  manager = new AgentConnectionManager(join(root, 'workers.json'), {
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
  }, { healthIntervalMs: 60_000 });
  const [saved] = await manager.save({ name: 'Fixture', transport: 'http', url: `http://127.0.0.1:${endpoint.address().port}/`, token });
  const verify = () => callRemoteWorker(manager, 'agents.verify', { connectionId: saved.id });
  assert.equal((await verify()).connectionState, 'connected');
  for (const attack of ['redirect', 'same-origin', '401', '500', 'malformed', 'wrong-body-identity']) {
    for (const status of attack.includes('origin') || attack === 'redirect' ? [301, 302, 307, 308] : [0]) {
      mode = attack; redirectStatus = status;
      const receipt = await verify();
      assert.equal(receipt.connectionState, 'failed', attack); assert.equal(receipt.connected, false);
      assert.equal(receipt.agentId, 'pinned-worker', 'failure cannot adopt a replacement identity');
      assert.doesNotMatch(JSON.stringify(receipt), /synthetic-worker|replacement-worker|127\.0\.0\.1|not json/);
      assert.equal(trapRequests, 0, 'no redirect target may receive a request or Authorization header');
      mode = 'valid'; assert.equal((await verify()).connectionState, 'connected');
    }
  }
});
