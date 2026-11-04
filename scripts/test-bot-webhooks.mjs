import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, lstat, realpath, mkdir, symlink } from 'node:fs/promises';
import { renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ContextWebhookHost } from '../dist-electron/contextWebhookHost.mjs';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { registerBotMessagingTool } from '../packages/bush-runtime/dist/botMessaging.js';
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
  if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'send', nameDelta: 'send_to_bot', argumentsDelta: JSON.stringify(call) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Ready.' };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
}
test('send_to_bot remains directly callable without a connected Bot, including an old frozen catalog', async () => {
  const calls = [], runtime = new InMemoryRuntimeHost({ sessionStore: new SessionStore(), provider: { async *stream(input) {
    calls.push(input); yield* answer(input, calls.length === 1 ? { action: 'status' } : undefined);
  } } });
  try {
    await runtime.runSessionTurn(request('unconnected'));
    assert.ok(calls[0].tools.some(t => t.name === 'send_to_bot'));
    const result = JSON.parse(calls[1].messages.find(m => m.role === 'tool').content);
    assert.equal(result.available, false); assert.equal(result.reason, 'bot_not_connected');
    assert.match(calls[0].tools.find(t => t.name === 'send_to_bot').description, /remains present/);
  } finally { await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('generic file push binds source, checks capabilities, persists idempotency and keeps tokens out of model state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bot-outbound-')), received = []; let gateway;
  let loseAcknowledgement = false;
  const receiver = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), type = req.headers['content-type'];
    const form = type.startsWith('multipart/') ? await new Response(bytes, { headers: { 'Content-Type': type } }).formData() : null;
    const payload = JSON.parse(form ? form.get('payload') : bytes.toString());
    if (payload.type !== 'message.send') { res.end('{}'); return; }
    received.push({ payload, authorization: req.headers.authorization, bytes: form ? Buffer.from(await form.get('file_0').arrayBuffer()) : undefined });
    if (loseAcknowledgement) { loseAcknowledgement = false; res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: payload.eventId, status: 'accepted' }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  const runtime = { command: async () => ({}) }, options = { port: 0, execute: async () => ({ status: 'completed', reply: 'OK' }) };
  try {
    gateway = await new ContextWebhookHost(root, cipher, runtime, options).start();
    const connect = async (name, sessionId) => {
      const saved = await gateway.command({ action: 'save', config: config(name, `http://127.0.0.1:${receiver.address().port}/reply`),
        binding: { kind: 'conversation', sessionId, title: sessionId, parent: request(sessionId) } });
      return saved.connections.find(c => c.name === name);
    };
    const a = await connect('Weixin', 'same-chat'), b = await connect('Feishu', 'same-chat');
    const post = (c, suffix, body) => fetch(c.endpoint.replace(/\/messages$/, suffix), { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const c of [a, b]) assert.equal((await post(c, '/messages', { messageId: c.name, senderId: c.name + '-user', conversationId: c.name + '-room', text: 'Forward my file.' })).status, 202);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId: 'same-chat' })).available, false);
    for (const c of [a, b]) assert.equal((await post(c, '/capabilities', { protocol: 'cardbush.webhook.v1', capabilities: { files: c === a, maxFileBytes: 1000 } })).status, 200);
    const state = await gateway.botRequest({ action: 'context', sessionId: 'same-chat' });
    assert.equal(state.targets.length, 2); assert.ok(!JSON.stringify(state).includes('callback-secret')); assert.ok(!JSON.stringify(state).includes(a.token));
    const sourceA = state.targets.find(t => t.botName === 'Weixin'), sourceB = state.targets.find(t => t.botName === 'Feishu');
    const later = Date.now() + 120001, clock = t.mock.method(Date, 'now', () => later);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId: 'same-chat', sourceRef: sourceA.sourceRef })).source.reason, 'bot_offline');
    clock.mock.restore();
    const file = join(root, 'real-file.txt'), bytes = Buffer.from('实际文件内容\n'); await writeFile(file, bytes);
    const send = async (source, requestId, extra = {}, sessionId = 'same-chat') => {
      const path = await realpath(file), info = await lstat(path, { bigint: true });
      return gateway.botRequest({ action: 'send', sessionId, files: [{ path, identity: `${info.dev}:${info.ino}` }],
        input: { source_ref: source.sourceRef, request_id: requestId, files: [path], ...extra } });
    };
    assert.equal((await send(sourceB, 'unsupported')).code, 'bot_files_unsupported');
    assert.equal((await send(sourceA, 'foreign', {}, 'another-chat')).code, 'source_unavailable');
    const delivered = await send(sourceA, 'file-1'); assert.equal(delivered.status, 'accepted'); assert.equal(delivered.deliveryConfirmed, false);
    assert.deepEqual(received[0].bytes, bytes); assert.equal(received[0].payload.senderId, 'Weixin-user');
    assert.equal(received[0].payload.messageId, 'Weixin'); assert.equal(received[0].authorization, 'Bearer callback-secret');
    assert.equal((await send(sourceA, 'file-1')).eventId, delivered.eventId); assert.equal(received.length, 1);
    assert.equal((await send(sourceA, 'file-1', { text: 'changed' })).code, 'request_id_conflict');
    await writeFile(file, Buffer.alloc(1001)); assert.equal((await send(sourceA, 'too-large')).code, 'file_too_large');
    const oldPath = await realpath(file), oldIdentity = await lstat(oldPath, { bigint: true });
    renameSync(file, file + '.previous'); await writeFile(file, 'replacement');
    assert.equal((await gateway.botRequest({ action: 'send', sessionId: 'same-chat', files: [{ path: oldPath, identity: `${oldIdentity.dev}:${oldIdentity.ino}` }],
      input: { source_ref: sourceA.sourceRef, request_id: 'replaced-file', files: [oldPath] } })).code, 'workspace_authorization_changed');
    assert.equal(received.length, 1, 'a replaced file must not reach the callback');
    await rm(file); renameSync(file + '.previous', file);
    await writeFile(file, bytes); loseAcknowledgement = true;
    const unknown = await send(sourceA, 'retry-same'); assert.equal(unknown.status, 'unknown');
    assert.equal((await send(sourceA, 'retry-same')).status, 'accepted');
    assert.equal(received.at(-1).payload.eventId, received.at(-2).payload.eventId, 'uncertain retries use the same external event ID');
    await gateway.close(); gateway = await new ContextWebhookHost(root, cipher, runtime, options).start();
    assert.equal((await send(sourceA, 'file-1')).eventId, delivered.eventId); assert.equal(received.length, 3);
    await gateway.command({ action: 'delete', sessionId: 'same-chat', id: a.id });
    assert.equal((await send(sourceA, 'revoked')).status, 'unavailable'); assert.equal(received.length, 3);
  } finally { await gateway?.close(); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

for (const kind of ['conversation', 'assistant']) test(`${kind}: real model tool dispatch sends the requested file using per-message Bot provenance`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-runtime-')), sent = [], calls = []; let gateway;
  const file = join(root, 'report.txt'); await writeFile(file, 'report fixture');
  const sessionId = kind === 'assistant' ? 'personal-assistant' : 'conversation';
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
    send: (sessionId, input, signal, files) => gateway.botRequest({ action: 'send', sessionId, input, files }, signal),
  }, provider: { async *stream(input) {
    calls.push(input);
    const state = JSON.parse(input.messages.filter(m => m.name === 'bot_context').at(-1).content.split('\n').at(-1));
    assert.equal(state.source.botName, 'Selected Bot'); assert.equal(state.source.senderId, 'original-user');
    assert.equal(state.source.available, true);
    yield* answer(input, input.messages.some(m => m.role === 'tool' && m.toolCallId === 'send') ? undefined
      : { source_ref: state.source.sourceRef, request_id: 'report-once', files: [file] });
  } } });
  const bridge = { command: (name, payload) => runtime.sendCommand({ kind: name, payload }) };
  try {
    await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, cipher, bridge, { port: 0 }).start();
    const saved = await gateway.command({ action: 'save', config: config('Selected Bot', `http://127.0.0.1:${receiver.address().port}/reply`),
      binding: { kind, sessionId, title: 'Context', parent: request(sessionId), ...(kind === 'assistant' ? { profile: assistantProfileSchema.parse({}), generation: 0 } : {}) } });
    const connection = saved.connections[0], headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    await fetch(connection.endpoint.replace(/\/messages$/, '/capabilities'), { method: 'POST', headers, body: JSON.stringify({ protocol: 'cardbush.webhook.v1', capabilities: { files: true } }) });
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify({ messageId: 'requested-file', senderId: 'original-user', conversationId: 'original-room', text: 'Send the report.' }) })).status, 202);
    let result;
    for (let i = 0; i < 150; i++) {
      result = await (await fetch(connection.endpoint + '/requested-file', { headers })).json();
      if (['completed', 'failed'].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(sent.length, 1); assert.equal(sent[0].messageId, 'requested-file'); assert.equal(sent[0].senderId, 'original-user');
    assert.ok(calls[0].tools.some(tool => tool.name === 'send_to_bot'), 'old bindings still expose the permanent tool');
    assert.equal(JSON.parse(calls.at(-1).messages.find(m => m.role === 'tool' && m.toolCallId === 'send').content).status, 'accepted');
    assert.ok(!JSON.stringify(calls).includes(connection.token)); assert.ok(!JSON.stringify(calls).includes('callback-secret'));
    if (kind === 'assistant') {
      const state = await gateway.botRequest({ action: 'context', sessionId });
      await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
      const refused = await gateway.botRequest({ action: 'send', sessionId, input: { source_ref: state.targets[0].sourceRef, request_id: 'after-reset', text: 'Do not send.' } });
      assert.equal(refused.code, 'context_reset'); assert.equal(sent.length, 1);
    }
  } finally { await gateway?.close(); await bridge.command('runtime.shutdown', {}); receiver.closeAllConnections(); await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('Assistant background completion retains Bot A after a newer message from Bot B', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-background-')), journal = new ConversationJournal(root), delegated = [], calls = [];
  const sessionId = 'personal-assistant';
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    botContext: async sourceRef => ({ tool: 'send_to_bot', available: true, targets: [], source: { sourceRef } }),
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
    assert.match(calls.at(-1).messages.filter(m => m.name === 'bot_context').at(-1).content, /webhook:bot-a/);
    assert.equal(new ConversationJournal(root).read(sessionId).find(entry => entry.id === 'user-a').botSourceRef, 'webhook:bot-a');
  } finally { assistant.close(); await rm(root, { recursive: true, force: true }); }
});

test('file forwarding enforces filesystem permission and rejects a redirected path after admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bot-admission-')), work = join(root, 'work'), outside = join(root, 'outside'), safe = join(work, 'safe');
  await mkdir(safe, { recursive: true }); await mkdir(outside);
  await writeFile(join(safe, 'file.txt'), 'safe'); await writeFile(join(outside, 'file.txt'), 'outside');
  const link = join(work, 'link'); await symlink(safe, link, process.platform === 'win32' ? 'junction' : 'dir');
  let sends = 0, prompts = 0, redirect = false;
  const registry = new ToolRegistry();
  registerBotMessagingTool(registry, { context: async () => ({ source: { available: true, capabilities: botCapabilitiesSchema.parse({ files: true }) } }),
    send: async () => { sends++; } }, id => id);
  const coordinator = new ToolExecutionCoordinator({ registry,
    observer: { running: () => { if (redirect) { renameSync(link, join(work, 'old')); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); } } },
    permissions: { request: async () => { prompts++; return { decision: 'deny', grantedCapabilityIds: [] }; } } });
  const run = file => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'send-' + prompts, name: 'send_to_bot',
    argumentsText: JSON.stringify({ source_ref: 'webhook:a', request_id: 'forward', files: [file] }) },
    { requestId: 'r', sessionId: 's', turnId: 't', ordinal: prompts + 1, round: 1 }, undefined,
    { request: { ...request('s'), messages: [], tools: registry.definitions(), permissionMode: 'task_free', metadata: { workspaceDir: work } }, contextMessages: [] });
  try {
    assert.equal((await run(join(outside, 'file.txt'))).error.code, 'permission_rejected'); assert.equal(prompts, 1); assert.equal(sends, 0);
    redirect = true;
    assert.equal((await run(join(link, 'file.txt'))).error.code, 'workspace_authorization_changed'); assert.equal(sends, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
