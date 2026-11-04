import test from 'node:test';
import { fixturePlugin, bridgeModelStep } from './helpers/bridge-plugin-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentWebhooks } from '../dist-electron/agentWebhooks.mjs';
import { chatWebhookCommand, askWithWebhookJobs } from '../dist-electron/agentChatWebhooks.mjs';
import { commandSuggestions } from '../dist-electron/agentChatCompletion.mjs';
import { NativeChatTerminal } from '../dist-electron/agentChatTerminal.mjs';
import { openLocalChatClient } from '../dist-electron/agentLocalChat.mjs';

if (process.platform !== 'win32') process.env.CARDBUSH_CREDENTIAL_KEY = randomBytes(32).toString('hex');
const tempRoot = resolve('tmp/cli-webhook-tests');
const settings = { modelId: 'fixture', permissionMode: 'all_free', language: 'zh' };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 300; n++) { const value = await fn(); if (value) return value; await wait(30); } throw Error('test_timeout'); }
async function directory() { await mkdir(tempRoot, { recursive: true }); return mkdtemp(join(tempRoot, 'case-')); }
async function cleanup(root) { assert.ok(resolve(root).startsWith(tempRoot + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const p = server.address().port; await new Promise(r => server.close(r)); return p; }

test('terminal connects the selected service to the current session; cancellation and errors do not authorize', async () => {
  const calls = [], output = [], answers = ['1']; const id = randomUUID();
  const state = { enabled: true, listening: true, port: 4791, connections: [], pairings: [{ requestId: id, name: 'Example bot' }] };
  const client = { call: async (op, input) => { calls.push({ op, ...input }); return state; } };
  const io = { interactive: true, selectionMenus: false, status: text => output.push(text), ask: async () => answers.shift() ?? '/cancel' };
  await chatWebhookCommand('/webhook', client, io, new AbortController().signal, 'current', settings, 'zh');
  assert.deepEqual(calls[1], { op: 'webhooks.command', action: 'connect', sessionId: 'current', id, settings });
  assert.match(output.join(''), /当前会话/); assert.ok(!output.join('').includes('Bearer'));
  calls.length = 0; await chatWebhookCommand('/webhook', client, io, new AbortController().signal, 'other', settings, 'en');
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'start');
  calls.length = 0; state.listening = false;
  await chatWebhookCommand('/webhook', client, io, new AbortController().signal, 'other', settings, 'zh');
  assert.equal(calls.length, 1); assert.match(output.join(''), /4791/);
  assert.ok(commandSuggestions('/webh', 5, []).items.some(item => item.value === '/webhook'));
});

test('idle prompt wakes for a fast completed Webhook job, without requiring a local message', async () => {
  const job = { id: 'external', botSourceRef: 'webhook:source', status: 'completed' };
  const client = { call: async () => [job] };
  const io = { ask: async (_prompt, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true })) };
  const result = await askWithWebhookJobs(client, io, 'current', new Set(), new AbortController().signal);
  assert.equal(result.text, null); assert.deepEqual(result.jobs, ['external']);
});

test('shared host reports an occupied port without changing the other host, and stops persisting its enabled state', async () => {
  const root = await directory(), occupied = createServer((req, res) => res.end('existing-owner'));
  occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  const p = occupied.address().port, host = new AgentWebhooks(root, { command: async () => ({}) }, async () => ({ status: 'completed', reply: '' }), p);
  try {
    const state = await host.command({ action: 'start', sessionId: 's' }, () => assert.fail());
    assert.equal(state.listening, false); assert.equal(await (await fetch(`http://127.0.0.1:${p}`)).text(), 'existing-owner');
    await assert.rejects(host.command({ action: 'connect', id: randomUUID(), sessionId: 's' }, () => assert.fail()), /listener_failed/);
    await host.command({ action: 'stop', sessionId: 's' }, () => assert.fail()); assert.equal(host.keepAlive, false);
    assert.deepEqual(await host.botRequest({ action: 'context', sessionId: 's' }), { discovery: 'mcp_search', available: false, reason: 'bot_not_connected', targets: [] });
    assert.equal(JSON.parse(await readFile(join(root, 'webhooks/host.json'), 'utf8')).enabled, false);
  } finally { await host.close(); occupied.closeAllConnections(); await new Promise(r => occupied.close(r)); await cleanup(root); }
});

test('an incoming Bot task preserves an unfinished native terminal draft', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  const output = Object.assign(new Writable({ write(_data, _encoding, done) { done(); } }), { isTTY: true, columns: 100, rows: 30 });
  const io = new NativeChatTerminal(() => {}, { input, output, status: output, env: { TERM: 'xterm', NO_COLOR: '' } });
  const signal = new AbortController().signal;
  try {
    io.enableLiveInput(() => assert.fail('Draft was submitted unexpectedly'));
    const ask = askWithWebhookJobs({ call: async () => [{ id: 'bot-job', botSourceRef: 'webhook:fixture' }] }, io, 's', new Set(), signal);
    input.write('preserved draft'); assert.deepEqual((await ask).jobs, ['bot-job']);
    io.beginTurn(); io.finishTurn('completed');
    const next = io.ask('❯ ', signal, true); input.write(' completed\r');
    assert.equal(await next, 'preserved draft completed');
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('actual headless Runtime preserves current CLI history/model, discovers bridge plugins, persists pairing and deduplicates restart', { timeout: 60000 }, async () => {
  const root = await directory(), webhookPort = await port(), modelCalls = [], received = [];
  const bytes = Buffer.from('CLI 通用文件链路\n\0🙂'), file = join(root, 'report.txt'); await writeFile(file, bytes);
  let service; const callbackToken = 'b'.repeat(64);
  const model = createServer(async (req, res) => {
    req.setEncoding('utf8'); let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    modelCalls.push(body); const n = modelCalls.length;
    const strings = []; const visit = value => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(visit); }; visit(body.input);
    const source = strings.join('\n').match(/"sourceRef"\s*:\s*"(webhook:[a-f0-9-]{36})"/)?.[1];
    const send = bridgeModelStep(body.input, file, 'cli');
    const item = send ? { id: 'function-' + n, call_id: send.id, type: 'function_call', name: send.name,
      arguments: JSON.stringify(send.arguments), status: 'completed' }
      : { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: source ? 'Sent to the original bot.' : 'Remembered olive.', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const response = { id: 'response_' + n, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit(send ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); res.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const callback = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + callbackToken);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let event, fileBytes;
    if (req.headers['content-type'].startsWith('multipart/')) {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
      event = JSON.parse(form.get('payload')); fileBytes = Buffer.from(await form.get('file_0').arrayBuffer());
    } else event = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ event, fileBytes });
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: 'cardbush.webhook.v1', eventId: event.eventId, status: 'accepted' }));
  });
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const options = { dataRoot: root, local: true, webhookPort, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1', CARDBUSH_EXECUTION_SANDBOX: 'off' } };
  try {
    service = await AgentService.open(options);
    await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture-model', apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${model.address().port}/v1` }] } });
    await service.call('sessions.create', { sessionId: 'current', title: 'Current CLI session' });
    await service.call('sessions.create', { sessionId: 'other' });
    await service.call('chat.send', { requestId: 'prior', sessionId: 'current', text: 'Remember olive.', ...settings });
    await until(async () => (await service.call('chat.jobs', { sessionId: 'current' })).some(j => j.id === 'prior' && j.status === 'completed'));
    assert.equal((await service.call('webhooks.command', { action: 'read', sessionId: 'current' })).enabled, false);
    await service.call('webhooks.command', { action: 'start', sessionId: 'current' }); assert.equal(service.keepAlive, true);
    const base = `http://127.0.0.1:${webhookPort}/api/webhooks/v1`, protocol = 'cardbush.webhook.v1';
    assert.ok((await (await fetch(base + '/discovery')).json()).capabilities.includes('local_pairing'));
    const requestId = randomUUID(), secret = 'c'.repeat(64), pairHeaders = { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' };
    const pairing = await fetch(base + '/pairings', { method: 'POST', headers: pairHeaders, body: JSON.stringify({ requestId, name: 'Generic bridge', replyUrl: `http://127.0.0.1:${callback.address().port}/reply`, replyHeaders: { Authorization: 'Bearer ' + callbackToken } }) });
    const pending = await pairing.json(); assert.equal(pending.status, 'pending', JSON.stringify(pending));
    const before = await service.call('webhooks.command', { action: 'read', sessionId: 'current' }); assert.equal(before.pairings[0].requestId, requestId);
    await service.call('webhooks.command', { action: 'connect', id: requestId, sessionId: 'current', settings });
    const paired = await (await fetch(base + '/pairings/' + requestId, { headers: pairHeaders })).json();
    const connection = paired.connection, headers = { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' };
    const caps = await fetch(connection.endpoint.replace(/\/messages$/, '/capabilities'), { method: 'POST', headers, body: JSON.stringify({ protocol, capabilities: { text: true, files: true }, plugins: [fixturePlugin] }) });
    assert.equal(caps.status, 200);
    const message = { messageId: 'external-once', text: 'Send the report as a file.', senderId: 'original-user', conversationId: 'original-chat' };
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify(message) })).status, 202);
    const receipt = await until(async () => { const r = await (await fetch(connection.endpoint + '/external-once', { headers })).json(); return !['accepted','running'].includes(r.status) && r; });
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
    const delivery = await until(() => received.find(item => item.event.type === 'tool.call'));
    assert.deepEqual(delivery.fileBytes, bytes); assert.equal(delivery.event.senderId, message.senderId); assert.equal(delivery.event.conversationId, message.conversationId);
    assert.equal(delivery.event.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.match(JSON.stringify(modelCalls[1].input), /Remember olive/); assert.ok(modelCalls.every(call => !call.tools.some(t => t.name === 'send_to_bot')));
    assert.equal(modelCalls[1].model, 'fixture-model');
    const jobs = await service.call('chat.jobs', { sessionId: 'current' }); assert.match(jobs.at(-1).botSourceRef, /^webhook:/);
    assert.equal((await service.call('chat.jobs', { sessionId: 'other' })).length, 0);
    await assert.rejects(service.call('chat.send', { ...settings, requestId: 'spoof', sessionId: 'other', text: 'x', botSourceRef: jobs.at(-1).botSourceRef }));
    const state = await service.call('webhooks.command', { action: 'read', sessionId: 'current' });
    assert.ok(!JSON.stringify(state).includes(connection.token)); assert.ok(!JSON.stringify(state).includes(callbackToken));
    const stored = await readFile(join(root, 'webhooks/state.json'), 'utf8'); assert.ok(!stored.includes(connection.token)); assert.ok(!stored.includes(callbackToken));
    const count = modelCalls.length; await service.close(); service = await AgentService.open(options);
    assert.equal(service.keepAlive, true);
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify(message) })).status, 202);
    await wait(350); assert.equal(modelCalls.length, count);
    await assert.rejects(service.call('webhooks.command', { action: 'disconnect', id: state.connections[0].id, sessionId: 'other' }), /connection_not_found/);
    await service.call('webhooks.command', { action: 'disconnect', id: state.connections[0].id, sessionId: 'current' });
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: JSON.stringify(message) })).status, 401);
    await service.call('webhooks.command', { action: 'stop', sessionId: 'current' }); assert.equal(service.keepAlive, false);
    await service.close(); service = await AgentService.open(options); assert.equal(service.keepAlive, false);
  } finally { await service?.close(); for (const s of [callback, model]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } await cleanup(root); }
});

test('local CLI Runtime keeps its Webhook after the last terminal closes and releases it after stop', { timeout: 60000 }, async () => {
  const root = await directory(), options = { dataRoot: join(root, 'runtime'), profileRoot: join(root, 'profile') };
  let client;
  const stopped = () => readFile(join(options.dataRoot, 'agent.lock')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
  try {
    client = await openLocalChatClient(options);
    await client.call('sessions.create', { sessionId: 'chosen' });
    const state = await client.call('webhooks.command', { action: 'listener', sessionId: 'chosen', port: await port() });
    assert.equal(state.listening, true);
    const identity = (await client.info()).id;
    await client.close(); client = undefined;
    await wait(1600); // Beyond the ordinary one-second idle shutdown.
    assert.equal(await stopped(), false);
    assert.equal((await fetch(`http://127.0.0.1:${state.port}/api/webhooks/v1/discovery`)).status, 200);
    client = await openLocalChatClient(options); assert.equal((await client.info()).id, identity);
    assert.equal((await client.call('webhooks.command', { action: 'read', sessionId: 'chosen' })).listening, true);
    await client.call('webhooks.command', { action: 'stop', sessionId: 'chosen' });
    await client.close(); client = undefined; await until(stopped);
  } finally {
    if (!await stopped()) {
      client ??= await openLocalChatClient(options);
      try { await client.call('webhooks.command', { action: 'stop', sessionId: 'chosen' }); } finally { await client.close(); }
      await until(stopped);
    }
    await cleanup(root);
  }
});
