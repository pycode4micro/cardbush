import test from 'node:test';
import { fixturePlugin, bridgeModelStep, bridgeMessageSource } from './helpers/bridge-plugin-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, lstat, realpath, mkdir, symlink } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ContextWebhookHost } from '../dist-electron/contextWebhookHost.mjs';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { BridgePluginTools } from '../packages/bush-runtime/dist/botMessaging.js';
import { ConversationJournal } from '../packages/bush-runtime/dist/conversationJournal.js';
import { AssistantConversation } from '../packages/bush-runtime/dist/assistantConversation.js';
import { assistantProfileSchema, botCapabilitiesSchema } from '../packages/bush-protocol/dist/index.js';

const cipher = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
const request = (sessionId, turnId = 'input') => ({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId, turnId,
  model: 'fixture', tools: [], prefixMessages: [], inputMessages: [{ messageId: turnId, message: { role: 'user', content: 'Send the requested file.' } }], metadata: {}, permissionMode: 'all_free' });
const config = (name, url) => ({ name, enabled: true, url, headers: { Authorization: 'Bearer callback-secret' }, parameters: {},
  body: { protocol: '{{protocol}}', type: '{{type}}', reply: '{{reply}}' }, incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } });
const until = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
async function* answer(input, call) {
  const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.arguments) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Ready.' };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
}
test('retired send_to_bot is absent without a bridge and cannot return through an old saved binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-empty-'));
  const calls = [], runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), provider: { async *stream(input) {
    calls.push(input); yield* answer(input);
  } } });
  try {
    await runtime.runSessionTurn({ ...request('unconnected'), tools: [{ name: 'send_to_bot', description: 'Legacy tool', inputSchema: { type: 'object' } }] });
    assert.ok(!calls[0].tools.some(t => t.name === 'send_to_bot'));
    assert.ok(!(await runtime.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} })).some(t => t.name === 'send_to_bot'));
  } finally { await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});

test('generic file push binds source, checks capabilities, persists idempotency and keeps tokens out of model state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bot-outbound-')), received = []; let gateway;
  let loseAcknowledgement = false;
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), type = req.headers['content-type'];
    const form = type.startsWith('multipart/') ? await new Response(bytes, { headers: { 'Content-Type': type } }).formData() : null;
    const payload = JSON.parse(form ? form.get('payload') : bytes.toString());
    if (payload.type !== 'tool.call') { res.end('{}'); return; }
    received.push({ payload, authorization: req.headers.authorization, bytes: form ? Buffer.from(await form.get('file_0').arrayBuffer()) : undefined });
    if (loseAcknowledgement) { loseAcknowledgement = false; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: payload.eventId, status: 'accepted' }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const runtime = { command: async () => ({ generation: 0 }) }, options = { port: 0, execute: async () => ({ status: 'completed', reply: 'OK' }) };
  try {
    gateway = await new ContextWebhookHost(root, cipher, runtime, options).start();
    const connect = async (name, sessionId) => {
      const saved = await gateway.command({ action: 'save', config: config(name, `http://127.0.0.1:${receiver.address().port}/reply`),
        binding: { kind: 'assistant', profile:{name:'Assistant'},generation:0,sessionId, title: sessionId, parent: request(sessionId) } });
      return saved.connections.find(c => c.name === name);
    };
    const a = await connect('Weixin', 'personal-assistant'), b = await connect('Feishu', 'personal-assistant');
    const statuses = async () => (await gateway.command({ action: 'read', sessionId: 'personal-assistant' })).connections.map(c => c.status);
    assert.deepEqual(await statuses(), ['offline', 'offline'], 'saved and enabled is not online');
    const discover = sessionId => gateway.command({ action: 'read', sessionId });
    await assert.rejects(discover('another-chat'),/assistant_only/);
    const savedContext = await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant' });
    assert.equal(savedContext.reason, 'bot_offline');
    assert.deepEqual(savedContext.connections.map(c => c.status), ['offline', 'offline']);
    const post = (c, suffix, body) => fetch(c.endpoint.replace(/\/messages$/, suffix), { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const c of [a, b]) assert.equal((await post(c, '/messages', { messageId: c.name, senderId: c.name + '-user', conversationId: c.name + '-room', text: 'Forward my file.' })).status, 202);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant' })).available, false);
    for (const c of [a, b]) assert.equal((await post(c, '/capabilities', { protocol: 'cardbush.webhook.v1', capabilities: { files: c === a, maxFileBytes: 1000 }, plugins: [fixturePlugin] })).status, 200);
    const state = await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant' });
    assert.deepEqual(await statuses(), ['connected', 'connected']);
    await assert.rejects(discover('another-chat'),/assistant_only/);
    assert.deepEqual((await discover('personal-assistant')).onlineElsewhere, []);
    assert.equal(state.targets.length, 2); assert.ok(!JSON.stringify(state).includes('callback-secret')); assert.ok(!JSON.stringify(state).includes(a.token));
    const sourceA = state.targets.find(t => t.botName === 'Weixin'), sourceB = state.targets.find(t => t.botName === 'Feishu');
    const catalog = await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' });
    assert.equal(catalog.length, 2);
    assert.deepEqual(await gateway.botRequest({ action: 'catalog', sessionId: 'another-chat' }), []);
    const callInput = (source, requestId, file, extra = {}) => ({ connectionId: source.connectionId, pluginId: 'fixture',
      revision: catalog.find(entry => entry.connectionId === source.connectionId).revision, tool: 'send_file', sourceRef: source.sourceRef,
      requestId, arguments: { file, ...extra } });
    const later = Date.now() + 120001, clock = t.mock.method(Date, 'now', () => later);
    assert.deepEqual(await statuses(), ['offline', 'offline'], 'UI and model use the same heartbeat expiry');
    await assert.rejects(discover('another-chat'),/assistant_only/);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant', sourceRef: sourceA.sourceRef })).source.reason, 'bot_offline');
    assert.deepEqual(await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' }), []);
    clock.mock.restore();
    const file = join(root, 'real-file.txt'), bytes = Buffer.from('实际文件内容\n'); await writeFile(file, bytes);
    const send = async (source, requestId, extra = {}, sessionId = 'personal-assistant') => {
      const path = await realpath(file), info = await lstat(path, { bigint: true });
      return gateway.botRequest({ action: 'call', sessionId, files: [{ path, identity: `${info.dev}:${info.ino}` }], input: callInput(source, requestId, path, extra) });
    };
    assert.equal((await send(sourceB, 'unsupported')).code, 'bot_files_unsupported');
    assert.equal((await send(sourceA, 'foreign', {}, 'another-chat')).code, 'bridge_source_unavailable');
    const delivered = await send(sourceA, 'file-1'); assert.equal(delivered.status, 'accepted'); assert.equal(delivered.deliveryConfirmed, false);
    assert.deepEqual(received[0].bytes, bytes); assert.equal(received[0].payload.senderId, 'Weixin-user');
    assert.deepEqual(received[0].payload.arguments, { file: { part: 'file_0' } }, 'the bridge never receives a local file path');
    assert.deepEqual(received[0].payload.parameters, {}, 'connection parameters remain available to generic bridge handlers');
    assert.equal((await gateway.botRequest({ action: 'call', sessionId: 'personal-assistant', input: { ...callInput(sourceA, 'wrong-platform', file), connectionId: b.id } })).code, 'bridge_source_unavailable');
    assert.equal(received[0].payload.messageId, 'Weixin'); assert.equal(received[0].authorization, 'Bearer callback-secret');
    assert.equal((await send(sourceA, 'file-1')).eventId, delivered.eventId); assert.equal(received.length, 1);
    assert.equal((await send(sourceA, 'file-1', { text: 'changed' })).code, 'request_id_conflict');
    await writeFile(file, Buffer.alloc(1001)); assert.equal((await send(sourceA, 'too-large')).code, 'file_too_large');
    const oldPath = await realpath(file), oldIdentity = await lstat(oldPath, { bigint: true });
    renameSync(file, file + '.previous'); await writeFile(file, 'replacement');
    assert.equal((await gateway.botRequest({ action: 'call', sessionId: 'personal-assistant', files: [{ path: oldPath, identity: `${oldIdentity.dev}:${oldIdentity.ino}` }],
      input: callInput(sourceA, 'replaced-file', oldPath) })).code, 'workspace_authorization_changed');
    assert.equal(received.length, 1, 'a replaced file must not reach the callback');
    await rm(file); renameSync(file + '.previous', file);
    await writeFile(file, bytes); loseAcknowledgement = true;
    const unknown = await send(sourceA, 'retry-same'); assert.equal(unknown.status, 'unknown');
    assert.equal((await send(sourceA, 'retry-same')).status, 'accepted');
    assert.equal(received.at(-1).payload.eventId, received.at(-2).payload.eventId, 'uncertain retries use the same external event ID');
    await gateway.close(); gateway = await new ContextWebhookHost(root, cipher, runtime, options).start();
    a.endpoint = (await gateway.command({ action: 'read', sessionId: 'personal-assistant' })).connections.find(c => c.id === a.id).endpoint;
    assert.deepEqual(await statuses(), ['offline', 'offline']);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId: 'personal-assistant', sourceRef: sourceA.sourceRef })).source.reason, 'bot_offline');
    assert.deepEqual(await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' }), [], 'restart requires a fresh bridge heartbeat');
    const instanceId = '11111111-1111-4111-8111-111111111111';
    await post(a, '/capabilities', { protocol: 'cardbush.webhook.v1', instanceId, capabilities: { files: true, maxFileBytes: 1000 }, plugins: [fixturePlugin] });
    assert.equal((await send(sourceA, 'file-1')).eventId, delivered.eventId); assert.equal(received.length, 3);
    const withdraw = id => fetch(a.endpoint.replace(/\/messages$/, '/capabilities'), { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 'cardbush.webhook.v1', instanceId: id }) });
    await withdraw('22222222-2222-4222-8222-222222222222');
    assert.equal((await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' })).length, 1, 'an old process cannot revoke a newer bridge lease');
    await withdraw(instanceId);
    assert.deepEqual(await statuses(), ['offline', 'offline'], 'graceful exit keeps configuration but withdraws live connection');
    assert.deepEqual(await gateway.botRequest({ action: 'catalog', sessionId: 'personal-assistant' }), []);
    assert.equal((await send(sourceA, 'after-close')).code, 'bridge_source_unavailable');
    await gateway.command({ action: 'save', config: { ...config('Feishu', b.url), id: b.id, enabled: false },
      binding: { kind:'assistant',profile:{name:'Assistant'},generation:0,sessionId:'personal-assistant', title: 'personal-assistant', parent: request('personal-assistant') } });
    assert.deepEqual(await statuses(), ['offline', 'disabled']);
    await gateway.command({ action: 'delete', sessionId: 'personal-assistant', id: a.id });
    assert.equal((await send(sourceA, 'revoked')).code, 'bridge_source_unavailable'); assert.equal(received.length, 3);
  } finally { await gateway?.close(); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test(`Assistant: real model tool dispatch sends the requested file using per-message Bot provenance`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-runtime-')), sent = [], calls = []; let gateway;
  const file = join(root, 'report.txt'); await writeFile(file, 'report fixture');
  const sessionId = 'personal-assistant';
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (!(req.headers['content-type'] ?? '').startsWith('multipart/')) { res.end('{}'); return; }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
    const payload = JSON.parse(form.get('payload')); sent.push(payload);
    res.end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: payload.eventId, status: 'accepted' }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), botMessaging: {
    context: (sessionId, sourceRef, signal) => gateway.botRequest({ action: 'context', sessionId, sourceRef }, signal),
    catalog: (sessionId, signal) => gateway.botRequest({ action: 'catalog', sessionId }, signal),
    call: (sessionId, input, signal, files) => gateway.botRequest({ action: 'call', sessionId, input, files }, signal),
  }, provider: { async *stream(input) {
    calls.push(input);
    assert.equal(input.permissionMode, 'all_free');
    assert.equal(input.requestCapabilities.interactiveRequests, false);
    const source = bridgeMessageSource(input.messages);
    assert.equal(source.botName, 'Selected Bot'); assert.equal(source.senderId, 'original-user');
    assert.equal(source.available, true);
    if (input.sessionId === sessionId && input.metadata.agentRole !== 'child') {
      yield* answer(input, input.messages.some(m => m.role === 'tool' && m.toolCallId === 'delegate-file') ? undefined
        : { id: 'delegate-file', name: 'subagent', arguments: { prompt: 'Send the requested report file through the current source bridge plugin.' } });
    } else yield* answer(input, bridgeModelStep(input.messages, file));
  } } });
  const bridge = { command: (name, payload) => runtime.sendCommand({ kind: name, payload }) };
  try {
    await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, cipher, bridge, { port: 0 }).start();
    const definitions = await bridge.command('runtime.get_tool_catalog', {});
    const saved = await gateway.command({ action: 'save', config: config('Selected Bot', `http://127.0.0.1:${receiver.address().port}/reply`),
      binding: { kind: 'assistant', sessionId, title: 'Context', parent: { ...request(sessionId), tools: definitions, metadata: { mcpCatalogUpdates: 'additions' } }, profile: assistantProfileSchema.parse({}), generation: 0 } });
    const connection = saved.connections[0], headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    await fetch(connection.endpoint.replace(/\/messages$/, '/capabilities'), { method: 'POST', headers, body: JSON.stringify({ protocol: 'cardbush.webhook.v1', capabilities: { files: true }, plugins: [fixturePlugin] }) });
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify({ messageId: 'requested-file', senderId: 'original-user', conversationId: 'original-room', text: 'Send the report.' }) })).status, 202);
    let result;
    for (let i = 0; i < 150; i++) {
      result = await (await fetch(connection.endpoint + '/requested-file', { headers })).json();
      if (['completed', 'failed'].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    await until(() => sent.length === 1);
    assert.equal(sent.length, 1); assert.equal(sent[0].messageId, 'requested-file'); assert.equal(sent[0].senderId, 'original-user');
    assert.ok(calls.every(call => !call.tools.some(tool => tool.name === 'send_to_bot')), 'no permanent forwarding tool');
    assert.ok(JSON.stringify(calls).includes('bridge-schema-call'), 'schema discovery precedes execution');
    assert.ok(!JSON.stringify(calls).includes(connection.token)); assert.ok(!JSON.stringify(calls).includes('callback-secret'));
    const state = await gateway.botRequest({ action: 'context', sessionId });
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
    const declaration = (await gateway.botRequest({ action: 'catalog', sessionId }))[0];
    const refused = await gateway.botRequest({ action: 'call', sessionId, input: { connectionId: declaration.connectionId, pluginId: 'fixture',
      revision: declaration.revision, tool: 'send_file', sourceRef: state.targets[0].sourceRef, requestId: 'after-reset', arguments: { file } } });
    assert.equal(refused.code, 'context_reset'); assert.equal(sent.length, 1);
  } finally { await gateway?.close(); await bridge.command('runtime.shutdown', {}); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('Assistant background completion retains Bot A after a newer message from Bot B', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-background-')), journal = new ConversationJournal(root), delegated = [], calls = [];
  const sessionId = 'personal-assistant';
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    botContext: async sourceRef => ({ discovery: 'mcp_search', available: true, targets: [], source: { sourceRef } }),
    delegate: async input => { delegated.push(input); return { taskId: 'continued', status: 'running' }; },
    provider: { async *stream(input) {
      calls.push(input);
      const background = input.messages.some(m => m.name === 'background_task_result');
      if (!background || input.messages.some(m => m.role === 'tool' && m.toolCallId === 'resume')) { yield* answer(input); return; }
      const base = { protocol: 'bush.model_event.v1', requestId: input.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'resume', nameDelta: 'subagent', argumentsDelta: JSON.stringify({ prompt: 'Finish the report for its original sender.' }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } } });
  const submit = async (id, botSourceRef, extra = {}) => {
    assistant.command({ action: 'turn', sessionId, profile: assistantProfileSchema.parse({}),
      parent: { ...request(sessionId, id), metadata: { botSourceRef: 'webhook:bot-b' } },
      entry: { id, role: 'user', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString(), content: id, ...(botSourceRef ? { botSourceRef } : {}), ...extra } });
    await until(() => !assistant.command({ action: 'read', sessionId }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId }).error, '');
  };
  try {
    await submit('user-a', 'webhook:bot-a'); await submit('user-b', 'webhook:bot-b');
    await submit('finished-a', undefined, { source: 'task', visibility: 'internal', responseTo: ['user-a'] });
    assert.equal(delegated.length, 1); assert.equal(delegated[0].parent.metadata.botSourceRef, 'webhook:bot-a');
    assert.deepEqual(delegated[0].parent.inputMessages.map(item => item.messageId), ['user-a', 'finished-a']);
    assert.deepEqual(JSON.parse(delegated[0].parent.inputMessages[0].message.content).laterUserMessages, []);
    assert.deepEqual(delegated[0].parent.metadata.assistantEventEvidence, [{ id: 'user-a', sourceRef: 'webhook:bot-a' }]);
    assert.match(calls.at(-1).messages.filter(m => m.name === 'bot_context').at(-1).content, /webhook:bot-a/);
    assert.equal(new ConversationJournal(root).read(sessionId).find(entry => entry.id === 'user-a').botSourceRef, 'webhook:bot-a');
  } finally { assistant.close(); await rm(root, { recursive: true, force: true }); }
});

test('Assistant identifies local input after webhook history and refreshes live state on retry and subsequent rounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-assistant-current-')), journal = new ConversationJournal(root), calls = [];
  const sessionId = 'personal-assistant', ref = 'webhook:previous-message';
  let online = true, disconnectDuringRound = false;
  const source = { sourceRef: ref, connectionId: 'bot', botName: 'Saved Bot', messageId: 'previous-message', senderId: 'user',
    conversationId: 'room', receivedAt: new Date().toISOString(), capabilities: botCapabilitiesSchema.parse({}) };
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}), delegate: async () => ({}),
    botContext: async sourceRef => ({ discovery: 'mcp_search', available: online, ...(!online ? { reason: 'bot_offline' } : {}),
      connections: [{ connectionId: 'bot', botName: 'Saved Bot', status: online ? 'connected' : 'offline' }],
      targets: online ? [{ ...source, available: true }] : [], ...(sourceRef ? { source: { ...source, available: online } } : {}) }),
    provider: { async *stream(input) {
      calls.push(input);
      if (disconnectDuringRound) {
        disconnectDuringRound = false; online = false;
        yield* answer(input, { id: 'inspect-tasks', name: 'tasks', arguments: { action: 'list' } });
      } else yield* answer(input);
    } } });
  const latest = () => JSON.parse(calls.at(-1).messages.filter(m => m.name === 'bot_context').at(-1).content.split('\n').at(-1));
  const settled = async () => { await until(() => !assistant.command({ action: 'read', sessionId }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId }).error, ''); };
  const parent = { ...request(sessionId), permissionMode: 'task_free', metadata: { botSourceRef: ref } }, profile = assistantProfileSchema.parse({});
  try {
    assistant.command({ action: 'turn', sessionId, parent, profile, entry: { id: 'old-webhook', role: 'user', source: 'text',
      visibility: 'conversation', createdAt: new Date().toISOString(), content: 'Hello from the bot.', botSourceRef: ref } });
    await settled(); assert.equal(latest().messageSource.kind, 'webhook'); assert.equal(latest().available, true);
    assert.equal(calls.at(-1).permissionMode, 'all_free');
    online = false;
    assistant.command({ action: 'retry', sessionId, parent, profile }); await settled();
    assert.equal(latest().messageSource.sourceRef, ref); assert.equal(latest().available, false, 'retry must refresh consumed input');
    assert.equal(calls.at(-1).permissionMode, 'all_free');
    assistant.command({ action: 'turn', sessionId, parent, profile, entry: { id: 'local-question', role: 'user', source: 'text',
      visibility: 'conversation', createdAt: new Date().toISOString(), content: 'Is my webhook connected?' } });
    await settled();
    assert.deepEqual(latest().messageSource, { kind: 'local' }); assert.equal(latest().source, undefined);
    assert.equal(latest().connections[0].status, 'offline');
    assert.equal(calls.at(-1).metadata.botSourceRef, undefined); assert.deepEqual(calls.at(-1).metadata.botSourceRefs, []);
    assert.equal(calls.at(-1).permissionMode, 'task_free', 'a later local message keeps local permissions');
    assert.ok(!calls.at(-1).messages[0].content.includes('question in your final reply'));
    online = true; disconnectDuringRound = true;
    const before = calls.length;
    assistant.command({ action: 'retry', sessionId, parent, profile }); await settled();
    assert.equal(calls.length, before + 2); assert.equal(latest().connections[0].status, 'offline');
    assert.deepEqual(latest().messageSource, { kind: 'local' });
    const first = JSON.parse(calls[before].messages.filter(m => m.name === 'bot_context').at(-1).content.split('\n').at(-1));
    assert.equal(first.available, true); assert.equal(first.targets[0].sourceRef, ref);
    assert.deepEqual(first.messageSource, { kind: 'local' }, 'an available previous recipient does not identify current input');
    assert.equal(journal.read(sessionId).filter(e => e.id === 'local-question').length, 1);
    assert.equal(journal.read(sessionId).find(e => e.id === 'old-webhook').botSourceRef, ref);
  } finally { assistant.close(); await rm(root, { recursive: true, force: true }); }
});

test('file forwarding enforces filesystem permission and rejects a redirected path after admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-admission-')), work = join(root, 'work'), outside = join(root, 'outside'), safe = join(work, 'safe');
  await mkdir(safe, { recursive: true }); await mkdir(outside);
  await writeFile(join(safe, 'file.txt'), 'safe'); await writeFile(join(outside, 'file.txt'), 'outside');
  const link = join(work, 'link'); await symlink(safe, link, process.platform === 'win32' ? 'junction' : 'dir');
  let sends = 0, prompts = 0, redirect = false;
  const registry = new ToolRegistry();
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const plugins = new BridgePluginTools(registry, {
    catalog: async () => [{ connectionId, sessionId: 's', expiresAt: Date.now() + 60000, revision: 'a'.repeat(64), plugin: fixturePlugin }],
    context: async () => ({ targets: [], source: { sourceRef: 'webhook:a', connectionId, available: true, capabilities: botCapabilitiesSchema.parse({ files: true }) } }),
    call: async () => { sends++; } }, id => id);
  await plugins.sync('s'); const toolName = registry.definitions()[0].name;
  const coordinator = new ToolExecutionCoordinator({ registry,
    observer: { running: () => { if (redirect) { renameSync(link, join(work, 'old')); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } } },
    permissions: { request: async () => { prompts++; return { decision: 'deny', grantedCapabilityIds: [] }; } } });
  const run = file => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'send-' + prompts, name: toolName,
    argumentsText: JSON.stringify({ source_ref: 'webhook:a', request_id: 'forward', file }) },
    { requestId: 'r', sessionId: 's', turnId: 't', ordinal: prompts + 1, round: 1 }, undefined,
    { request: { ...request('s'), messages: [], tools: registry.definitions(), permissionMode: 'task_free', metadata: { workspaceDir: work } }, contextMessages: [] });
  try {
    assert.equal((await run(join(outside, 'file.txt'))).error.code, 'permission_rejected'); assert.equal(prompts, 1); assert.equal(sends, 0);
    redirect = true;
    assert.equal((await run(join(link, 'file.txt'))).error.code, 'workspace_authorization_changed'); assert.equal(sends, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
