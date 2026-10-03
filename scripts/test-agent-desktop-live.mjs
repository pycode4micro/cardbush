// Run explicitly inside the optional Linux image with its own X display.
// Uses a local fixture and temporary profiles; never calls a model or reads a user account.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentDesktop } from '../dist-electron/agentDesktop.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';

if (process.platform !== 'linux' || !process.env.DISPLAY) throw Error('Requires an isolated Linux test desktop.');
await readFile('/.dockerenv');
const root = await mkdtemp(join(tmpdir(), 'cardbush-desktop-live-'));
const checks = [];
const modelCalls = [];
const fixture = createServer(async (request, response) => {
  if (request.url.startsWith('/v1/')) {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url.endsWith('/input_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    modelCalls.push(body); const n = modelCalls.length;
    const action = n === 1 ? ['linux_browser_use', { action: 'open', url }]
      : n === 2 ? ['linux_computer_use', { action: 'observe' }] : null;
    const item = action ? { id: `function-${n}`, call_id: `call-${n}`, type: 'function_call', name: action[0], arguments: JSON.stringify(action[1]), status: 'completed' }
      : { id: `msg-${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verified.', annotations: [] }] };
    const value = { id: `resp-${n}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.created', response: value });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit(action ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'Verified.' });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...value, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } });
    response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html><body style="margin:100px;font:24px sans-serif"><h1>CardBush desktop verification</h1>
<input aria-label="Message" style="font:24px sans-serif"><button onclick="localStorage.setItem('test',document.querySelector('input').value);document.querySelector('output').textContent=localStorage.getItem('test')">Apply</button>
<output></output><script>document.querySelector('output').textContent=localStorage.getItem('test')||'new profile';</script></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
let desktop, service, listener;
try {
  desktop = await AgentDesktop.open(root, process.env);
  const tool = async (kind, input, sessionId = 'test-session', turnId = 'test-turn') => desktop.tool({ tool: kind, input, sessionId, turnId });
  let tabId = (await tool('browser', { action: 'open', url })).structuredContent.tabId;
  let state = (await tool('browser', { action: 'snapshot', tabId })).structuredContent;
  const field = state.elements.find(e => e.name === 'Message').element;
  await tool('browser', { action: 'fill', tabId, stateId: state.stateId, element: field, text: '浏览器中文' });
  await assert.rejects(tool('browser', { action: 'fill', tabId, stateId: state.stateId, element: field, text: 'stale' }), /stale/);
  checks.push('real DOM input and single-use observation');
  // Allow a completed browser paint before observing it; actions themselves are never retried.
  await new Promise(resolve => setTimeout(resolve, 200));
  state = (await tool('computer', { action: 'observe' })).structuredContent;
  await assert.rejects(tool('computer', { action: 'key', key: 'ctrl+a', stateId: state.stateId }, 'other-session'), /stale/);
  await tool('computer', { action: 'key', key: 'ctrl+a', stateId: state.stateId });
  await new Promise(resolve => setTimeout(resolve, 150));
  state = (await tool('computer', { action: 'observe' })).structuredContent;
  await tool('computer', { action: 'type', text: '跨工具中文验证', stateId: state.stateId });
  await new Promise(resolve => setTimeout(resolve, 150));
  state = (await tool('browser', { action: 'snapshot', tabId })).structuredContent;
  await tool('browser', { action: 'click', tabId, stateId: state.stateId, element: state.elements.find(e => e.name === 'Apply').element });
  state = (await tool('browser', { action: 'snapshot', tabId })).structuredContent;
  assert.match(state.text, /跨工具中文验证/);
  checks.push('Computer Use X11 keyboard and Unicode in the same visible browser');
  const lease = await desktop.call('take', {});
  await assert.rejects(tool('computer', { action: 'observe' }), /user has taken control/);
  await assert.rejects(tool('browser', { action: 'tabs' }), /user has taken control/);
  await assert.rejects(desktop.call('take', {}), /Another viewer/);
  const frame = await desktop.call('frame', { token: lease.token });
  assert.equal(frame.width, 1600); assert.equal(frame.height, 900);
  const jpeg = Buffer.from(frame.data, 'base64');
  assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.ok(jpeg.length > 10000);
  if (process.env.CARDBUSH_TEST_SCREENSHOT) await writeFile(process.env.CARDBUSH_TEST_SCREENSHOT, jpeg);
  await assert.rejects(desktop.call('input', { token: lease.token, frameId: frame.frameId, event: { action: 'click', x: 1600, y: 0 } }), /outside/);
  await desktop.call('input', { token: lease.token, frameId: frame.frameId, event: { action: 'click', x: 80, y: 200 } });
  await desktop.call('release', { token: lease.token });
  assert.ok((await tool('browser', { action: 'tabs' })).structuredContent.tabs.some(t => t.tabId === tabId));
  checks.push('original JPEG, bounds, exclusive takeover, both tools blocked, browser survives return');
  await desktop.close(); desktop = await AgentDesktop.open(root, process.env);
  tabId = (await tool('browser', { action: 'open', url })).structuredContent.tabId;
  state = (await tool('browser', { action: 'snapshot', tabId })).structuredContent;
  assert.match(state.text, /跨工具中文验证/);
  checks.push('browser profile survives worker shutdown and restart');
  await desktop.close(); desktop = undefined;

  service = await AgentService.open({ dataRoot: join(root, 'service'), desktop: true });
  const token = randomBytes(32).toString('hex');
  listener = await serveAgentHttp(service, { port: 0, token });
  const endpoint = `http://127.0.0.1:${listener.port}/api/agent/v1`;
  assert.equal((await fetch(endpoint + '/info')).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(endpoint + '/info', { headers: { ...headers, origin: 'null' } })).status, 401);
  const info = await (await fetch(endpoint + '/info', { headers })).json();
  assert.equal(info.capabilities.desktop, true); assert.equal(info.capabilities.browserUi, true); assert.equal(info.capabilities.computerUse, true);
  const call = async (operation, input = {}) => {
    const response = await fetch(endpoint + '/call', { method: 'POST', headers, body: JSON.stringify({ operation, input }) });
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error?.message);
    return payload.result;
  };
  assert.equal((await call('desktop.status')).available, true);
  const owned = await call('desktop.take');
  const screen = await call('desktop.frame', { token: owned.token });
  await call('desktop.input', { token: owned.token, frameId: screen.frameId, event: { action: 'key', key: 'Escape' } });
  await call('desktop.release', { token: owned.token });
  assert.equal((await call('desktop.status')).control, 'agent');
  checks.push('real Agent HTTP authentication, Origin rejection, capabilities, frame and manual input');
  await call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [
    { id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'test-fixture-only', baseURL: url + 'v1' },
  ] } });
  await call('sessions.create', { sessionId: 'desktop-loop' });
  const job = await call('chat.send', { sessionId: 'desktop-loop', requestId: 'live-desktop-loop', text: 'Run the isolated desktop fixture.', modelId: 'fixture', permissionMode: 'all_free', visionEnabled: true, language: 'en' });
  const deadline = Date.now() + 45000;
  let stateOfJob;
  while (Date.now() < deadline) {
    stateOfJob = (await call('chat.jobs')).find(item => item.id === job.id);
    if (['completed', 'failed', 'stopped'].includes(stateOfJob?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(stateOfJob?.status, 'completed', JSON.stringify(stateOfJob));
  const executions = await call('runtime.command', { kind: 'runtime.list_turn_tool_executions', payload: { sessionId: 'desktop-loop', turnId: job.turnId } });
  const results = executions.map(execution => JSON.stringify(execution.result));
  assert.ok(results.some(value => value.includes('tabId')), 'Runtime Browser Use returned a real tab');
  assert.ok(results.some(value => value.includes('desktop_pixels')), 'Runtime Computer Use returned a real desktop observation');
  assert.ok(modelCalls.length >= 3, 'tool results returned to the deterministic model fixture');
  assert.ok(modelCalls.some(body => JSON.stringify(body).includes('data:image/')),
    `real screenshot reaches provider: ${JSON.stringify(modelCalls.map(body => ({
      types: body.input?.map(item => item.type),
      imageStates: [...new Set(JSON.stringify(body).match(/vision_disabled|attachment_budget|image_input_\w+|input_image|data:image/g) || [])],
    })))}`);
  checks.push('real Agent loop → private host bridge → both Linux tools → screenshot returned to local model fixture');
  console.log(JSON.stringify({ ok: true, checks }));
} finally {
  await listener?.close();
  await service?.close();
  await desktop?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(root, { recursive: true, force: true });
}
