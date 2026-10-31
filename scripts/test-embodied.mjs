import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import OpusScript from 'opusscript';
import { EmbodiedDeviceStore, deviceEndpoint } from '../dist-electron/embodiedDevices.mjs';
import { EmbodiedGateway } from '../dist-electron/embodiedGateway.mjs';
import { EmbodiedAudioCodec } from '../dist-electron/embodiedAudio.mjs';
import { AssistantHostSettingsStore } from '../dist-electron/assistantVoiceHost.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { defaultRealtimeVoiceSettings } from '../dist-electron/realtimeVoiceTypes.js';
import { writePrivateJson } from '../dist-electron/atomicJsonFile.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hello = { type: 'hello', version: 1, transport: 'websocket', features: { cardbush: true, mcp: false },
  audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 20 } };
async function until(read, test, timeout = 12000) {
  const end = Date.now() + timeout; let last;
  do { last = await read(); if (test(last)) return last; await pause(20); } while (Date.now() < end);
  assert.fail(`Timeout: ${JSON.stringify(last).slice(0, 400)}`);
}
async function temporary() { await mkdir('tmp/embodied-tests', { recursive: true }); return mkdtemp(resolve('tmp/embodied-tests/host-')); }
async function remove(root) {
  assert.ok(resolve(root).startsWith(resolve('tmp/embodied-tests') + (process.platform === 'win32' ? '\\' : '/')));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function connect(url, pair, extra = {}) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${pair.token}`, 'Device-Id': pair.id, 'Protocol-Version': '1', ...extra } });
  const events = [], packets = [];
  socket.on('message', (data, binary) => binary ? packets.push(Buffer.from(data)) : events.push(JSON.parse(data.toString())));
  return { socket, events, packets, send: value => socket.send(JSON.stringify(value)) };
}
const pairInput = { id: 'aa:bb:cc:dd:ee:ff', name: 'Fixture Kit', board: 'atoms3r-ai-chatbot' };

test('atomic settings tolerate transient Windows locks and retain the original on permanent failure', async t => {
  const root = await temporary(), file = join(root, 'settings.json'), rename = fs.rename;
  try {
    await writePrivateJson(file, { version: 1 });
    let attempts = 0;
    const replacement = t.mock.method(fs, 'rename', async (...args) => {
      if (++attempts < 3) throw Object.assign(new Error('temporary lock'), { code: 'EPERM' });
      return rename(...args);
    });
    await writePrivateJson(file, { version: 2 });
    assert.equal(attempts, 3); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2 });
    attempts = 0;
    replacement.mock.mockImplementation(async () => { attempts++; throw Object.assign(new Error('persistent lock'), { code: 'EBUSY' }); });
    await assert.rejects(writePrivateJson(file, { version: 3 }), { code: 'EBUSY' });
    assert.equal(attempts, 6); assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2 });
    assert.deepEqual(await fs.readdir(root), ['settings.json']);
    attempts = 0;
    replacement.mock.mockImplementation(async () => { attempts++; throw Object.assign(new Error('disk error'), { code: 'EIO' }); });
    await assert.rejects(writePrivateJson(file, { version: 4 }), { code: 'EIO' });
    assert.equal(attempts, 1);
    replacement.mock.restore();
  } finally { await remove(root); }
});

test('pairing is durable, scoped and revocable; endpoints and settings preserve host policy', async () => {
  const root = await temporary();
  try {
    const file = join(root, 'devices.json'), store = new EmbodiedDeviceStore(file);
    assert.equal((await store.read()).listener.enabled, false);
    for (const url of ['ws://public.example/api/embodied/v1/audio', 'wss://u:p@example/api/embodied/v1/audio', 'wss://example/api/embodied/v1/audio?token=x', 'http://localhost/api/embodied/v1/audio']) assert.throws(() => deviceEndpoint(url));
    for (const host of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1']) assert.ok(deviceEndpoint(`ws://${host}/api/embodied/v1/audio`));
    const pair = await store.pair(pairInput);
    assert.equal((await store.authenticate(pair.id, pair.token))?.id, pair.id);
    assert.equal(await store.authenticate('bb:bb:cc:dd:ee:ff', pair.token), undefined);
    assert.equal(await store.authenticate(pair.id, '0'.repeat(64)), undefined);
    assert.ok(!(await readFile(file, 'utf8')).includes(pair.token));
    assert.ok(!JSON.stringify(await store.list()).includes('token'));
    await assert.rejects(store.pair(pairInput), /already paired/);
    await store.revoke(pair.id); assert.equal(await store.authenticate(pair.id, pair.token), undefined);
    const fresh = await store.pair(pairInput); assert.notEqual(fresh.token, pair.token);
    const assistant = new AssistantHostSettingsStore(join(root, 'assistant.json'));
    await assistant.save({ voice: 'male', permissionMode: 'user_free' });
    assert.equal((await assistant.save({ modelId: 'chosen' })).voice, 'male');
    assert.equal((await assistant.read()).permissionMode, 'user_free');
    await assistant.save({ profile: { microphoneMuted: true } });
    assert.equal((await assistant.save({ profile: { name: 'renamed' } })).profile.microphoneMuted, true);
    await assert.rejects(assistant.save({ apiKey: 'not-a-device-setting' }));
    await Promise.all([assistant.save({ modelId: 'parallel-model' }), assistant.save({ profile: { name: 'parallel-name' } })]);
    assert.equal((await assistant.read()).modelId, 'parallel-model');
    assert.equal((await assistant.read()).profile.name, 'parallel-name');
  } finally { await remove(root); }
});

test('Opus conversion preserves negotiated durations and has no cross-reply buffered samples', () => {
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const decoder = new OpusScript(24000, 1, OpusScript.Application.VOIP);
  try {
    for (const duration of [20, 40, 60]) {
      const codec = new EmbodiedAudioCodec(duration);
      try {
        assert.equal(codec.decode(encoder.encode(Buffer.alloc(duration * 16 * 2), duration * 16)).length, duration / 20);
        const encoded = codec.encode(Buffer.alloc(duration * 24 * 2));
        assert.equal(encoded.length, 1); assert.equal(decoder.decode(encoded[0]).length, duration * 24 * 2);
        codec.encode(Buffer.alloc(10)); codec.clear(); assert.equal(codec.encode(Buffer.alloc(0), true).length, 0);
        assert.throws(() => codec.decode(Buffer.alloc(0))); assert.throws(() => codec.encode(Buffer.alloc(1)));
      } finally { codec.close(); codec.close(); }
    }
  } finally { encoder.delete(); decoder.delete(); }
});

test('gateway gates readiness, rejects duplicate identities and clears queued speech on barge-in', async () => {
  const root = await temporary(), store = new EmbodiedDeviceStore(join(root, 'devices.json'));
  let emit, release; const actions = [], incoming = [], playback = [];
  const ready = new Promise(resolve => { release = resolve; });
  const gateway = new EmbodiedGateway(store, async (_device, send) => { emit = send; return {
    start: () => ready, audio: frame => incoming.push(frame), control: action => actions.push(action), playback: value => playback.push(value), close() { actions.push('closed'); },
  }; });
  let client;
  try {
    await store.configure({ enabled: true, host: '127.0.0.1', port: 0 }); const pair = await store.pair(pairInput);
    const { port } = await gateway.start(), url = `ws://127.0.0.1:${port}/api/embodied/v1/audio`;
    const rejected = connect(url, { ...pair, token: '0'.repeat(64) });
    await once(rejected.socket, 'error'); assert.equal(emit, undefined);
    client = connect(url, pair); await once(client.socket, 'open'); client.send(hello);
    await until(() => emit, Boolean); assert.equal(gateway.snapshot().devices[pair.id].connected, false);
    release(); await until(() => client.events, events => events.some(e => e.type === 'hello'));
    assert.equal(gateway.snapshot().devices[pair.id].connected, true);
    const duplicate = connect(url, pair); await once(duplicate.socket, 'error');
    const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
    client.socket.send(encoder.encode(Buffer.alloc(640), 320)); encoder.delete();
    await until(() => incoming.length, n => n === 1); assert.equal(incoming[0].length, 640);
    emit({ id: 'fixture', type: 'audio-start' }); emit({ id: 'fixture', type: 'audio', sampleRate: 24000, pcm: Buffer.alloc(48000).toString('base64') });
    await until(() => client.packets.length, n => n > 0);
    client.send({ type: 'cardbush', action: 'speech', speaking: true });
    await until(() => client.events, events => events.some(e => e.type === 'cardbush' && e.action === 'interrupt'));
    await pause(35); const sent = client.packets.length; await pause(90); assert.equal(client.packets.length, sent);
    assert.ok(actions.includes('interrupt')); assert.equal(playback.at(-1), false);
    emit({ id: 'fixture', type: 'audio', sampleRate: 24000, pcm: Buffer.alloc(960).toString('base64') });
    await pause(30); assert.equal(client.packets.length, sent, 'late cancelled audio is suppressed');
    emit({ id: 'fixture', type: 'audio-start' }); emit({ id: 'fixture', type: 'audio', sampleRate: 24000, pcm: Buffer.alloc(960).toString('base64') });
    await until(() => client.packets.length, n => n === sent + 1);
    await store.revoke(pair.id); gateway.disconnect(pair.id); await once(client.socket, 'close');
    assert.equal(gateway.snapshot().devices[pair.id].connected, false); assert.ok(actions.includes('closed'));
  } finally { release?.(); client?.socket.terminate(); await gateway.close(); await remove(root); }
});

test('independent Agent: device -> provider -> existing assistant Runtime -> child task; reconnect does not dispatch again', { timeout: 45000 }, async () => {
  const root = await temporary(); let service, management, client;
  const voice = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(voice, 'listening');
  const providers = [], providerInputs = [], modelRequests = [];
  voice.on('connection', (ws, request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-provider-credential');
    providers.push(ws);
    ws.on('message', raw => {
      const message = JSON.parse(raw); providerInputs.push(message);
      if (message.type === 'session.create') ws.send(JSON.stringify({ type: 'session.created', protocol: 'cardbush.realtime.v1' }));
      if (message.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }));
      if (message.type === 'conversation.item.create' && message.items.every(i => i.id)) ws.send(JSON.stringify({ type: 'conversation.item.added', items: message.items, event_id: message.event_id }));
    });
  });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    modelRequests.push(body); const n = modelRequests.length;
    const item = { id: `message-${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The fixture task is complete.', annotations: [] }] };
    const response = { id: `response-${n}`, object: 'response', model: body.model, status: 'in_progress', output: [] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [{ type: 'response.created', response }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  try {
    service = await AgentService.open({ dataRoot: root, name: 'embodied-fixture', env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
    await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'fixture', baseURL: `http://127.0.0.1:${model.address().port}/v1` }] } });
    const device = (action, input) => service.call('devices.command', { action, input });
    await device('voice.save', { ...defaultRealtimeVoiceSettings, provider: 'cardbush', model: 'fixture', apiKey: 'fixture-provider-credential', endpoint: `ws://127.0.0.1:${voice.address().port}/realtime` });
    assert.ok(!(await readFile(join(root, 'voice-realtime-settings.json'), 'utf8')).includes('fixture-provider-credential'));
    await device('assistant.save', { language: 'en', permissionMode: 'user_free', profile: { name: 'Fixture assistant' } });
    const listening = await device('configure', { enabled: true, host: '127.0.0.1', port: 0 });
    const pair = await device('pair', pairInput), url = `ws://127.0.0.1:${listening.port}/api/embodied/v1/audio`;
    // Device credentials cannot authorize the existing management API.
    management = await serveAgentHttp(service, { host: '127.0.0.1', port: 0, token: 'management-fixture-'.repeat(4) });
    assert.equal((await fetch(`http://127.0.0.1:${management.port}/api/agent/v1/call`, { method: 'POST', headers: { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' }, body: '{"operation":"devices.command","input":{"action":"status"}}' })).status, 401);
    client = connect(url, pair); await once(client.socket, 'open'); client.send(hello);
    await until(() => client.events, list => list.some(e => e.type === 'hello'));
    const secondPair = await device('pair', { ...pairInput, id: 'aa:bb:cc:dd:ee:00' });
    const second = connect(url, secondPair); await once(second.socket, 'open'); second.send(hello);
    await once(second.socket, 'close');
    assert.ok(second.events.some(e => e.type === 'alert')); assert.equal(providers.length, 1, 'another device cannot replace the active assistant call');
    const session = providerInputs.find(e => e.type === 'session.create'); assert.ok(session.session.instructions.includes('Fixture assistant'));
    assert.ok(session.session.tools.some(t => t.name === 'subagent')); assert.ok(!session.session.tools.some(t => t.name === 'exec_command'));
    const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP); client.socket.send(encoder.encode(Buffer.alloc(640), 320)); encoder.delete();
    await until(() => providerInputs, list => list.some(e => e.type === 'input_audio_buffer.append'));
    const send = value => providers.at(-1).send(JSON.stringify(value));
    send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech-fixture', transcript: 'Use the fixture-context-42 details in the task.' });
    send({ type: 'response.output_audio.started' }); send({ type: 'response.output_audio.delta', delta: Buffer.alloc(960).toString('base64') }); send({ type: 'response.output_audio.done' }); send({ type: 'response.done' });
    await until(() => client.packets.length, n => n > 0); client.send({ type: 'cardbush', action: 'playback', speaking: false });
    const tool = { type: 'response.function_call_arguments.done', items: [{ type: 'function_call', call_id: 'once', name: 'subagent', arguments: '{"prompt":"Reply with a short fixture confirmation. Do not use tools."}' }] };
    send(tool); send(tool);
    const results = await until(() => providerInputs.flatMap(e => e.items || []).filter(i => i.call_id === 'once'), list => list.length > 0);
    const receipt = JSON.parse(results[0].content[0].text); assert.equal(receipt.status, 'running');
    const runtime = async (kind, payload) => {
      const result = await service.runtime.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: crypto.randomUUID(), command: { kind, payload } });
      if (!result.ok) throw Error(result.error?.message); return result.result;
    };
    const tasks = () => runtime('runtime.list_subagent_tasks', { parentSessionId: 'personal-assistant' });
    await until(tasks, list => list.length === 1 && list[0].status !== 'running');
    assert.equal((await tasks())[0].status, 'completed'); assert.ok(modelRequests.length > 0);
    assert.ok(JSON.stringify(modelRequests[0]).includes('fixture-context-42'), 'child receives the same bounded conversation journal as desktop delegation');
    await until(() => providerInputs, list => list.some(e => e.type === 'conversation.item.create' && e.items?.some(i=>i.content?.some(c=>c.text?.includes('CardBush background task notification')))));
    assert.equal(providerInputs.some(e=>e.type==='speech_text_buffer.commit'),false,'task availability never forces narration');
    assert.equal(modelRequests.length,1,'completion does not request a separate text-model summary');
    client.socket.close(); await once(client.socket, 'close'); await pause(100);
    client = connect(url, pair); await once(client.socket, 'open'); client.send(hello);
    await until(() => client.events, list => list.some(e => e.type === 'hello'));
    assert.equal((await tasks()).length, 1, 'reattaching audio never resubmits a task');
    assert.ok((await device('status')).devices[pair.id].connected);
    // Real gateway playback acknowledgments drive the shared hangup lifecycle.
    send({type:'response.output_audio.started',response_id:'device-goodbye'});
    send({type:'response.output_audio.delta',response_id:'device-goodbye',delta:Buffer.alloc(960).toString('base64')});
    send({type:'response.function_call_arguments.done',response_id:'device-goodbye',items:[{call_id:'device-hangup',name:'hang_up',arguments:'{}'}]});
    send({type:'response.output_audio.done',response_id:'device-goodbye'});
    await until(()=>providerInputs.flatMap(e=>e.items||[]).filter(i=>i.call_id==='device-hangup'),list=>list.length===1);
    await until(()=>client.packets.length,n=>n>0);
    assert.equal(client.socket.readyState,1,'the hangup receipt must not cut off device playback');
    const ended=once(client.socket,'close');client.send({type:'cardbush',action:'playback',speaking:false});await ended;
    assert.equal((await tasks()).length,1);
  } finally {
    client?.socket.terminate(); await management?.close(); await service?.close();
    for (const ws of voice.clients) ws.terminate(); await new Promise(resolve => voice.close(resolve));
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await remove(root);
  }
});
