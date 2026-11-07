// Optional cross-repository contract test. Uses the independent unified bridge project;
// only their platform network calls and the model are simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AgentService } from '../dist-electron/agentService.mjs';
import { bridgeModelStep } from './helpers/bridge-plugin-fixture.mjs';
if (process.platform !== 'win32') process.env.CARDBUSH_CREDENTIAL_KEY = randomBytes(32).toString('hex');
const tempRoot = resolve('tmp/cli-bridge-contract-tests');
const wait = () => new Promise(r => setTimeout(r, 30));
async function until(fn) { for (let n = 0; n < 300; n++) { const value = await fn(); if (value) return value; await wait(); } throw Error('test_timeout'); }

for (const platform of ['weixin', 'feishu']) test(`${platform} adapter discovers CLI, continues the bound session and sends a tool file`, { timeout: 60000 }, async () => {
  const legacy = process.env[`CARDBUSH_${platform.toUpperCase()}_BRIDGE_DIR`];
  const source = resolve(process.env.CARDBUSH_BRIDGES_DIR || '../cardbush-bridges');
  const adapter = legacy ? resolve(legacy, 'src') : join(source, 'src/adapters', platform);
  const shared = legacy ? resolve(legacy, 'src') : join(source, 'src/shared');
  const { Bridge } = await import(pathToFileURL(join(adapter, 'bridge.mjs')));
  const { connectLocalService } = await import(pathToFileURL(join(shared, 'local-connection.mjs')));
  await mkdir(tempRoot, { recursive: true }); const root = await mkdtemp(join(tempRoot, platform + '-'));
  const bridgeRoot = join(root, 'bridge'); await mkdir(bridgeRoot);
  const file = join(root, 'contract.txt'), bytes = Buffer.from('微信/飞书桥原样接入 CLI\n'); await writeFile(file, bytes);
  const uploads = [], sent = [], calls = []; let service, bridge, connecting;
  const cancel = new AbortController();
  const reasoning = Promise.withResolvers(); let interrupted = false;
  const model = createServer(async (req, res) => {
    req.setEncoding('utf8'); let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    calls.push(body);
    if (calls.length === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      res.on('close', () => { interrupted = true; }); reasoning.resolve();
      return;
    }
    const strings = []; const visit = x => { if (typeof x === 'string') strings.push(x); else if (x && typeof x === 'object') Object.values(x).forEach(visit); }; visit(body.input);
    const sourceRef = strings.join('\n').match(/"sourceRef"\s*:\s*"(webhook:[a-f0-9-]{36})"/)?.[1];
    const send = bridgeModelStep(body.input, file), n = calls.length;
    const item = send ? { id: 'function-' + n, call_id: send.id, type: 'function_call', name: send.name, status: 'completed',
      arguments: JSON.stringify(send.arguments) }
      : { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成测试。', annotations: [] }] };
    const response = { id: 'response_' + n, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit(send ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
    emit({ type: 'response.output_item.done', output_index: 0, item }); emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); res.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  try {
    service = await AgentService.open({ dataRoot: root, local: true, webhookPort: 0, env: { CARDBUSH_EXECUTION_SANDBOX: 'off' } });
    await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture-model', apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${model.address().port}/v1` }] } });
    await service.call('sessions.create', { sessionId: 'chosen' });
    const state = await service.call('webhooks.command', { action: 'start', sessionId: 'chosen' });
    const config = { port: 4793, callbackToken: 'b'.repeat(64), cardbush: { url: 'http://127.0.0.1:4791/api/webhooks/v1/test/messages', token: 'a'.repeat(64) } };
    if (platform === 'weixin') bridge = await new Bridge(bridgeRoot, config, { id: 'bot-fixture', userId: 'owner' }, {
      send: async (...args) => sent.push(['text', ...args]), sendFile: async (...args) => { uploads.push(args[2].bytes); sent.push(['file', ...args]); },
    }, { log() {} }).load();
    else bridge = await new Bridge(bridgeRoot, { ...config, feishu: { appId: 'cli_fixture', appSecret: 'fixture-secret' }, allowedSenders: ['owner'] }, {
      text: async (...args) => sent.push(['text', ...args]), upload: async data => { uploads.push(data.bytes); return 'file_uploaded'; }, file: async (...args) => sent.push(['file', ...args]),
    }, { botOpenId: 'ou_bot', log() {} }).load();
    const callbackPort = await bridge.listen(0);
    connecting = connectLocalService({ ...bridge.config, port: callbackPort, cardbush: { url: '', token: '' } }, {
      name: platform, baseUrl: `http://127.0.0.1:${state.port}`, save: async () => {}, wait, signal: cancel.signal,
    }); void connecting.catch(() => {});
    const pending = await until(async () => (await service.call('webhooks.command', { action: 'read', sessionId: 'chosen' })).pairings[0]);
    await service.call('webhooks.command', { action: 'connect', sessionId: 'chosen', id: pending.requestId,
      settings: { modelId: 'fixture', permissionMode: 'all_free', language: 'zh' } });
    bridge.config = await connecting; await bridge.advertise();
    const ingest = async (id, text) => {
      if (platform === 'weixin') await bridge.ingest({ msgs: [{ message_type: 1, message_id: id, from_user_id: 'owner', context_token: id + '-context', item_list: [{ type: 1, text_item: { text } }] }] });
      else await bridge.ingest({ sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: id, chat_id: 'oc_origin', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } });
    };
    await ingest('original', '看看测试文件。'); await bridge.processOnce(); await reasoning.promise;
    await ingest('supplement', '补充：用工具把测试文件发给我。');
    await until(async () => { await bridge.processOnce(); return sent.some(s => s[0] === 'file') && sent.filter(s => s[0] === 'text').length === 2; });
    assert.ok(interrupted, 'the earlier model stream was interrupted by an ordinary platform message');
    assert.ok(JSON.stringify(calls[1].input).includes('补充：用工具把测试文件发给我。'));
    assert.deepEqual(uploads, [bytes]); assert.equal(sent.filter(s => s[0] === 'file').length, 1);
    assert.equal(sent.find(s => s[0] === 'file')[1], platform === 'weixin' ? 'owner' : 'oc_origin');
    if (platform === 'weixin') assert.equal(sent.find(s => s[0] === 'file')[2], 'supplement-context');
    assert.equal((await service.call('chat.jobs', { sessionId: 'chosen' })).length, 1);
    assert.ok(calls.every(call => !call.tools.some(t => t.name === 'send_to_bot')));
    assert.ok(JSON.stringify(calls).includes('bridge-schema-call'), 'plugin schema is loaded through discovery');
    await bridge.processOnce(); assert.equal(uploads.length, 1);
  } finally { cancel.abort(); await connecting?.catch(() => {}); await bridge?.close(); await service?.close(); model.closeAllConnections(); await new Promise(r => model.close(r));
    assert.ok(resolve(root).startsWith(tempRoot + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
