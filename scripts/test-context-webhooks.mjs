import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, Agent } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { InMemoryRuntimeHost, InMemoryRuntimeEventLog, SessionStore, ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { applyWebhookTurnPolicy, assistantProfileSchema } from '@cardbush/bush-protocol';
import { ContextWebhookHost } from '../dist-electron/contextWebhookHost.mjs';
import { runContextWebhook } from '../dist-electron/contextWebhookRuntime.mjs';
import { renderWebhookBody, webhookConfigSchema, incomingMessage } from '../dist-electron/contextWebhookProtocol.mjs';

const secrets = { encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
const request = (sessionId, text = 'hello', turnId = 'initial') => ({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId, turnId,
  model: 'fixture', tools: [], prefixMessages: [], inputMessages: [{ messageId: turnId, message: { role: 'user', content: text } }], metadata: {}, permissionMode: 'task_free' });
const config = (extra = {}) => ({ name: 'External bot', enabled: true, url: '', headers: {}, parameters: {},
  body: { text: '{{reply}}', id: '{{messageId}}', status: '{{status}}', eventId: '{{eventId}}' },
  incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' }, ...extra });
const binding = (sessionId = 'existing') => ({ kind: 'conversation', sessionId, title: 'Existing conversation', parent: request(sessionId) });
const message = (messageId, text = 'Continue') => ({ messageId, text, senderId: 'u-1', conversationId: 'remote-chat' });
const until = async fn => { for (let n = 0; n < 160; n++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out'); };
async function* answer(request, text) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  yield { ...base, sequence: 1, kind: 'text_delta', delta: text };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
}
function client(connection) {
  const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
  return { send: value => fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify(value) }),
    read: async id => { const response = await fetch(`${connection.endpoint}/${encodeURIComponent(id)}`, { headers }); return response.json(); } };
}

test('parameter mapping and JSON templates preserve escaped values and reject unsafe paths/headers', () => {
  const mapping = { messageId: 'event.id', text: 'event.body.text', senderId: 'event.sender', conversationId: 'event.chat' };
  assert.deepEqual(incomingMessage({ event: { id: 23, body: { text: 'hello' }, sender: 'u' } }, mapping), { messageId: '23', text: 'hello', senderId: 'u', conversationId: undefined });
  const rendered = renderWebhookBody({ content: '{{reply}}', receiver: '{{parameters.receiver}}', data: '{{parameters.data}}' },
    { reply: '"quoted"\nnew line', parameters: { receiver: 'abc', data: [1, 2] } });
  assert.deepEqual(rendered, { content: '"quoted"\nnew line', receiver: 'abc', data: [1, 2] });
  assert.throws(() => renderWebhookBody('{{parameters.missing}}', { parameters: {} }), /template_variable_missing/);
  assert.equal(webhookConfigSchema.safeParse(config({ incoming: { ...mapping, text: '__proto__.text' } })).success, false);
  assert.equal(webhookConfigSchema.safeParse(config({ headers: { Authorization: 'a\r\nb' } })).success, false);
  assert.equal(webhookConfigSchema.safeParse(config({ url: 'http://example.com/reply' })).success, false);
});

test('desktop HTTP binding continues the existing Runtime history, routes callbacks, and survives restart without rerunning', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'context-webhook-')), calls = [], delivered = [];
  const receiver = createServer(async (req, res) => { let text = ''; for await (const part of req) text += part;
    delivered.push({ body: JSON.parse(text), authorization: req.headers.authorization }); res.writeHead(200).end(); });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const runtime = new InMemoryRuntimeHost({ sessionStore: new SessionStore(), provider: { async *stream(input) {
    calls.push(input); yield* answer(input, calls.length === 1 ? 'I remember olive.' : 'The word was olive.');
  } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  let gateway;
  try {
    await runtime.runSessionTurn(request('existing', 'Remember olive.'));
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const savedBinding = binding();
    savedBinding.parent.inputMessages.unshift({ messageId: 'old-clock', message: { role: 'user', name: 'turn_runtime_context',
      visibility: 'internal', content: '<time_context>old binding time</time_context>' } });
    const saved = await gateway.command({ action: 'save', config: config({ url: `http://127.0.0.1:${receiver.address().port}/reply`,
      headers: { Authorization: 'Bearer external-private' }, parameters: { receiver: 'room-1' },
      body: { text: '{{reply}}', receiver: '{{parameters.receiver}}', eventId: '{{eventId}}' } }), binding: savedBinding });
    assert.equal(saved.listening, true); const connection = saved.connections[0], bot = client(connection);
    assert.equal((await fetch(connection.endpoint, { method: 'POST' })).status, 401);
    const submittedAfter = Date.now();
    const accepted = await bot.send(message('first')); assert.equal(accepted.status, 202);
    assert.equal((await bot.send(message('first'))).status, 202);
    assert.equal((await bot.send(message('first', 'different'))).status, 409);
    const result = await until(async () => { const value = await bot.read('first'); return value.status === 'completed' && value; });
    assert.equal(result.sessionId, 'existing'); assert.equal(result.reply, 'The word was olive.');
    assert.equal(calls.length, 2); assert.match(JSON.stringify(calls[1].messages), /Remember olive/);
    assert.equal(calls[0].permissionMode, 'task_free'); assert.equal(calls[1].permissionMode, 'all_free');
    assert.equal(calls[1].requestCapabilities.interactiveRequests, false);
    assert.equal(savedBinding.parent.permissionMode, 'task_free', 'binding preparation does not mutate local settings');
    const clock = calls[1].messages.find(m => m.name === 'turn_runtime_context');
    assert.equal(clock.visibility, 'internal');
    assert.match(clock.content, /Snapshot at message submission \(UTC\):/);
    const timestamp = Date.parse(clock.content.match(/Snapshot at message submission \(UTC\): (.+)/)[1]);
    assert.ok(timestamp >= submittedAfter && timestamp <= Date.now(), 'each webhook input receives a fresh host clock');
    assert.ok(!calls[1].messages.some(m => m.content.includes('old binding time')));
    await until(() => delivered.length); assert.equal(delivered[0].body.receiver, 'room-1'); assert.equal(delivered[0].authorization, 'Bearer external-private');
    const disk = await readFile(join(root, 'webhooks/state.json'), 'utf8'); assert.ok(!disk.includes(connection.token) && !disk.includes('external-private'));
    await gateway.close(); gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const reopened = (await gateway.command({ action: 'read', sessionId: 'existing' })).connections[0];
    assert.equal((await client(reopened).send(message('first'))).status, 202); assert.equal(calls.length, 2);
    assert.deepEqual((await gateway.command({ action: 'read', sessionId: 'another' })).connections, []);
    await assert.rejects(gateway.command({ action: 'save', config: config({ id: reopened.id }), binding: binding('another') }));
    await gateway.command({ action: 'delete', id: reopened.id, sessionId: 'existing' });
    assert.equal((await client(reopened).send(message('after-delete'))).status, 401, 'deletion revokes message access while local discovery stays available');
    assert.equal((await gateway.command({ action: 'read', sessionId: 'existing' })).listening, true);
  } finally { await gateway?.close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('Assistant webhook uses the same journal, correlates replies and rejects a cleared context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-assistant-')), calls = [];
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), toolRegistry: new ToolRegistry(), provider: { async *stream(input) {
    calls.push(input); yield* answer(input, 'The earlier topic was olive.');
  } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) }, sessionId = 'personal-assistant';
  try {
    await bridge.command('runtime.create_session', { sessionId });
    await bridge.command('runtime.assistant_conversation', { action: 'append', sessionId,
      entry: { id: 'prior', role: 'user', source: 'text', visibility: 'conversation', content: 'Remember olive.', createdAt: new Date().toISOString() } });
    const selected = { ...binding(sessionId), kind: 'assistant', generation: 0, profile: assistantProfileSchema.parse({}) };
    const result = await runContextWebhook(bridge, selected, message('a'), 'unique', false, new AbortController().signal);
    assert.equal(result.status, 'completed'); assert.match(result.reply, /olive/); assert.match(JSON.stringify(calls[0].messages), /Remember olive/);
    assert.equal(calls[0].permissionMode, 'all_free'); assert.equal(calls[0].requestCapabilities.interactiveRequests, false);
    assert.match(calls[0].messages[0].content, /question in your final reply/);
    const journal = await bridge.command('runtime.assistant_conversation', { action: 'read', sessionId });
    assert.ok(journal.entries.find(e => e.role === 'assistant').responseTo.includes('webhook-input-unique'));
    const clocks = calls[0].messages.filter(m => m.name === 'turn_runtime_context');
    assert.equal(clocks.length, 2, 'historical input and the webhook message each keep their own timestamp');
    assert.ok(clocks.at(-1).content.includes(journal.entries.find(e => e.id === 'webhook-input-unique').createdAt));
    const resumed = await runContextWebhook(bridge, selected, message('a'), 'unique', true, new AbortController().signal);
    assert.equal(resumed.reply, result.reply); assert.equal(calls.length, 1);
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
    await assert.rejects(runContextWebhook(bridge, selected, message('b'), 'next', false, new AbortController().signal), /context_reset/);
  } finally { await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});

test('legacy webhook bindings use full access, deny question cards and continue from a final-reply question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-policy-')), log = new InMemoryRuntimeEventLog(), registry = new ToolRegistry();
  const calls = []; let executions = 0;
  registry.register({ definition: { name: 'fixture_operation', description: 'An operation requiring permission.', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'medium', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    decodeInput: value => value,
    authorize: () => ({ kind: 'ask', request: { reason: 'Fixture authorization', actions: ['write'], targets: [], capabilityIds: ['fixture:write'] } }),
    execute: () => { executions++; return { written: true }; } });
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, eventLog: log, toolRegistry: registry, provider: { async *stream(input) {
    calls.push(input);
    if (input.turnId === 'local') {
      assert.equal(input.permissionMode, 'task_free'); assert.equal(input.requestCapabilities.interactiveRequests, true);
      assert.ok(input.tools.some(tool => tool.name === 'request_user_input_async'), 'the first webhook turn must not remove questions from the durable local catalog');
      yield* answer(input, 'Local conversation.'); return;
    }
    assert.equal(input.permissionMode, 'all_free'); assert.equal(input.requestCapabilities.interactiveRequests, false);
    assert.ok(!input.tools.some(tool => tool.name === 'request_user_input_async'));
    assert.match(input.messages.find(m => m.name === 'webhook_delivery_policy').content, /question in your final reply/);
    const call = calls.length === 1 ? { name: 'fixture_operation', args: {} } : calls.length === 2
      ? { name: 'request_user_input_async', args: { questions: [{ id: 'color', prompt: 'Which color?', options: ['Blue', 'Green'] }] } } : undefined;
    if (call) {
      const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'call-' + calls.length, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
    } else yield* answer(input, calls.length === 3 ? 'Which color should I use, blue or green?' : 'I will use blue.');
  } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  try {
    await bridge.command('runtime.create_session', { sessionId: 'existing' });
    const selected = binding(); selected.parent.tools = await bridge.command('runtime.get_tool_catalog', {});
    selected.parent.requestCapabilities = { vision: true, interactiveRequests: true };
    selected.parent.prefixMessages = [{ role: 'system', content: 'Fixture policy.' }];
    selected.parent.metadata.systemPolicy = { id: 'fixture', version: '1' };
    const original = structuredClone(selected);
    const applied = applyWebhookTurnPolicy(selected.parent);
    assert.equal(applied.requestCapabilities.vision, true); assert.deepEqual(applyWebhookTurnPolicy(applied), applied);
    const first = await runContextWebhook(bridge, selected, message('q', 'Prepare a design.'), 'question', false, new AbortController().signal);
    assert.equal(first.status, 'completed'); assert.equal(first.reply, 'Which color should I use, blue or green?');
    assert.equal(executions, 1);
    assert.ok(!log.replay('existing', 'webhook-question').some(e => ['permission_requested', 'solution_selection_requested'].includes(e.kind)));
    assert.deepEqual(await bridge.command('runtime.list_solution_selections', { sessionId: 'existing' }), []);
    const next = await runContextWebhook(bridge, selected, message('a', 'Blue.'), 'answer', false, new AbortController().signal);
    assert.equal(next.status, 'completed'); assert.equal(next.reply, 'I will use blue.');
    assert.ok(calls.at(-1).messages.some(m => m.role === 'assistant' && m.content === first.reply));
    assert.ok(calls.at(-1).messages.some(m => m.role === 'user' && m.content === 'Blue.'));
    assert.deepEqual(selected, original, 'legacy saved data and local preferences remain unchanged');
    await runtime.runSessionTurn({ ...selected.parent, requestId: 'local', turnId: 'local',
      inputMessages: [{ messageId: 'local', message: { role: 'user', content: 'Continue here.' } }] });
  } finally { await bridge.command('runtime.shutdown', {}); await rm(root, { recursive: true, force: true }); }
});

test('delivery retry does not call the model again; disabled/deleted bindings stop accepting messages', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-retry-')); let deliveries = 0, executions = 0;
  const receiver = createServer((req, res) => { req.resume(); res.writeHead(++deliveries === 1 ? 503 : 200).end(); });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const gateway = await new ContextWebhookHost(root, secrets, { command: async () => ({}) }, { port: 0,
    execute: async () => { executions++; return { status: 'completed', reply: 'done' }; } }).start();
  try {
    const cfg = config({ url: `http://127.0.0.1:${receiver.address().port}/` });
    const connection = (await gateway.command({ action: 'save', config: cfg, binding: binding() })).connections[0];
    await client(connection).send(message('retry')); await until(() => deliveries >= 2); assert.equal(executions, 1);
    await gateway.command({ action: 'save', config: { ...cfg, id: connection.id, enabled: false }, binding: binding() });
    assert.equal((await client(connection).send(message('after-disable'))).status, 401);
    assert.equal((await gateway.command({ action: 'read', sessionId: 'existing' })).listening, true);
  } finally { await gateway.close(); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('generic local pairing exchanges parameters only after desktop authorization and survives restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-pairing-')), runtime = { command: async () => ({}) }; let gateway;
  try {
    gateway = await new ContextWebhookHost(root, secrets, runtime, { port: 0 }).start();
    let view = await gateway.command({ action: 'read', sessionId: 'chosen-session' });
    let base = `http://127.0.0.1:${view.port}`;
    assert.equal(view.listening, true, 'first-time discovery needs no saved connection');
    assert.equal((await (await fetch(base + '/api/webhooks/v1/discovery')).json()).protocol, 'cardbush.webhook.v1');
    assert.equal((await fetch(base + '/api/webhooks/v1/discovery', { headers: { Origin: 'https://example.com' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      // Bypass inherited environment proxies so the test sends this exact Host header.
      const req = httpRequest(base + '/api/webhooks/v1/discovery', { agent: new Agent({ proxyEnv: {} }), headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(foreignHost, 403);
    const body = { requestId: randomUUID(), name: 'Independent generic service', replyUrl: 'http://127.0.0.1:4792/reply', replyHeaders: { Authorization: 'Bearer private-callback' } };
    const headers = { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' };
    const post = value => fetch(base + '/api/webhooks/v1/pairings', { method: 'POST', headers, body: JSON.stringify(value) });
    const poll = () => fetch(base + '/api/webhooks/v1/pairings/' + body.requestId, { headers });
    assert.equal((await post({ ...body, replyUrl: 'http://example.com/reply' })).status, 400);
    assert.equal((await post({ ...body, sessionId: 'unapproved' })).status, 400);
    assert.equal((await post(body)).status, 202); assert.equal((await post(body)).status, 202);
    const waiting = await (await poll()).json(); assert.equal(waiting.status, 'pending'); assert.equal(waiting.connection, undefined);
    view = await gateway.command({ action: 'read', sessionId: 'chosen-session' });
    assert.equal(view.connections.length, 0); assert.equal(view.pairings.length, 1);
    assert.equal(JSON.stringify(view.pairings).includes('private-callback'), false);
    await gateway.close(); gateway = await new ContextWebhookHost(root, secrets, runtime, { port: 0 }).start();
    base = `http://127.0.0.1:${(await gateway.command({ action: 'read', sessionId: 'chosen-session' })).port}`;
    assert.equal((await (await poll()).json()).status, 'pending');
    view = await gateway.command({ action: 'approve_pairing', requestId: body.requestId, binding: binding('chosen-session') });
    const grant = await (await poll()).json(); assert.equal(grant.status, 'connected'); assert.equal(grant.connection.sessionId, 'chosen-session');
    assert.equal(grant.connection.token, view.connections[0].token); assert.equal(view.pairings.length, 0);
    assert.equal(view.connections[0].headers.Authorization, body.replyHeaders.Authorization);
    assert.equal(view.connections[0].body.sequence, '{{sequence}}');
    assert.equal((await fetch(base + '/api/webhooks/v1/pairings/' + body.requestId, { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
    await assert.rejects(gateway.command({ action: 'approve_pairing', requestId: body.requestId, binding: binding('another-session') }), /pairing_already_handled/);
    const info = await fetch(grant.connection.endpoint, { headers: { Authorization: 'Bearer ' + grant.connection.token } });
    assert.equal((await info.json()).type, 'connection.info');
    await gateway.command({ action: 'delete', id: grant.connection.id, sessionId: 'chosen-session' });
    assert.equal((await (await poll()).json()).status, 'revoked');
    const rejected = { ...body, requestId: randomUUID() }; await post(rejected);
    await gateway.command({ action: 'reject_pairing', requestId: rejected.requestId, sessionId: 'chosen-session' });
    assert.equal((await (await fetch(base + '/api/webhooks/v1/pairings/' + rejected.requestId, { headers })).json()).status, 'rejected');
    const expired = { ...body, requestId: randomUUID() }; await post(expired);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60000 + 1 });
    assert.equal((await fetch(base + '/api/webhooks/v1/pairings/' + expired.requestId, { headers })).status, 410);
    await assert.rejects(gateway.command({ action: 'approve_pairing', requestId: expired.requestId, binding: binding('chosen-session') }), /pairing_expired/);
    assert.deepEqual((await gateway.command({ action: 'read', sessionId: 'chosen-session' })).pairings, []);
    assert.ok(!(await readFile(join(root, 'webhooks/state.json'), 'utf8')).includes(grant.connection.token));
  } finally { await gateway?.close(); await rm(root, { recursive: true, force: true }); }
});

test('late service registration and temporary port contention recover without restarting the desktop', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-discovery-recovery-'));
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  const port = occupied.address().port; let gateway;
  try {
    gateway = await new ContextWebhookHost(root, secrets, { command: async () => { throw Error('Runtime still starting'); } }, { port }).start();
    assert.equal((await gateway.command({ action: 'read', sessionId: 'existing' })).error, 'listener_failed');
    await new Promise(resolve => occupied.close(resolve));
    await until(async () => (await gateway.command({ action: 'read', sessionId: 'existing' })).listening);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + '/api/webhooks/v1/discovery')).status, 200);
    const view = await gateway.command({ action: 'read', sessionId: 'existing' });
    assert.equal(view.error, undefined); assert.deepEqual(view.pairings, []);
    const requestId = randomUUID();
    const response = await fetch(base + '/api/webhooks/v1/pairings', { method: 'POST',
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, name: 'Started after desktop' }) });
    assert.equal(response.status, 202);
    assert.equal((await gateway.command({ action: 'read', sessionId: 'existing' })).pairings[0].requestId, requestId);
  } finally { occupied.close(); await gateway?.close(); await rm(root, { recursive: true, force: true }); }
});

test('Assistant background task completion updates only its originating Webhook receipt', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-background-'));
  let release; const gate = new Promise(resolve => { release = resolve; }); let rounds = 0, gateway;
  const registry = new ToolRegistry();
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), toolRegistry: registry, provider: { async *stream(input) {
    if (input.metadata.agentRole === 'child') { await gate; yield* answer(input, 'Verified background result.'); return; }
    if (rounds++ === 0) {
      const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'delegate', nameDelta: 'subagent', argumentsDelta: JSON.stringify({ prompt: 'Check the inventory.' }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } else yield* answer(input, rounds === 2 ? 'Working in the background.' : 'The background result is ready.');
  } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  try {
    await bridge.command('runtime.create_session', { sessionId: 'personal-assistant' });
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const connection = (await gateway.command({ action: 'save', config: config(), binding: {
      ...binding('personal-assistant'), parent: { ...request('personal-assistant'), tools: registry.definitions() },
      kind: 'assistant', generation: 0, profile: assistantProfileSchema.parse({}) } })).connections[0];
    const bot = client(connection); await bot.send(message('task'));
    const initial = await until(async () => { const r = await bot.read('task'); return r.status === 'completed' && r; });
    assert.equal(initial.reply, 'Working in the background.');
    release();
    const final = await until(async () => { const r = await bot.read('task'); return r.reply.includes('The background result is ready.') && r; });
    assert.ok(final.sequence > initial.sequence); assert.ok(final.reply.startsWith(initial.reply));
    assert.equal(final.senderId, 'u-1'); assert.equal(final.conversationId, 'remote-chat');
  } finally { release(); await gateway?.close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});
