import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireAgentDataLock } from '../dist-electron/agentDataLock.mjs';
import { waitForWebAgent } from '../dist-electron/webAgentStartup.mjs';
import { WebReadCache, webReadBytes } from '../dist-electron/webSessionReads.mjs';
import { webSessionHistory } from '../packages/bush-runtime/dist/webSessionHistory.js';
import { DockerTenantBroker } from '../dist-electron/webTenantBroker.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { FileSessionEventPersistence } from '../packages/bush-runtime/dist/fileSessionEventPersistence.js';
import { serveWeb } from '../dist-electron/webServer.mjs';
import ts from 'typescript';
import vm from 'node:vm';

async function fixture(t) {
  const base = resolve('tmp/agent-data-lock-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.ok(target.startsWith(await realpath(base) + sep));
    await rm(target, { recursive: true, force: true });
  }); return root;
}

test('a new conversation without committed history remains readable', () => {
  assert.deepEqual(webSessionHistory('new-session', [], { limit: 40 }), {
    snapshot: null, history: { nextCursor: null }, committedTurnIds: [],
  });
});

test('Agent history paging crosses the actual Runtime worker without a model request', async t => {
  const root = await fixture(t);
  let service = await AgentService.open({ dataRoot: root, toolsEnabled: false });
  try {
    const session = await service.call('sessions.create', { sessionId: 'session-page-fixture' });
    const page = await service.call('sessions.page', { sessionId: session.sessionId, limit: 1 });
    assert.equal(page.snapshot.sessionId, session.sessionId);
    assert.deepEqual(page.snapshot.turns, []);
    assert.equal(page.history.nextCursor, null);
    const missing = await service.call('sessions.page', { sessionId: 'missing-session', limit: 1 });
    assert.equal(missing.snapshot, null);
    assert.deepEqual(await service.call('chat.jobs', {}), []);
    await service.close();
    const journal = new FileSessionEventPersistence({ root: join(root, 'runtime-state', 'sessions') });
    try {
      let sequence = journal.load(session.sessionId).at(-1).sequence;
      for (let i = 1; i <= 2; i++) {
        const turnId = `fixture-turn-${i}`, createdAt = new Date().toISOString();
        journal.append({ protocol: 'bush.session_event.v1', eventId: `fixture-event-${i}`, sequence: ++sequence,
          sessionId: session.sessionId, createdAt, kind: 'turn_committed', payload: {
            turnId, turnSequence: i, createdAt, completedAt: createdAt, status: 'completed', reason: 'completed',
            messages: [{ messageId: `fixture-message-${i}`, turnId, turnSequence: i, messageIndex: 0, createdAt,
              message: { role: 'assistant', content: `saved-result-${i}` } }],
          } });
      }
    } finally { journal.close(); }
    service = await AgentService.open({ dataRoot: root, toolsEnabled: false });
    const latest = await service.call('sessions.page', { sessionId: session.sessionId, limit: 1 });
    assert.equal(latest.snapshot.turns[0].messages[0].message.content, 'saved-result-2');
    assert.deepEqual(latest.committedTurnIds, ['fixture-turn-1', 'fixture-turn-2']);
    const earlier = await service.call('sessions.page', { sessionId: session.sessionId, limit: 1, before: latest.history.nextCursor });
    assert.equal(earlier.snapshot.turns[0].messages[0].message.content, 'saved-result-1');
    assert.equal(earlier.history.nextCursor, null);
    assert.deepEqual(await service.call('chat.jobs', {}), []);
  } finally { await service.close(); }
});

test('same-PID leftovers recover, concurrent owners are rejected, release is idempotent', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'agent.lock'), String(process.pid));
  const release = await acquireAgentDataLock(root);
  await assert.rejects(acquireAgentDataLock(root), { code: 'AGENT_DATA_DIRECTORY_BUSY' });
  assert.equal(await readFile(join(root, 'agent.lock'), 'utf8'), String(process.pid));
  await release(); await release();
  const next = await acquireAgentDataLock(root); await next();
});

test('a live foreign legacy owner is protected and invalid locks are preserved', async t => {
  const root = await fixture(t), child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { windowsHide: true });
  t.after(() => child.kill()); await once(child.stdout, 'data');
  await writeFile(join(root, 'agent.lock'), String(child.pid));
  await assert.rejects(acquireAgentDataLock(root), { code: 'AGENT_DATA_DIRECTORY_BUSY' });
  assert.equal(await readFile(join(root, 'agent.lock'), 'utf8'), String(child.pid));
  await writeFile(join(root, 'agent.lock'), 'invalid-owner');
  await assert.rejects(acquireAgentDataLock(root), { code: 'AGENT_LOCK_INVALID' });
  assert.equal(await readFile(join(root, 'agent.lock'), 'utf8'), 'invalid-owner');
});

test('a killed process releases kernel ownership and its successor retains the data', async t => {
  const root = await fixture(t), module = pathToFileURL(resolve('dist-electron/agentDataLock.mjs')).href;
  const source = `const {acquireAgentDataLock}=await import(${JSON.stringify(module)});await acquireAgentDataLock(process.argv[1]);console.log('ready');setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { windowsHide: true });
  t.after(() => child.kill()); await once(child.stdout, 'data');
  await writeFile(join(root, 'preserved.txt'), 'existing conversation');
  await assert.rejects(acquireAgentDataLock(root), { code: 'AGENT_DATA_DIRECTORY_BUSY' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const release = await acquireAgentDataLock(root);
  assert.equal(await readFile(join(root, 'preserved.txt'), 'utf8'), 'existing conversation');
  await release();
});

test('readiness has a total deadline even when every health probe hangs', async () => {
  let attempts = 0;
  const client = { info(signal) { attempts++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  const started = Date.now(), keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(waitForWebAgent(client, AbortSignal.timeout(60), undefined, 20), { code: 'SESSION_AGENT_START_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - started < 1000); assert.ok(attempts <= 2);
});

test('known startup failures and missing policy do not keep retrying', async () => {
  let probes = 0;
  await assert.rejects(waitForWebAgent({ info: async () => { probes++; throw Error('offline'); } }, AbortSignal.timeout(1000),
    async () => ({ state: 'failed', code: 'SESSION_AGENT_DATA_LOCKED' })), { code: 'SESSION_AGENT_DATA_LOCKED' });
  assert.equal(probes, 1);
  await assert.rejects(waitForWebAgent({ info: async () => ({ capabilities: { webRestricted: false } }) }, AbortSignal.timeout(1000)),
    { code: 'SESSION_AGENT_POLICY_NOT_READY' });
});

test('history pages never read unselected message bodies or expose model-only replay', () => {
  const events = [{ kind: 'session_created', createdAt: '2026-11-09', payload: { metadata: { title: 'saved' } } }];
  for (let i = 0; i < 100; i++) events.push({ kind: 'turn_committed', createdAt: String(i), payload: {
    turnId: `turn-${i}`, turnSequence: i + 1, messages: [{ messageId: `message-${i}`, message: {
      role: 'assistant', content: `reply-${i}`, reasoningContent: 'private', providerReplay: { huge: 'x'.repeat(1000) },
    } }],
  } });
  Object.defineProperty(events[1].payload, 'messages', { get() { throw Error('Full history was read'); } });
  const head = webSessionHistory('session', events, { limit: 4 });
  assert.equal(head.history.nextCursor, 'turn-96'); assert.equal(head.snapshot.turns.length, 4);
  assert.equal(head.snapshot.turns[0].messages[0].message.reasoningContent, undefined);
  assert.equal(head.snapshot.turns[0].messages[0].message.providerReplay, undefined);
  const previous = webSessionHistory('session', events, { limit: 4, before: head.history.nextCursor });
  assert.deepEqual(previous.snapshot.turns.map(t => t.turnId), ['turn-92', 'turn-93', 'turn-94', 'turn-95']);
  assert.equal(webSessionHistory('session', events, { limit: 1, turnId: 'turn-99' }).snapshot.turns[0].turnId, 'turn-99');
  assert.throws(() => webSessionHistory('session', events, { limit: 4, before: 'missing' }), { code: 'SESSION_HISTORY_CHANGED' });
  assert.equal(events.at(-1).payload.messages[0].message.reasoningContent, 'private');
});

test('cache estimates do not serialize values; oversized results are not retained', async () => {
  const value = { content: 'x'.repeat(5000), toJSON() { throw Error('Duplicate serialization'); } };
  assert.equal(webReadBytes(value, 100), Infinity);
  const cache = new WebReadCache(() => 0, 100); let calls = 0;
  const load = async () => { calls++; return value; };
  assert.equal(await cache.get('owner:page', 5000, load), value);
  await cache.get('owner:page', 5000, load); assert.equal(calls, 2);
});

test('large history pages shrink with a stable cursor and oversize single turns fail before cloning', () => {
  const events = [{ kind: 'session_created', createdAt: 'now', payload: {} }];
  for (let i = 0; i < 4; i++) events.push({ kind: 'turn_committed', createdAt: 'now', payload: {
    turnId: `turn-${i}`, messages: [{ message: { role: 'assistant', content: 'x'.repeat(500_000) } }],
  } });
  const head = webSessionHistory('session', events, { limit: 4 });
  assert.equal(head.snapshot.turns.length, 2); assert.equal(head.history.nextCursor, 'turn-2');
  const previous = webSessionHistory('session', events, { limit: 4, before: head.history.nextCursor });
  assert.deepEqual(previous.snapshot.turns.map(t => t.turnId), ['turn-0', 'turn-1']);
  events.at(-1).payload.messages[0].message.content = 'x'.repeat(2_000_000);
  assert.throws(() => webSessionHistory('session', events, { limit: 1 }), { code: 'SESSION_HISTORY_TOO_LARGE' });
});

test('crash-loop cooldown prevents relaunches and new tenants have a finite restart policy', async () => {
  const key = 'a'.repeat(64), config = { secret: 's'.repeat(64), image: 'fixture', network: 'fixture', prefix: 'fixture-agent' };
  const existing = { Id: 'tenant', Image: 'fixture', State: 'exited', Names: ['tenant'], Labels: { 'cardbush.web.tenant': key } };
  const calls = [];
  class Broker extends DockerTenantBroker {
    constructor(items) { super(config); this.items = items; }
    async docker(method, path, body) {
      calls.push({ method, path, body });
      if (path.startsWith('/containers/json?')) return this.items;
      if (path.endsWith('/json')) return { RestartCount: 3, State: { Running: false, ExitCode: 1, FinishedAt: new Date().toISOString() } };
      if (path.includes('/logs?')) return 'AGENT_DATA_DIRECTORY_BUSY';
      if (path.startsWith('/containers/create?')) return { Id: 'new-tenant' };
    }
  }
  await assert.rejects(new Broker([existing]).ensure(key), { status: 503, message: 'SESSION_AGENT_DATA_LOCKED' });
  assert.equal(calls.some(c => c.method === 'POST'), false);
  calls.length = 0; await new Broker([]).ensure(key);
  const created = calls.find(c => c.path.startsWith('/containers/create?')).body;
  assert.deepEqual(created.HostConfig.RestartPolicy, { Name: 'on-failure', MaximumRetryCount: 3 });
  assert.equal(created.HostConfig.ReadonlyRootfs, true);
});

test('gateway history retrieval stays on bounded native pages and preserves pending jobs', async t => {
  const sessionId = 'web-'+'b'.repeat(40), token = 'k'.repeat(54), calls = [];
  const turns = Array.from({ length: 65 }, (_, i) => ({ turnId: `turn-${i}`, messages: [{ message: { role: 'assistant', content: `reply-${i}` } }] }));
  const conversation = { id: sessionId, title: 'preserved', pinned: false, archived: false };
  const store = { authenticate: async () => ({ id: 'alice', role: 'member', is_active: true }), conversation: async () => conversation };
  const agents = { close() {}, get: async () => ({ historyPaging: true, call: async (operation, input) => {
    calls.push({ operation, input });
    if (operation === 'sessions.get') throw Error('Unbounded history requested');
    if (operation === 'sessions.page') {
      const end = input.before ? turns.findIndex(t => t.turnId === input.before) : turns.length, start = Math.max(0, end-input.limit);
      return { snapshot: { turns: turns.slice(start,end) }, history: { nextCursor: start ? turns[start].turnId : null }, committedTurnIds: turns.map(t => t.turnId) };
    }
    if (operation === 'chat.jobs') return [{ id: 'old', turnId: 'turn-0', status: 'completed' }, { id: 'running', turnId: 'turn-66', status: 'running' }];
    return [];
  } }) };
  const server = await serveWeb({ origin: 'http://test', host: '127.0.0.1', port: 0, staticRoot: resolve('dist-web'), modelSecret: 'x'.repeat(64), models: [{ id: 'test' }], defaultModelId: 'test' }, store, agents);
  t.after(() => server.close());
  const request = query => fetch(`http://127.0.0.1:${server.port}/api/web/v1/sessions/${sessionId}?${query}`, { headers: { Cookie: 'cardbush_web='+token } }).then(r => r.json());
  const head = await request('limit=20');
  assert.equal(head.snapshot.turns.length,20); assert.deepEqual(head.jobs.map(j=>j.id),['running']);
  const older = await request('limit=20&before='+head.history.nextCursor);
  assert.equal(older.snapshot.turns.at(-1).turnId,'turn-44'); assert.equal(older.jobs.length,0);
  assert.equal(calls.filter(c=>c.operation==='sessions.page').length,2);
});

async function browserFunction(file, name, globals = {}) {
  const source = await readFile(resolve(file), 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(s => ts.isFunctionDeclaration(s) && s.name.text === name);
  assert.ok(fn);
  const context = vm.createContext({ exports: {}, ...globals });
  vm.runInContext(ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports[name];
}

test('stream failures reconnect from the last event cursor without submitting another task', async () => {
  const sources = [], timers = new Map(), frames = []; let timer = 0;
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.closed = true; }
    frame(value) { this.onmessage({ data: JSON.stringify(value) }); }
  }
  const watch = await browserFunction('web/api.ts', 'watch', { EventSource: Source,
    setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id),
    fetch: () => { throw Error('A reconnect must not submit a request'); },
  });
  const close = watch('session', 'original-turn', frame => frames.push(frame), 4);
  sources[0].frame({ type: 'event', event: { sequence: 5 } });
  sources[0].frame({ type: 'event', event: { sequence: 5 } });
  assert.equal(frames.length, 1);
  sources[0].frame({ type: 'error', error: 'offline' });
  assert.equal(sources[0].closed, true);
  [...timers.values()][0]();
  assert.match(sources[1].url, /afterSequence=5/); assert.match(sources[1].url, /original-turn/);
  sources[1].frame({ type: 'end' }); close();
  assert.equal(sources[1].closed, true);
});

test('stored submission receipts are reused only for identical content in the same conversation', async () => {
  const recover = await browserFunction('web/sessionService.ts', 'recoverSessionSubmission');
  const prior = { sessionId: 'a', requestId: '123e4567-e89b-12d3-a456-426614174000', text: 'make an image', modelId: 'model', attachments: ['upload-a'] };
  const current = { ...prior, requestId: '123e4567-e89b-12d3-a456-426614174001' };
  assert.equal(recover(prior, current).requestId, prior.requestId);
  for (const changed of [{ ...current, sessionId: 'b' }, { ...current, modelId: 'other' },
    { ...current, text: 'another image' }, { ...current, attachments: ['new-upload'] }]) {
    assert.equal(recover(prior, changed).requestId, changed.requestId);
  }
  assert.equal(recover({ ...prior, requestId: 'invalid' }, current).requestId, current.requestId);
});

test('browser image previews keep their file references without duplicating inline model images', () => {
  const image = { imageUrl: 'data:image/png;base64,'+'x'.repeat(2_000_000) };
  const message = { role: 'user', content: 'reference', images: [image] };
  const metadata = { attachments: [{ path: '/data/workspaces/uploads/reference.png', type: 'image' }] };
  const events = [{ kind: 'session_created', createdAt: 'now', payload: {} },
    { kind: 'turn_committed', createdAt: 'now', payload: { turnId: 'one', messages: [{ message, metadata }] } }];
  const page = webSessionHistory('session', events, { limit: 1 });
  assert.equal(page.snapshot.turns[0].messages[0].message.images, undefined);
  assert.equal(page.snapshot.turns[0].messages[0].metadata.attachments[0].path, metadata.attachments[0].path);
  assert.equal(message.images[0], image, 'Canonical model inputs must remain unchanged');
});
