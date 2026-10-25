import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentService } from '../dist-electron/agentService.mjs';
import { openLocalChatClient } from '../dist-electron/agentLocalChat.mjs';

const preload = new URL('./helpers/local-runtime-fault.mjs', import.meta.url).href;
const exists = path => readFile(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(40); }
  assert.fail('Lifecycle condition timed out');
}
async function fixture(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'local-lifecycle-test-'));
  const dataRoot = join(root, 'data'), profileRoot = join(root, 'profile');
  const cleanup = [];
  await mkdir(profileRoot);
  t.after(async () => {
    for (const close of cleanup) await close();
    assert.ok(root.startsWith(parent + sep + 'local-lifecycle-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, dataRoot, profileRoot, descriptor: join(dataRoot, 'local-runtime', 'host.json'), cleanup };
}

test('failed worker retires an attached local host; reconnect elects one healthy owner without replay', { timeout: 60000 }, async t => {
  const f = await fixture(t), trigger = join(f.root, 'exit-worker');
  let generations = 0;
  const model = createServer(async (request, response) => {
    request.setEncoding('utf8'); let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.endsWith('/input_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
    const input = JSON.parse(raw); generations++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ type:'response.created',response:{id:'held',object:'response',model:input.model,status:'in_progress',store:false,output:[]} })}\n\n`);
    // Leave this real provider stream pending until the worker is terminated.
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const savedOptions = process.env.NODE_OPTIONS, savedTrigger = process.env.CARDBUSH_TEST_WORKER_EXIT;
  process.env.NODE_OPTIONS = `--import=${preload}`; process.env.CARDBUSH_TEST_WORKER_EXIT = trigger;
  let client; const owners = [];
  try {
    client = await openLocalChatClient(f);
    const owner = JSON.parse(await readFile(f.descriptor, 'utf8')); owners.push(owner.pid);
    const session = await client.call('sessions.create', {});
    await client.call('product.command', { kind:'models.update',config:{defaultModelId:'fixture',models:[{
      id:'fixture',provider:'openai',model:'fixture',apiKey:'isolated-test-secret',baseURL:`http://127.0.0.1:${model.address().port}/v1`,
    }]} });
    await client.call('chat.send', { sessionId:session.sessionId,requestId:'interrupted-once',text:'wait for the fixture',modelId:'fixture',permissionMode:'task_free',language:'en' });
    await until(() => generations === 1);
    await writeFile(trigger, 'terminate this fixture worker');
    await until(() => !alive(owner.pid)); // Keep the lease attached throughout.
    assert.equal(await exists(f.descriptor), false);
    assert.equal(await exists(join(f.dataRoot, 'agent.lock')), false);
    assert.match(await readFile(join(f.dataRoot, 'logs', 'runtime.log'), 'utf8'), /worker failed; shutting down/);
    await rm(trigger);
    await Promise.all([client.reconnect(), client.reconnect()]);
    const next = JSON.parse(await readFile(f.descriptor, 'utf8')); owners.push(next.pid);
    assert.notEqual(next.pid, owner.pid);
    assert.ok((await client.call('sessions.list', { projection: 'summary' })).some(row => row.sessionId === session.sessionId));
    const jobs = await client.call('chat.jobs', {});
    assert.equal(jobs.length, 1);
    assert.ok(['failed','stopped','interrupted'].includes(jobs[0].status), JSON.stringify(jobs));
    assert.equal(generations, 1, 'reconnect never replays the interrupted generation');
    await client.close(); client = undefined;
    await until(() => !alive(next.pid));
    assert.equal(await exists(join(f.dataRoot, 'agent.lock')), false);
  } finally {
    if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions;
    if (savedTrigger === undefined) delete process.env.CARDBUSH_TEST_WORKER_EXIT; else process.env.CARDBUSH_TEST_WORKER_EXIT = savedTrigger;
    await client?.close();
    for (const pid of owners) if (alive(pid)) { process.kill(pid); await until(() => !alive(pid)); }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  }
});

test('worker failure during startup cannot publish a dead endpoint or retain the data lock', { timeout: 60000 }, async t => {
  const f = await fixture(t), messages = [];
  const child = fork(resolve('dist-electron/agentLocalRuntimeHost.mjs'), [f.dataRoot, f.profileRoot, resolve('assets')], {
    env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, CARDBUSH_TEST_EXIT_DURING_STARTUP: '1' },
    execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  child.on('message', message => messages.push(message));
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1, stderr);
  assert.equal(messages.some(message => message.ready), false);
  assert.equal(await exists(f.descriptor), false);
  assert.equal(await exists(join(f.dataRoot, 'agent.lock')), false);
});

test('cleanup failures still terminate the worker and release the lock, with one result for all callers', { timeout: 60000 }, async t => {
  const f = await fixture(t), service = await AgentService.open({ dataRoot: f.dataRoot, toolsEnabled: false });
  const maintenance = service.product.stopMaintenance.bind(service.product), runtimeClose = service.runtime.close.bind(service.runtime);
  let maintenanceCalls = 0, runtimeCalls = 0;
  service.product.stopMaintenance = async () => { maintenanceCalls++; await maintenance(); throw new Error('injected maintenance cleanup failure'); };
  service.runtime.close = async () => { runtimeCalls++; await runtimeClose(); throw new Error('injected post-termination failure'); };
  f.cleanup.push(async () => { await runtimeClose(); });
  const first = service.close(), second = service.close();
  assert.equal(first, second);
  await assert.rejects(first, error => error instanceof AggregateError && error.errors.length === 2
    && error.errors.some(item => /injected maintenance/.test(item.message)));
  assert.equal(service.close(), first);
  assert.equal(maintenanceCalls, 1); assert.equal(runtimeCalls, 1);
  assert.equal(await exists(join(f.dataRoot, 'agent.lock')), false);
  // A fresh service must be able to take ownership immediately.
  const reopened = await AgentService.open({ dataRoot: f.dataRoot, toolsEnabled: false });
  await reopened.close();
});

test('concurrent close waits for in-flight cleanup instead of returning early', { timeout: 60000 }, async t => {
  const f = await fixture(t), service = await AgentService.open({ dataRoot: f.dataRoot, toolsEnabled: false });
  const maintenance = service.product.stopMaintenance.bind(service.product);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { reached = resolve; });
  service.product.stopMaintenance = async () => { reached(); await gate; await maintenance(); };
  f.cleanup.push(async () => { release(); await service.close(); });
  const first = service.close(); await entered;
  const second = service.close(); assert.equal(first, second);
  let finished = false; void second.then(() => { finished = true; });
  await delay(30); assert.equal(finished, false);
  assert.equal(await exists(join(f.dataRoot, 'agent.lock')), true);
  release(); await Promise.all([first, second]);
  assert.equal(await exists(join(f.dataRoot, 'agent.lock')), false);
});
