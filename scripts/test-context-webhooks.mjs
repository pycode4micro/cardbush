import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, Agent } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { InMemoryRuntimeHost, InMemoryRuntimeEventLog, SessionStore, ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { applyWebhookTurnPolicy, assistantProfileSchema, FRIENDS_COMMAND, FRIENDS_SESSION } from '@cardbush/bush-protocol';
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

test('Assistant adopts saved Friends bindings and events; isolated notices keep the originating account across conversations and disconnect', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'friends-bridge-')), received = [], requests = [], turns = new Map();
  const receiver = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: body.eventId, status: 'accepted' }));
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  let gateway;
  const sessionId = FRIENDS_SESSION, registry = new ToolRegistry();
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, sessionStore: new SessionStore(), botMessaging: {
    context: (sessionId, sourceRef, signal) => gateway.botRequest({ action: 'context', sessionId, sourceRef }, signal),
    catalog: (sessionId, signal) => gateway.botRequest({ action: 'catalog', sessionId }, signal),
    call: (sessionId, input, signal, files) => gateway.botRequest({ action: 'call', sessionId, input, files }, signal),
  }, provider: { async *stream(req) {
    if (req.sessionId === 'personal-assistant') {
      const alreadyHandled = turns.has(req.turnId); turns.set(req.turnId, 1); requests.push(req);
      const latest = req.messages.filter(m => m.role === 'user' && !m.name).at(-1)?.content;
      const final = latest === 'Schedule my update.' ? 'Which detail?' : 'Recorded.';
      if (alreadyHandled || !['Schedule my update.', 'Confirmed detail.'].includes(latest)) { yield* answer(req, final); return; }
      const original = (await friends({ action: 'read' })).events.find(e => e.intent === 'Schedule my update.');
      const args = latest === 'Schedule my update.' ? { action: 'create', text: latest } : { action: 'continue', eventId: original.id, text: latest };
      const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: randomUUID(), nameDelta: 'assistant_event', argumentsDelta: JSON.stringify(args) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' }; return;
    }
    const { event, signals } = JSON.parse(req.messages.find(m => m.name === 'friends_event_data').content);
    const round = (turns.get(req.turnId) ?? 0) + 1; turns.set(req.turnId, round); requests.push(req);
    const decision = disposition => ['friends_decide', { disposition, basis: 'Fixture evidence.', habitRefs: [] }];
    let call, final = 'Recorded.';
    if (event.intent === 'Schedule my update.' && event.inputs.length === 1) {
      if (round === 1) call = ['friends_create_event', { logicalKey: 'notification', title: 'Requested notice', intent: 'Notify the original recipient.' }];
      if (round === 2) {
        const child = (await friends({ action: 'read' })).events.find(e => e.logicalKey === 'notification');
        call = ['friends_watch_time', { eventId: child.id, at: new Date(Date.now() + 2500).toISOString() }];
      }
      if (round === 3) call = decision('waiting_user');
      final = 'Which detail?';
    } else if (signals.some(s => s.kind === 'clock') || event.id === 'local-notice') {
      const observations = req.messages.flatMap(m => m.content.split('\n').flatMap(line => {
        try { return JSON.parse(line).sections?.services?.bots ?? []; } catch { return []; }
      }));
      const context = observations.at(-1).context, source = context.source ?? context.targets[0];
      const name = source.plugins[0].tools[0];
      if (round === 1) call = ['mcp_search', { query: name }];
      if (round === 2) call = ['get_tool_schema', { name }];
      if (round === 3) call = ['call_tool', { name, arguments: { text: event.id === 'local-notice' ? 'From desktop.' : 'Your scheduled notice.' } }];
      if (round === 4) call = decision('completed');
    } else if (round === 1) call = decision('completed');
    if (!call) { yield* answer(req, final); return; }
    const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `call-${req.turnId}-${round}`, nameDelta: call[0], argumentsDelta: JSON.stringify(call[1]) };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
  } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  const friends = payload => bridge.command(FRIENDS_COMMAND, payload);
  try {
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    await bridge.command('runtime.create_session', { sessionId });
    const parent = { ...request(sessionId), tools: await bridge.command('runtime.get_tool_catalog', {}), requestCapabilities: { vision: false, interactiveRequests: true } };
    await friends({ action: 'configure', parent, profile: { name: 'Fixture', language: 'en', timeZone: 'UTC', recognition: {}, confirmedAt: new Date().toISOString() } });
    await until(async () => (await friends({ action: 'read' })).events[0]?.status === 'completed');
    assert.match(JSON.stringify(requests[0].messages), /bot_not_connected/);
    const selected = { kind: 'friends', sessionId, title: 'Friends' };
    const cfg = config({ name: 'Weixin fixture', url: `http://127.0.0.1:${receiver.address().port}/reply`,
      body: { eventId: '{{eventId}}', id: '{{messageId}}', text: '{{reply}}', sender: '{{senderId}}', room: '{{conversationId}}' } });
    await assert.rejects(gateway.command({ action: 'save', binding: { ...selected, kind: 'conversation', parent }, config: cfg }));
    const [connection] = (await gateway.command({ action: 'save', binding: selected, config: cfg })).connections;
    await bridge.command('runtime.create_session', { sessionId: 'personal-assistant' });
    const assistant = assistantProfileSchema.parse({ name: 'Unified assistant', proactive: { recognition: { context: 'Fixture daily routine' },
      beforeExecution: 'within-scope', report: 'always', confirmedAt: new Date().toISOString() } });
    const before = (await friends({ action: 'read' })).events;
    await friends({ action: 'configure', assistant, parent: { ...parent, sessionId: 'personal-assistant' },
      profile: { name: assistant.name, recognition: assistant.proactive.recognition, confirmedAt: assistant.proactive.confirmedAt,
        timeZone: 'UTC', language: 'en', interactionPreferences: { beforeExecution: 'within-scope', report: 'always' } } });
    assert.deepEqual((await friends({ action: 'read' })).events, before);
    assert.equal((await gateway.command({ action: 'read', sessionId: 'personal-assistant' })).connections[0].id, connection.id);
    const bot = client(connection), instanceId = randomUUID(), leaseUrl = connection.endpoint.replace(/\/messages$/, '/capabilities');
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' };
    const plugin = { id: 'fixture', version: '1', name: 'Messaging fixture', description: 'Notification transport', tools: [
      { name: 'send_text', description: 'Send text to the originating recipient.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    assert.equal((await fetch(leaseUrl, { method: 'POST', headers, body: JSON.stringify({ protocol: 'cardbush.webhook.v1', capabilities: { text: true }, plugins: [plugin], instanceId }) })).status, 200);
    assert.equal((await gateway.botRequest({ action: 'context', sessionId })).reason, 'bot_recipient_unavailable');
    const push = async (messageId, text, senderId, transport = bot) => {
      const body = { messageId, text, senderId, conversationId: 'shared-room' };
      assert.equal((await transport.send(body)).status, 202);
      return until(async () => { const value = await transport.read(messageId); assert.ok(!['failed', 'interrupted'].includes(value.status), JSON.stringify(value));
        return value.status === 'completed' && value; });
    };
    const first = await push('first', 'Schedule my update.', 'alice');
    assert.equal(first.reply, 'Which detail?');
    await friends({ action: 'submit', input: { id: 'local-notice', text: 'Send me the update.', createdAt: new Date().toISOString() } });
    await until(() => received.some(body => body.arguments?.text === 'From desktop.'));
    assert.equal(received.find(body => body.arguments?.text === 'From desktop.').senderId, 'alice');
    const second = (await gateway.command({ action: 'save', config: { ...cfg, name: 'Weixin work' }, binding: {
      kind: 'assistant', sessionId: 'personal-assistant', title: 'Work', parent: { ...parent, sessionId: 'personal-assistant',
        tools: parent.tools.filter(t => t.name !== 'assistant_event'), metadata: { mcpCatalogUpdates: 'additions' } }, profile: assistant, generation: 0 } })).connections.find(c => c.id !== connection.id);
    assert.ok(second);
    const workHeaders = { Authorization: `Bearer ${second.token}`, 'Content-Type': 'application/json' }, workLease = second.endpoint.replace(/\/messages$/, '/capabilities');
    assert.equal((await fetch(workLease, { headers: workHeaders, method: 'POST', body: JSON.stringify({ protocol: 'cardbush.webhook.v1', capabilities: { text: true }, plugins: [plugin], instanceId }) })).status, 200);
    await push('second', 'Unrelated message.', 'bob', client(second));
    const workRequest = requests.find(req => req.sessionId === 'personal-assistant' && req.messages.some(m => m.content === 'Unrelated message.'));
    assert.ok(workRequest.tools.some(tool => tool.name === 'assistant_event'), 'an already paired Assistant bot can manage new events');
    await push('third', 'Confirmed detail.', 'alice');
    await push('first', 'Schedule my update.', 'alice');
    const events = (await friends({ action: 'read' })).events, original = events.find(e => e.intent === 'Schedule my update.');
    assert.deepEqual(original.inputs.map(i => i.text), ['Schedule my update.', 'Confirmed detail.']);
    assert.ok(original.inputs.every(i => i.authoredBy === 'assistant' && i.sourceMessageId), 'delegated event intents retain provenance without becoming user-authored quotes');
    assert.ok(!events.some(e => e.intent === 'Unrelated message.'), 'an ordinary chat message cannot become unrelated event evidence');
    await until(() => received.some(body => body.arguments?.text === 'Your scheduled notice.'));
    const sent = received.filter(body => body.type === 'tool.call' && body.arguments.text === 'Your scheduled notice.');
    assert.equal(sent.length, 1); assert.equal(sent[0].senderId, 'alice'); assert.equal(sent[0].messageId, 'first');
    assert.equal(sent[0].conversationId, 'shared-room'); assert.equal(sent[0].arguments.text, 'Your scheduled notice.');
    await until(() => received.filter(body => body.id).length === 3);
    assert.deepEqual(received.filter(body => body.id === 'first').map(body => [body.sender, body.text]), [['alice', 'Which detail?']]);
    const journal = await bridge.command('runtime.assistant_conversation', { action: 'read', sessionId: 'personal-assistant' });
    assert.ok(journal.entries.some(e => e.eventId === original.id && e.role === 'assistant'));
    assert.ok(journal.entries.some(e => e.content === 'Unrelated message.' && e.role === 'user'));
    assert.ok(requests.filter(req => req.metadata.friendsExecution).every(req => !JSON.stringify(req.messages).includes('Unrelated message.')));
    assert.equal((await bot.read('first')).reply, 'Which detail?');
    assert.equal((await runContextWebhook(bridge, selected, message('missing'), randomUUID(), true, new AbortController().signal)).status, 'interrupted');
    const inbound = requests.find(req => req.metadata.botSourceRef), timed = requests.find(req => req.metadata.friendsExecution && req.metadata.botSourceRefs);
    assert.equal(inbound.permissionMode, 'all_free'); assert.equal(inbound.requestCapabilities.interactiveRequests, false);
    assert.equal(timed.permissionMode, 'task_free'); assert.equal(timed.requestCapabilities.interactiveRequests, true);
    assert.deepEqual(timed.metadata.botSourceRefs, [original.deliveryRoute.sourceRef]);
    assert.equal((await fetch(leaseUrl, { headers, method: 'DELETE', body: JSON.stringify({ protocol: 'cardbush.webhook.v1', instanceId }) })).status, 200);
    assert.equal((await fetch(workLease, { headers: workHeaders, method: 'DELETE', body: JSON.stringify({ protocol: 'cardbush.webhook.v1', instanceId }) })).status, 200);
    await friends({ action: 'submit', input: { id: 'offline-check', text: 'Can I receive notifications?', createdAt: new Date().toISOString() } });
    await until(async () => (await friends({ action: 'read' })).events.find(e => e.id === 'offline-check')?.status === 'completed');
    const offline = requests.find(req => req.metadata.friendsEventId === 'offline-check');
    assert.match(JSON.stringify(offline.messages), /bot_offline/); assert.ok(!offline.tools.some(t => t.name.startsWith('mcp__bridge_')));
    assert.equal((await bridge.command('runtime.get_session', { sessionId })).turns.length, 0, 'Friends does not turn events into a chat transcript');
  } finally {
    await gateway?.close(); await bridge.command('runtime.shutdown', {}); receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve)); await rm(root, { recursive: true, force: true });
  }
});

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

test('Assistant webhook accepts new messages after reset and Runtime restart without reconnecting', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-assistant-reset-')), calls = [], sessionId = 'personal-assistant';
  const reply = Promise.withResolvers(); let runtime, gateway;
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  const startRuntime = () => new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), toolRegistry: new ToolRegistry(),
    provider: { async *stream(input) { calls.push(input); await reply.promise; yield* answer(input, 'Received in the current context.'); } } });
  const stored = async () => JSON.parse(secrets.decrypt(JSON.parse(await readFile(join(root, 'webhooks/state.json'), 'utf8')).encrypted));
  try {
    runtime = startRuntime(); await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const connection = (await gateway.command({ action: 'save', config: config(), binding: {
      ...binding(sessionId), kind: 'assistant', generation: 0, profile: assistantProfileSchema.parse({}) } })).connections[0];
    const bot = client(connection);
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
    assert.equal((await bot.send(message('after-reset', 'A new request after clearing Assistant.'))).status, 202);
    await until(() => calls.length === 1);
    const journal = await bridge.command('runtime.assistant_conversation', { action: 'read', sessionId });
    assert.equal(journal.generation, 1); assert.equal(journal.busy, true);
    assert.deepEqual(journal.entries.filter(e => e.role === 'user').map(e => e.content), ['A new request after clearing Assistant.'],
      'the user bubble is available to the UI before the model completes');
    assert.match(journal.entries.find(e => e.role === 'user').botSourceRef, /^webhook:/);
    reply.resolve();
    const completed = await until(async () => { const r = await bot.read('after-reset'); return r.status === 'completed' && r; });
    assert.equal(completed.reply, 'Received in the current context.');
    assert.equal((await stored()).connections[0].binding.generation, 1);
    await gateway.close(); await bridge.command('runtime.shutdown', {});
    runtime = startRuntime(); await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const reopened = (await gateway.command({ action: 'read', sessionId })).connections[0], resumed = client(reopened);
    assert.equal(reopened.id, connection.id); assert.equal(reopened.token, connection.token);
    assert.equal((await bridge.command('runtime.assistant_conversation', { action: 'read', sessionId })).generation, 0);
    const duplicate = await (await resumed.send(message('after-reset', 'A new request after clearing Assistant.'))).json();
    assert.equal(duplicate.status, 'completed'); assert.equal(duplicate.eventId, completed.eventId);
    assert.equal((await stored()).connections[0].binding.generation, 1, 'duplicates do not rebind saved connections');
    assert.equal((await resumed.send(message('after-restart'))).status, 202);
    await until(async () => (await resumed.read('after-restart')).status === 'completed');
    assert.equal(calls.length, 2);
    const state = await stored();
    assert.equal(state.connections[0].binding.generation, 0);
    assert.deepEqual(state.receipts.map(r => r.binding.generation), [1, 0], 'each accepted receipt retains its context');
  } finally { reply.resolve(); await gateway?.close(); await runtime?.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});

test('Assistant webhook reset isolates running and queued receipts from subsequent new messages', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-assistant-queue-')), calls = [], sessionId = 'personal-assistant';
  const oldReply = Promise.withResolvers(); let gateway;
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), toolRegistry: new ToolRegistry(),
    provider: { async *stream(input) { calls.push(input); if (calls.length === 1) await oldReply.promise; yield* answer(input, 'Current reply.'); } } });
  const bridge = { command: (kind, payload) => runtime.sendCommand({ kind, payload }) };
  try {
    await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const connection = (await gateway.command({ action: 'save', config: config(), binding: {
      ...binding(sessionId), kind: 'assistant', generation: 0, profile: assistantProfileSchema.parse({}) } })).connections[0];
    const bot = client(connection);
    assert.equal((await bot.send(message('running', 'Old running request.'))).status, 202);
    await until(() => calls.length === 1);
    assert.equal((await bot.send(message('queued', 'Old queued request.'))).status, 202);
    assert.equal((await bot.read('queued')).status, 'accepted');
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId });
    assert.equal((await bot.send(message('fresh', 'Fresh request.'))).status, 202);
    oldReply.resolve();
    for (const id of ['running', 'queued']) {
      const rejected = await until(async () => { const r = await bot.read(id); return r.status === 'failed' && r; });
      assert.equal(rejected.errorCode, 'context_reset');
    }
    await until(async () => (await bot.read('fresh')).status === 'completed');
    const duplicate = await (await bot.send(message('queued', 'Old queued request.'))).json();
    assert.equal(duplicate.status, 'failed'); assert.equal(duplicate.errorCode, 'context_reset');
    assert.equal((await bot.send(message('queued', 'Changed old request.'))).status, 409);
    assert.equal(calls.length, 2, 'old queued requests are never executed in the new context');
    assert.doesNotMatch(JSON.stringify(calls[1].messages), /Old (running|queued) request/);
    const journal = await bridge.command('runtime.assistant_conversation', { action: 'read', sessionId });
    assert.deepEqual(journal.entries.filter(e => e.role === 'user').map(e => e.content), ['Fresh request.']);
    const state = JSON.parse(secrets.decrypt(JSON.parse(await readFile(join(root, 'webhooks/state.json'), 'utf8')).encrypted));
    assert.deepEqual(state.receipts.map(r => r.binding.generation), [0, 0, 1]);
  } finally { oldReply.resolve(); await gateway?.close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
});

test('Assistant webhook admission remains retryable when the current context cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webhook-assistant-admission-')), sessionId = 'personal-assistant';
  let gateway, unavailable = true, calls = 0;
  const runtime = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: new SessionStore(), toolRegistry: new ToolRegistry(),
    provider: { async *stream(input) { calls++; yield* answer(input, 'Received once.'); } } });
  const bridge = { async command(kind, payload) {
    if (unavailable && kind === 'runtime.assistant_conversation' && payload.action === 'read') throw Error('Runtime transport temporarily unavailable.');
    return runtime.sendCommand({ kind, payload });
  } };
  try {
    await bridge.command('runtime.create_session', { sessionId });
    gateway = await new ContextWebhookHost(root, secrets, bridge, { port: 0 }).start();
    const connection = (await gateway.command({ action: 'save', config: config(), binding: {
      ...binding(sessionId), kind: 'assistant', generation: 0, profile: assistantProfileSchema.parse({}) } })).connections[0];
    const bot = client(connection), failed = await bot.send(message('retry'));
    assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: { code: 'service_unavailable' } });
    const state = JSON.parse(secrets.decrypt(JSON.parse(await readFile(join(root, 'webhooks/state.json'), 'utf8')).encrypted));
    assert.deepEqual(state.receipts, [], 'a failed admission must not consume the bridge message ID');
    await bridge.command('runtime.assistant_conversation', { action: 'reset', sessionId }); unavailable = false;
    assert.equal((await bot.send(message('retry'))).status, 202);
    await until(async () => (await bot.read('retry')).status === 'completed');
    assert.equal(calls, 1);
  } finally { await gateway?.close(); await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); }
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
