import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AgentHttpClient } from '../dist-electron/agentHttpClient.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { runRemoteSubagent } from '../dist-electron/remoteSubagent.mjs';

const tempRoot = resolve('tmp/agent-service-tests');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 12000) {
  const start = Date.now(); let value;
  while (Date.now() - start < timeout) { value = await read(); if (predicate(value)) return value; await pause(30); }
  assert.fail(`Timed out: ${JSON.stringify(value)}`);
}
async function directory(t) {
  await mkdir(tempRoot, { recursive: true }); const root = await mkdtemp(join(tempRoot, 'agent-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(tempRoot + '\\') || resolve(root).startsWith(tempRoot + '/')); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); });
  return root;
}
async function modelFixture(t, delay = 80, toolPath) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 })); return; }
    calls.push(body); const n = calls.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const item = toolPath && n === 1
      ? { id: 'function-1', call_id: 'call-1', type: 'function_call', name: typeof toolPath === 'string' ? 'read_file' : toolPath.name, arguments: JSON.stringify(typeof toolPath === 'string' ? { path: toolPath } : toolPath.arguments), status: 'completed' }
      : { id: `msg_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer-${n}`, annotations: [] }] };
    const response = { id: `resp_${n}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    await pause(delay);
    if (res.destroyed) return;
    emit(item.type === 'function_call'
      ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
      : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: `answer-${n}` });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, url: `http://127.0.0.1:${server.address().port}/v1` };
}
async function openService(t, name = 'fixture', delay = 80, tool) {
  const root = await directory(t); const model = await modelFixture(t, delay, tool);
  const service = await AgentService.open({ dataRoot: root, name, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
  // Cleanup hooks execute in registration order; close before removing the root.
  t.after(() => service.close());
  await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture', models: [{ id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'fixture-secret', baseURL: model.url }] } });
  return { root, model, service };
}
const input = (sessionId, requestId, text = requestId) => ({ sessionId, requestId, text, modelId: 'fixture', permissionMode: 'task_free', language: 'en' });

test('conversation presentation survives restart and stays independent of active Runtime metadata', async t => {
  const f = await openService(t, 'presentation', 500); let service = f.service;
  try {
    await service.call('sessions.create', { sessionId: 'presentation', title: '新对话' });
    const job = await service.call('chat.send', input('presentation', 'first-title', '帮我检查服务器日志'));
    await until(() => f.model.calls.length, count => count === 1);
    assert.equal((await service.call('sessions.list'))[0].metadata.title, '帮我检查服务器日志');
    const raw = await service.call('runtime.command', { kind: 'runtime.get_session', payload: { sessionId: 'presentation' } });
    await service.call('sessions.rename', { sessionId: 'presentation', title: '自定义标题' });
    await service.call('sessions.update', { sessionId: 'presentation', pinned: true, archived: true, forcedUnread: true, readAt: '2026-09-01T00:00:00.000Z' });
    const after = await service.call('runtime.command', { kind: 'runtime.get_session', payload: { sessionId: 'presentation' } });
    assert.deepEqual(after.metadata, raw.metadata, 'presentation does not mutate active model metadata');
    assert.equal(after.revision, raw.revision);
    const done = await until(() => service.call('chat.jobs'), jobs => jobs[0].status === 'completed');
    assert.ok(Date.parse(done[0].startedAt) >= Date.parse(done[0].createdAt));
    assert.ok(Date.parse(done[0].completedAt) >= Date.parse(done[0].startedAt));
    assert.equal(done[0].turnId, job.turnId);
    await service.close(); service = await AgentService.open({ dataRoot: f.root });
    const restored = await service.call('sessions.get', { sessionId: 'presentation' });
    assert.equal(restored.metadata.title, '自定义标题'); assert.equal(restored.metadata.pinned, true); assert.equal(restored.metadata.archived, true); assert.equal(restored.metadata.forcedUnread, true);
    await service.call('sessions.update', { sessionId: 'presentation', archived: false, forcedUnread: false });
    const fork = await service.call('sessions.fork', { sessionId: 'presentation' });
    assert.equal(fork.turns.length, 1); assert.equal(fork.metadata.forkSourceSessionId, 'presentation');
    assert.equal(fork.turns[0].cacheChainState, undefined, 'a server-side conversation fork has its own cache chain');
    assert.notEqual(fork.metadata.runtimeWorkspace.workspaceDir, restored.metadata.runtimeWorkspace.workspaceDir);
    assert.equal((await service.call('sessions.get', { sessionId: 'presentation' })).metadata.archived, false);
    await service.call('sessions.create', { sessionId: 'legacy-title', title: 'New conversation' });
    await service.call('chat.send', input('legacy-title', 'legacy-job', '恢复已有会话的标题'));
    await until(() => service.call('chat.jobs'), jobs => jobs.find(job => job.id === 'legacy-job')?.status === 'completed');
    assert.equal((await service.call('sessions.get', { sessionId: 'legacy-title' })).metadata.title, '恢复已有会话的标题');
  } finally { await service.close(); }
});

test('server review uses Runtime evidence, protects active work and supports revert and restore', async t => {
  const f = await openService(t, 'review', 300, { name: 'write_file', arguments: { path: 'review-test.txt', content: 'server review content\n' } });
  try {
    const session = await f.service.call('sessions.create', { sessionId: 'review' });
    const job = await f.service.call('chat.send', input('review', 'review-write', 'Create review-test.txt'));
    const command = kind => f.service.call('runtime.command', { kind, payload: { sessionId: 'review', turnIds: [job.turnId] } });
    await assert.rejects(command('runtime.revert_workspace_changes'), /finish|stop/);
    await assert.rejects(f.service.call('sessions.fork', { sessionId: 'review' }), /finish|stop/);
    await until(() => f.service.call('chat.jobs'), jobs => jobs[0].status === 'completed');
    const target = join(session.metadata.runtimeWorkspace.workspaceDir, 'review-test.txt');
    assert.equal(await readFile(target, 'utf8'), 'server review content\n');
    const page = await f.service.call('files.list', { sessionId: 'review' });
    assert.ok(page.entries.some(entry => entry.path === target));
    await assert.rejects(f.service.call('files.list', { sessionId: 'review', directoryPath: f.root }), /outside/);
    const records = await f.service.call('runtime.command', { kind: 'runtime.list_turn_tool_executions', payload: { sessionId: 'review', turnId: job.turnId } });
    assert.ok(records.some(record => record.workspaceChanges.some(change => change.path === target)), 'review evidence belongs to the server file');
    await command('runtime.revert_workspace_changes');
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    await command('runtime.restore_workspace_changes');
    assert.equal(await readFile(target, 'utf8'), 'server review content\n');
    await writeFile(target, 'user edit after completion\n');
    await assert.rejects(command('runtime.revert_workspace_changes'), /changed|conflict|revision|修改|不匹配/i);
    assert.equal(await readFile(target, 'utf8'), 'user edit after completion\n', 'revert does not overwrite subsequent user edits');
  } finally { await f.service.close(); }
});

test('remote subagent HTTP bridge deduplicates uncertain acknowledgement, returns results and resumes', async t => {
  const f = await openService(t, 'delegate', 80, { name: 'subagent', arguments: { prompt: 'nested child' } }); const token = 'remote-delegation-test-token-1234567890';
  const http = await serveAgentHttp(f.service, { port: 0, token });
  const manager = new AgentConnectionManager(join(f.root, 'connections.json'), { encrypt: value => value, decrypt: value => value });
  try {
    const [connection] = await manager.save({ name: 'Server', transport: 'http', url: `http://127.0.0.1:${http.port}`, token });
    const realCall = manager.call.bind(manager); let loseAck = true;
    manager.call = async (...args) => { const value = await realCall(...args); if (args[1] === 'delegation.submit' && loseAck) { loseAck = false; throw new TypeError('lost acknowledgement'); } return value; };
    const request = { connectionId: connection.id, agentId: f.service.info().id, taskId: 'test-remote-1', sessionId: 'delegated-test-remote-1', turnId: 'turn-test-remote-1', parentSessionId: 'parent', parentTurnId: 'parent-turn', prompt: 'Review this server', permissionMode: 'task_free', language: 'en' };
    const result = await runRemoteSubagent(manager, request);
    assert.equal(result.status, 'completed'); assert.match(result.finalResponse, /answer-2/);
    assert.equal(f.model.calls.length, 2, 'uncertain acknowledgement cannot execute twice');
    assert.match(JSON.stringify(f.model.calls[1].input), /child_agent_tool_disabled|child.*(?:cannot|disabled)|子.*(?:禁止|不能)/i, 'child delegation is denied at execution');
    const session = await realCall(connection.id, 'sessions.get', { sessionId: request.sessionId });
    assert.ok(session.metadata.runtimeWorkspace.workspaceDir.startsWith(f.root));
    assert.equal(session.metadata.delegationOwner, 'parent');
    await assert.rejects(realCall(connection.id, 'delegation.submit', { ...Object.fromEntries(Object.entries(request).filter(([key]) => !['connectionId', 'agentId'].includes(key))), prompt: 'different' }), /different content/);
    const resumed = await runRemoteSubagent(manager, { ...request, taskId: 'test-remote-2', turnId: 'turn-test-remote-2', prompt: 'Continue review' });
    assert.equal(resumed.status, 'completed'); assert.equal(f.model.calls.length, 3);
    const continued = await realCall(connection.id, 'sessions.get', { sessionId: request.sessionId });
    assert.equal(continued.turns.length, 2);
    assert.equal(continued.turns[1].cacheChainState.requestOrdinal, continued.turns[0].cacheChainState.requestOrdinal + 1);
    const continuedEvents = await realCall(connection.id, 'chat.events', { sessionId: request.sessionId, turnId: 'turn-test-remote-2', waitMs: 1 });
    const observations = continuedEvents.events.filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind));
    assert.ok(observations.some(event => event.kind === 'provider_input_observed'));
    assert.ok(observations.every(event => !event.payload.frozenPrefixBreak), 'resuming a remote child preserves its own Runtime and provider input prefixes');
    await assert.rejects(runRemoteSubagent(manager, { ...request, taskId: 'test-remote-3', turnId: 'turn-test-remote-3', parentSessionId: 'someone-else' }), /another parent/);
  } finally { await manager.close(); await http.close(); await f.service.close(); }
});

test('server CacheChain survives conversation reads, metadata rename, subsequent turns and process restart', async t => {
  const f = await openService(t, 'cache-chain'); let service = f.service;
  const run = async requestId => {
    const submitted = await service.call('chat.send', input('cache-session', requestId));
    await until(() => service.call('chat.jobs', { sessionId: 'cache-session' }), jobs => jobs.find(job => job.id === requestId)?.status === 'completed');
    const events = await service.call('chat.events', { sessionId: 'cache-session', turnId: submitted.turnId, waitMs: 1 });
    const observations = events.events.filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind));
    assert.equal(observations.length, 2);
    assert.ok(observations.every(event => !event.payload.frozenPrefixBreak), JSON.stringify(observations.map(event => ({ kind: event.kind, payload: event.payload }))));
    return service.call('sessions.get', { sessionId: 'cache-session' });
  };
  try {
    await service.call('sessions.create', { sessionId: 'cache-session', title: 'Cache test' });
    const first = await run('cache-first');
    await service.call('sessions.get', { sessionId: 'cache-session' });
    await service.call('sessions.rename', { sessionId: 'cache-session', title: 'New UI title' });
    const second = await run('cache-second');
    assert.equal(second.turns[1].cacheChainState.requestOrdinal, first.turns[0].cacheChainState.requestOrdinal + 1);
    await service.close();
    service = await AgentService.open({ dataRoot: f.root });
    const third = await run('cache-third');
    assert.equal(third.turns[2].cacheChainState.requestOrdinal, second.turns[1].cacheChainState.requestOrdinal + 1);
  } finally { await service.close(); }
});

test('remote cancellation waits for the server task to stop', async t => {
  const f = await openService(t, 'cancel', 3000); const token = 'remote-cancel-test-token-1234567890123';
  const http = await serveAgentHttp(f.service, { port: 0, token });
  const manager = new AgentConnectionManager(join(f.root, 'connections.json'), { encrypt: value => value, decrypt: value => value });
  try {
    const [connection] = await manager.save({ name: 'Server', transport: 'http', url: `http://127.0.0.1:${http.port}`, token });
    const abort = new AbortController();
    const result = runRemoteSubagent(manager, { connectionId: connection.id, taskId: 'cancel-remote', sessionId: 'delegated-cancel-remote', turnId: 'turn-cancel-remote', parentSessionId: 'parent', parentTurnId: 'turn', prompt: 'work', permissionMode: 'task_free', language: 'en' }, abort.signal);
    await until(() => f.service.call('chat.jobs'), jobs => jobs.some(job => job.status === 'running'));
    abort.abort();
    assert.equal((await result).status, 'stopped');
    assert.equal((await f.service.call('chat.jobs'))[0].status, 'stopped');
  } finally { await manager.close(); await http.close(); await f.service.close(); }
});

test('conversation files transfer in chunks, reject conflicting retries and stay in their workspace', async t => {
  const f = await openService(t);
  try {
    const session = await f.service.call('sessions.create', { sessionId: 'files' });
    const uploadId = randomUUID(); const content = Buffer.alloc(512 * 1024, 65).toString('base64');
    const chunk = { sessionId: 'files', uploadId, name: 'note.txt', offset: 0, content };
    const first = await f.service.call('files.upload', chunk);
    assert.equal((await f.service.call('files.upload', chunk)).path, first.path);
    await assert.rejects(f.service.call('files.upload', { ...chunk, content: Buffer.from('different').toString('base64') }), /offset conflict/);
    await f.service.call('files.upload', { ...chunk, offset: 512 * 1024, content: Buffer.from('尾部').toString('base64') });
    assert.equal((await f.service.call('files.read', { sessionId: 'files', path: first.path })).done, false);
    const tail = await f.service.call('files.read', { sessionId: 'files', path: first.path, offset: 512 * 1024 });
    assert.equal(Buffer.from(tail.content, 'base64').toString(), '尾部'); assert.equal(tail.done, true);
    await assert.rejects(f.service.call('files.upload', { ...chunk, name: '../escape' }));
    await assert.rejects(f.service.call('files.read', { sessionId: 'files', path: join(f.root, 'agent.json') }), /outside/);
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(session.metadata.runtimeWorkspace.workspaceDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.service.call('files.read', { sessionId: 'files', path: 'escape/secret.txt' }), /outside/);
  } finally { await f.service.close(); }
});

test('a missing local listener explains the tunnel dependency and can be retried after recovery', async t => {
  const root = await directory(t);
  const info = { protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'], id: 'recovered-agent', name: 'Recovery', platform: 'linux', capabilities: { durableQueue: true } };
  const server = createServer((_req, res) => { res.setHeader('x-cardbush-agent-id', info.id); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(info)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const manager = new AgentConnectionManager(join(root, 'connections.json'), { encrypt: value => value, decrypt: value => value });
  try {
    const [connection] = await manager.save({ name: 'Recovery', transport: 'http', url: `http://127.0.0.1:${port}`, token: 'private-fixture-token' });
    await assert.rejects(manager.connect(connection.id), error => {
      assert.match(error.message, /ECONNREFUSED/);
      assert.match(error.message, /本机隧道/);
      assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
      assert.doesNotMatch(error.message, /private-fixture-token|fetch failed/);
      return true;
    });
    assert.equal((await manager.list())[0].connected, false);
    server.listen(port, '127.0.0.1'); await once(server, 'listening');
    assert.equal((await manager.connect(connection.id)).id, info.id);
    assert.equal((await manager.list())[0].connected, true);
  } finally { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('Agent network errors keep actionable causes without leaking credentials or retrying commands', async t => {
  const failures = [
    [new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('private cause'), { code: 'ECONNREFUSED' })]) }), /连接被拒绝.*ECONNREFUSED/],
    [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), /域名.*ENOTFOUND/],
    [new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), /超时.*UND_ERR_CONNECT_TIMEOUT/],
    [new DOMException('timeout', 'TimeoutError'), /超时.*ETIMEDOUT/],
    [new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }), /证书.*CERT_HAS_EXPIRED/],
    [new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }), /连接中断.*UND_ERR_SOCKET/],
    [new TypeError('private unknown error', { cause: { code: 'SECRET-RAW-CODE' } }), /网络请求失败/],
  ];
  let failure, requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { requests++; init.signal.throwIfAborted(); throw failure; });
  const client = new AgentHttpClient('https://example.invalid/private-route/', 'private-token');
  try {
    for (const [error, pattern] of failures) {
      failure = error; const before = requests;
      await assert.rejects(client.call('chat.send', { text: 'private-message' }), caught => {
        assert.match(caught.message, pattern);
        assert.match(caught.message, /https:\/\/example.invalid/);
        assert.doesNotMatch(caught.message, /private|SECRET-RAW-CODE|SSH 隧道接入.*本机隧道/);
        assert.equal(caught.cause, failure);
        return true;
      });
      assert.equal(requests, before + 1, 'failed commands must never replay automatically');
    }
    const abort = new AbortController(); const reason = new DOMException('cancelled', 'AbortError'); abort.abort(reason);
    await assert.rejects(async () => { for await (const _ of client.events({ sessionId: 'session', turnId: 'turn' }, abort.signal)) {} }, error => error === reason);
  } finally { client.close(); }
});

test('headless service uses existing Runtime, private directories and durable sessions', async t => {
  const f = await openService(t);
  try {
    assert.equal(f.service.info().capabilities.computerUse, false);
    const session = await f.service.call('sessions.create', { sessionId: 'chat-one' });
    assert.equal(session.sessionId, 'chat-one');
    assert.ok(session.metadata.runtimeWorkspace.workspaceDir.startsWith(f.root));
    const submitted = await f.service.call('chat.send', input('chat-one', 'send-one'));
    const jobs = await until(() => f.service.call('chat.jobs'), jobs => jobs[0]?.status === 'completed');
    assert.equal(jobs[0].id, submitted.id);
    const snapshot = await f.service.call('sessions.get', { sessionId: 'chat-one' });
    assert.equal(snapshot.turns.length, 1);
    assert.ok(snapshot.turns[0].messages.some(item => item.message.content === 'answer-1'));
    const payload = JSON.stringify(f.model.calls[0]);
    assert.match(payload, /independent headless/);
    assert.doesNotMatch(payload, /mcp__computer_use|mcp__chrome_devtools/);
    const events = await f.service.call('chat.events', { sessionId: 'chat-one', turnId: submitted.turnId, waitMs: 500 });
    assert.equal(events.ended, true);
    assert.ok(events.events.some(item => item.kind === 'assistant_segment_delta'));
    const replay = await f.service.call('chat.events', { sessionId: 'chat-one', turnId: submitted.turnId, afterSequence: events.events[0].sequence, waitMs: 500 });
    assert.ok(replay.events.every(item => item.sequence > events.events[0].sequence));
    const config = await f.service.call('product.command', { kind: 'models.get' });
    assert.equal(config.models[0].apiKey, '');
    assert.doesNotMatch(JSON.stringify(config), /fixture-secret/);
    const identity = f.service.info().id;
    await f.service.close();
    const reopened = await AgentService.open({ dataRoot: f.root });
    try { assert.equal(reopened.info().id, identity); assert.equal((await reopened.call('sessions.get', { sessionId: 'chat-one' })).turns.length, 1);
      assert.equal((await reopened.call('chat.send', input('chat-one', 'send-one'))).turnId, submitted.turnId);
      assert.equal(f.model.calls.length, 1);
    }
    finally { await reopened.close(); }
  } finally { await f.service.close(); }
});

test('send retries deduplicate, same-session messages queue, and directory switches honor admission', async t => {
  const f = await openService(t, 'queue', 300);
  try {
    const p1 = join(f.root, 'project-one'), p2 = join(f.root, 'project-two'); await mkdir(p1); await mkdir(p2);
    const project = await f.service.call('projects.save', { name: 'one', path: p1 });
    const second = await f.service.call('projects.save', { name: 'two', path: p2 });
    await f.service.call('sessions.create', { sessionId: 'queue' });
    const sends = await Promise.all(Array.from({ length: 5 }, () => f.service.call('chat.send', input('queue', 'same'))));
    assert.equal(new Set(sends.map(item => item.turnId)).size, 1);
    await assert.rejects(f.service.call('chat.send', input('queue', 'same', 'different')), /different content/);
    await f.service.call('chat.send', input('queue', 'next'));
    await assert.rejects(f.service.call('sessions.bind', { sessionId: 'queue', projectId: second.id }), /finish/);
    await until(() => f.service.call('chat.jobs'), jobs => jobs.length === 2 && jobs.every(job => job.status === 'completed'));
    assert.equal(f.model.calls.length, 2);
    const snapshot = await f.service.call('sessions.get', { sessionId: 'queue' });
    assert.equal(snapshot.metadata.projectId, project.id);
    await f.service.call('sessions.bind', { sessionId: 'queue', projectId: second.id });
    await f.service.call('chat.send', input('queue', 'after-switch'));
    await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1).status === 'completed');
    assert.ok(JSON.stringify(f.model.calls.at(-1)).includes(p2.replaceAll('\\', '\\\\')));
    await assert.rejects(AgentService.open({ dataRoot: f.root }), /already owns/);
  } finally { await f.service.close(); }
});

test('HTTP requires authentication, rejects browser origins, survives disconnect and isolates Agents', async t => {
  const a = await openService(t, 'A', 600), b = await openService(t, 'B');
  const token = 'test-token-'.padEnd(48, 'x');
  const httpA = await serveAgentHttp(a.service, { port: 0, token }); const httpB = await serveAgentHttp(b.service, { port: 0, token });
  const urlA = `http://127.0.0.1:${httpA.port}`, urlB = `http://127.0.0.1:${httpB.port}`;
  const manager = new AgentConnectionManager(join(a.root, 'client-connections.json'), { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  try {
    assert.equal((await fetch(urlA)).status, 401);
    assert.equal((await fetch(urlA, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.invalid' } })).status, 401);
    await manager.save({ name: 'A', transport: 'http', url: urlA, token });
    const [ca, cb] = await manager.save({ name: 'B', transport: 'http', url: urlB, token });
    assert.notEqual((await manager.connect(ca.id)).id, (await manager.connect(cb.id)).id);
    await manager.call(ca.id, 'sessions.create', { sessionId: 'same-chat' }); await manager.call(cb.id, 'sessions.create', { sessionId: 'same-chat' });
    const job = await manager.call(ca.id, 'chat.send', input('same-chat', 'over-http'));
    await manager.disconnect(ca.id);
    await until(() => a.service.call('chat.jobs'), jobs => jobs[0]?.status === 'completed');
    assert.equal((await manager.call(cb.id, 'sessions.get', { sessionId: 'same-chat' })).turns.length, 0);
    assert.equal((await manager.call(ca.id, 'sessions.get', { sessionId: 'same-chat' })).turns.length, 1);
    assert.equal((await manager.call(ca.id, 'chat.send', input('same-chat', 'over-http'))).turnId, job.turnId);
    assert.equal(a.model.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(await manager.list()), new RegExp(token));
    await assert.rejects(manager.save({ name: 'insecure', transport: 'http', url: 'http://server.invalid', token }), /HTTPS/);
    const info = await fetch(`${urlA}/api/agent/v1/info`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
    assert.equal(info.apiVersion, 1); assert.deepEqual(info.eventStreams, ['sse', 'ndjson']);
    assert.equal((await fetch(`${urlA}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  } finally { await manager.close(); await httpA.close(); await httpB.close(); await a.service.close(); await b.service.close(); }
});

test('standalone HTTP CLI survives client removal and stdin EOF, and persists its identity', async t => {
  const root = await directory(t);
  const manager = new AgentConnectionManager(join(root, 'connections.json'), { encrypt: value => value, decrypt: value => value });
  const args = [fileURLToPath(new URL('../dist-electron/agentServiceCli.mjs', import.meta.url)), '--data-dir', join(root, 'service'), '--port', '0'];
  let child;
  const launch = async () => {
    child = spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let logs = ''; child.stderr.on('data', chunk => logs += chunk); child.stdout.on('data', () => {}); child.stdin.end();
    await until(() => logs, value => /listening on http:\/\/127.0.0.1:\d+/.test(value));
    const url = logs.match(/listening on (http:\/\/127.0.0.1:\d+)/)[1];
    const token = (await readFile(join(root, 'service', 'access-token'), 'utf8')).trim();
    assert.ok(!logs.includes(token)); return { url, token };
  };
  const stop = async () => { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } };
  try {
    const endpoint = await launch();
    const [connection] = await manager.save({ name: 'local', transport: 'http', ...endpoint });
    const first = await manager.connect(connection.id);
    await assert.rejects(manager.call(connection.id, 'invalid-operation'));
    await manager.call(connection.id, 'sessions.create', { sessionId: 'http-chat' });
    await manager.remove(connection.id);
    assert.equal(child.exitCode, null, 'removing an HTTP connection never terminates the service');
    assert.equal((await fetch(endpoint.url + '/health', { headers: { authorization: `Bearer ${endpoint.token}` } })).status, 200);
    await stop();
    const second = await launch();
    const [reconnected] = await manager.save({ name: 'local-again', transport: 'http', ...second });
    const next = await manager.connect(reconnected.id);
    assert.equal(first.id, next.id);
    assert.equal((await manager.call(reconnected.id, 'sessions.list')).length, 1);
  } finally { await manager.close(); await stop(); }
});

test('service refuses desktop Runtime directories and does not replay interrupted tasks', async t => {
  const root = await directory(t); await mkdir(join(root, 'runtime-state'));
  await assert.rejects(AgentService.open({ dataRoot: root }), /separate data directory/);
  const state = { version: 1, id: 'fixture-agent', name: 'fixture', revision: 0, projects: [], defaultProjectId: null,
    jobs: [{ id: 'interrupted', sessionId: 'missing', turnId: 'turn', status: 'running', createdAt: new Date().toISOString(), input: input('missing', 'interrupted') }] };
  await writeFile(join(root, 'agent.json'), JSON.stringify(state));
  const service = await AgentService.open({ dataRoot: root });
  try { assert.equal((await service.call('chat.jobs'))[0].status, 'interrupted'); } finally { await service.close(); }
});

test('tools execute on the Agent host and permission waits survive event reader disconnect', async t => {
  const root = await directory(t), outside = join(root, 'server-only.txt');
  await writeFile(outside, 'SERVER_LOCAL_CONTENT');
  const model = await modelFixture(t, 20, outside);
  const service = await AgentService.open({ dataRoot: join(root, 'service') });
  try {
    await service.call('product.command', { kind: 'models.update', config: { models: [{ id: 'fixture', provider: 'openai', model: 'fixture', apiKey: 'fixture-key', baseURL: model.url }] } });
    await service.call('sessions.create', { sessionId: 'tools' });
    const job = await service.call('chat.send', input('tools', 'tool-read'));
    let permission;
    await until(async () => {
      const result = await service.call('chat.events', { sessionId: 'tools', turnId: job.turnId, waitMs: 500 });
      permission = result.events.find(event => event.kind === 'permission_requested'); return permission;
    }, Boolean);
    await pause(60);
    assert.equal((await service.call('chat.jobs'))[0].status, 'running', 'closing the event read must not cancel a permission wait');
    const payload = permission.payload;
    await service.call('runtime.command', { kind: 'runtime.answer_permission', payload: { protocol: 'bush.runtime_permission_answer.v1', permissionId: payload.permissionId, answerId: 'allow-server-file', decision: 'allow_once', grantedCapabilityIds: payload.requestedCapabilityIds } });
    await until(() => service.call('chat.jobs'), jobs => jobs[0]?.status === 'completed');
    assert.equal(model.calls.length, 2);
    assert.match(JSON.stringify(model.calls[1]), /SERVER_LOCAL_CONTENT/);
    const records = await service.call('runtime.command', { kind: 'runtime.list_turn_tool_executions', payload: { sessionId: 'tools', turnId: job.turnId } });
    assert.ok(records.some(record => record.toolCall.name === 'read_file' && record.outcome === 'returned'));
  } finally { await service.close(); }
});

test('stopping a queued job does not cancel the running job; explicit running stop settles', async t => {
  const f = await openService(t, 'stop', 700);
  try {
    await f.service.call('sessions.create', { sessionId: 'stop' });
    await f.service.call('chat.send', input('stop', 'running'));
    await until(() => f.service.call('chat.jobs'), jobs => jobs[0]?.status === 'running');
    await f.service.call('chat.send', input('stop', 'queued'));
    await f.service.call('chat.stop', { id: 'queued' });
    await until(() => f.service.call('chat.jobs'), jobs => jobs[0]?.status === 'completed');
    assert.equal((await f.service.call('chat.jobs'))[1].status, 'stopped');
    assert.equal(f.model.calls.length, 1);
    await f.service.call('chat.send', input('stop', 'stop-now'));
    await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1).status === 'running');
    await f.service.call('chat.send', input('stop', 'after-stop'));
    await f.service.call('chat.stop', { id: 'stop-now' });
    await until(() => f.service.call('chat.jobs'), jobs => jobs.find(job => job.id === 'stop-now').status === 'stopped');
    await until(() => f.service.call('chat.jobs'), jobs => jobs.at(-1).status === 'completed');
  } finally { await f.service.close(); }
});

test('saved connection pins Agent identity and rejects a different service at the same URL', async t => {
  const a = await openService(t, 'identity-A'), b = await openService(t, 'identity-B');
  const token = 'identity-token-'.padEnd(48, 'x');
  let listener = await serveAgentHttp(a.service, { port: 0, token }); const port = listener.port;
  const manager = new AgentConnectionManager(join(a.root, 'connections.json'), { encrypt: value => value, decrypt: value => value });
  try {
    const [connection] = await manager.save({ name: 'pinned', transport: 'http', url: `http://127.0.0.1:${port}`, token });
    await manager.connect(connection.id); await listener.close();
    listener = await serveAgentHttp(b.service, { port, token });
    await assert.rejects(manager.call(connection.id, 'sessions.create', { sessionId: 'must-not-create' }), /identity changed/);
    assert.equal((await b.service.call('sessions.list')).length, 0);
    await manager.disconnect(connection.id);
    await assert.rejects(manager.connect(connection.id), /identity changed/);
  } finally { await manager.close(); await listener.close(); await a.service.close(); await b.service.close(); }
});

test('optional plugin installation, activation and removal reuse the Product Host on a headless Agent', async t => {
  const root = await directory(t), source = join(root, 'plugin-source');
  await mkdir(join(source, '.codex-plugin'), { recursive: true });
  await writeFile(join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'headless-fixture', version: '1.0.0', description: 'Service plugin fixture', cardbush: { runtimeExtension: { apiVersion: 1, entry: './runtime.mjs' } } }));
  await writeFile(join(source, 'runtime.mjs'), `export const apiVersion=1;export default()=>({id:'headless-fixture',features:['headless_fixture'],commands:{'plugin.headless-fixture.check':async()=>({host:'service'})}});`);
  const service = await AgentService.open({ dataRoot: join(root, 'service') });
  try {
    await service.call('plugins.install', { path: source });
    const apps = await service.call('product.command', { kind: 'apps.get' });
    await service.call('product.command', { kind: 'apps.update', config: { ...apps, expectedRevision: apps.revision, plugins: apps.plugins.map(plugin => ({ ...plugin, installed: true, enabled: true })) } });
    const capabilities = await service.call('runtime.command', { kind: 'runtime.get_capabilities' });
    assert.ok(capabilities.features.includes('headless_fixture'));
    assert.deepEqual(await service.call('runtime.command', { kind: 'plugin.headless-fixture.check' }), { host: 'service' });
    await service.call('plugins.uninstall', { id: 'headless-fixture' });
    assert.equal((await service.call('product.command', { kind: 'apps.get' })).plugins.length, 0);
    await assert.rejects(service.call('runtime.command', { kind: 'plugin.headless-fixture.check' }));
  } finally { await service.close(); }
});

test('queued work resumes after restart without replaying the stopped active task', async t => {
  const f = await openService(t, 'resume-queue', 600);
  let reopened;
  try {
    await f.service.call('sessions.create', { sessionId: 'durable-queue' });
    await f.service.call('chat.send', input('durable-queue', 'before-shutdown'));
    await until(async () => f.model.calls.length, count => count === 1);
    await f.service.call('chat.send', input('durable-queue', 'after-restart'));
    await f.service.close();
    reopened = await AgentService.open({ dataRoot: f.root });
    const jobs = await until(() => reopened.call('chat.jobs'), jobs => jobs.at(-1)?.status === 'completed');
    assert.equal(jobs[0].status, 'stopped'); assert.equal(jobs[1].status, 'completed');
    assert.equal(f.model.calls.length, 2);
  } finally { await reopened?.close(); await f.service.close(); }
});

test('SSE delivers live events, reconnects by cursor, and NDJSON replays the same history', async t => {
  const f = await openService(t, 'streams', 1000), token = 'stream-token-'.padEnd(48, 'x');
  const listener = await serveAgentHttp(f.service, { port: 0, token });
  const base = `http://127.0.0.1:${listener.port}/`;
  const client = new AgentHttpClient(base, token);
  try {
    await client.info(); await client.call('sessions.create', { sessionId: 'stream' });
    const job = await client.call('chat.send', input('stream', 'live-stream', '你好，流式测试'));
    const request = { sessionId: 'stream', turnId: job.turnId };
    const abort = new AbortController(); let cursor;
    for await (const frame of client.events(request, abort.signal)) {
      if (frame.type !== 'event') continue;
      cursor = frame.event.sequence;
      assert.equal((await client.call('chat.jobs', {}))[0].status, 'running', 'SSE must arrive while the task is running');
      // A streaming response cannot block separate management or submission requests.
      await client.call('instructions.get', {});
      abort.abort(); break;
    }
    assert.ok(cursor > 0);
    const rest = [];
    for await (const frame of client.events({ ...request, afterSequence: cursor }, new AbortController().signal)) if (frame.type === 'event') rest.push(frame.event);
    assert.ok(rest.every(event => event.sequence > cursor));
    assert.equal(rest.at(-1).kind, 'turn_terminal');
    await until(() => client.call('chat.jobs', {}), jobs => jobs[0]?.status === 'completed');
    assert.equal(f.model.calls.length, 1, 'closing an event reader must not rerun the task');
    const frames = [];
    for await (const frame of client.events(request, new AbortController().signal, 'ndjson')) frames.push(frame);
    const history = frames.filter(frame => frame.type === 'event').map(frame => frame.event);
    assert.equal(frames[0].type, 'ready'); assert.equal(frames.at(-1).type, 'end');
    assert.deepEqual(history.filter(event => event.sequence > cursor), rest);
    assert.equal(new Set(history.map(event => event.sequence)).size, history.length);
    const query = new URLSearchParams(request);
    const resumed = await fetch(`${base}api/agent/v1/events?${query}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'last-event-id': String(cursor) } });
    assert.equal(resumed.headers.get('x-accel-buffering'), 'no');
    const text = await resumed.text();
    assert.match(text, /event: end/); assert.ok(!text.includes(`id: ${cursor}\n`));
    const finished = [];
    for await (const frame of client.events({ ...request, afterSequence: history.at(-1).sequence }, new AbortController().signal)) finished.push(frame);
    assert.deepEqual(finished.map(frame => frame.type), ['ready', 'end']);
  } finally { client.close(); await listener.close(); await f.service.close(); }
});

test('HTTP validates authentication, methods, bodies, stream cursors and task identity', async t => {
  const f = await openService(t), token = 'validation-'.padEnd(48, 'v');
  const listener = await serveAgentHttp(f.service, { port: 0, token });
  const base = `http://127.0.0.1:${listener.port}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = body => fetch(base + '/api/agent/v1/call', { method: 'POST', headers, body });
  try {
    assert.equal((await fetch(base + '/health')).status, 401);
    assert.equal((await fetch(base + '/health', { headers: { ...headers, origin: 'null' } })).status, 401);
    assert.equal((await fetch(base + '/api/agent/v1/call', { headers })).status, 405);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ operation: 'unknown' }))).status, 400);
    assert.equal((await post(' '.repeat(2 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await fetch(base + '/api/agent/v1/call', { method: 'POST', headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
    assert.equal((await fetch(base + '/api/agent/v1/events?sessionId=missing&turnId=missing', { headers })).status, 409);
    assert.equal((await fetch(base + '/api/agent/v1/events?sessionId=a&turnId=b&afterSequence=-1', { headers })).status, 400);
    await f.service.call('sessions.create', { sessionId: 'valid' });
    const job = await f.service.call('chat.send', input('valid', 'valid'));
    const url = base + '/api/agent/v1/events?' + new URLSearchParams({ sessionId: 'valid', turnId: job.turnId });
    assert.equal((await fetch(url, { headers: { ...headers, accept: 'application/xml' } })).status, 406);
    assert.equal((await fetch(url, { headers: { ...headers, 'last-event-id': 'NaN' } })).status, 400);
  } finally { await listener.close(); await f.service.close(); }
});

test('event streams end for queued stops and admission failures without fabricated Runtime events', async t => {
  const f = await openService(t, 'no-runtime-event', 900), token = 'empty-stream-'.padEnd(48, 'x');
  const listener = await serveAgentHttp(f.service, { port: 0, token });
  const client = new AgentHttpClient(`http://127.0.0.1:${listener.port}/`, token);
  try {
    await client.info(); await client.call('sessions.create', { sessionId: 'queued-stream' });
    await client.call('chat.send', input('queued-stream', 'blocker'));
    await until(() => f.model.calls.length, count => count === 1);
    const queued = await client.call('chat.send', input('queued-stream', 'cancel-before-start'));
    const frames = []; let started; const ready = new Promise(resolve => { started = resolve; });
    const read = (async () => {
      for await (const frame of client.events({ sessionId: 'queued-stream', turnId: queued.turnId }, AbortSignal.timeout(5000))) { frames.push(frame); if (frame.type === 'ready') started(); }
    })();
    await ready; await client.call('chat.stop', { id: queued.id }); await read;
    assert.deepEqual(frames.map(frame => frame.type), ['ready', 'end']);
    const failed = await client.call('chat.send', { ...input('queued-stream', 'invalid-model'), modelId: 'missing-model' });
    await until(() => client.call('chat.jobs', {}), jobs => jobs.at(-1).status === 'failed');
    const failedFrames = [];
    for await (const frame of client.events({ sessionId: 'queued-stream', turnId: failed.turnId }, AbortSignal.timeout(5000))) failedFrames.push(frame);
    assert.deepEqual(failedFrames.map(frame => frame.type), ['ready', 'end']);
  } finally { client.close(); await listener.close(); await f.service.close(); }
});

test('old HTTP connections keep credentials and identity; old stdio connections never launch', async t => {
  const f = await openService(t), token = 'migration-'.padEnd(48, 'm');
  const listener = await serveAgentHttp(f.service, { port: 0, token });
  const path = join(f.root, 'connections.json');
  await writeFile(path, JSON.stringify([
    { id: 'http-old', name: 'Old HTTP', transport: 'streamable_http', url: `http://127.0.0.1:${listener.port}/mcp`, token, agentId: f.service.info().id },
    { id: 'stdio-old', name: 'Old stdio', transport: 'stdio', command: 'must-not-launch', args: ['secret-argument'] },
  ]));
  const manager = new AgentConnectionManager(path, { encrypt: value => value, decrypt: value => value });
  try {
    assert.equal((await manager.connect('http-old')).id, f.service.info().id);
    await assert.rejects(manager.connect('stdio-old'), /HTTP/);
    const listed = await manager.list();
    assert.equal(listed[0].transport, 'http'); assert.match(listed[1].migrationIssue, /stdio/);
    assert.doesNotMatch(JSON.stringify(listed), /secret-argument|must-not-launch/);
    assert.equal(JSON.parse(await readFile(path, 'utf8'))[1].legacyLaunch.command, 'must-not-launch');
    await assert.rejects(manager.save({ name: 'new-stdio', transport: 'stdio', command: process.execPath }));
  } finally { await manager.close(); await listener.close(); await f.service.close(); }
});

test('HTTP stream parser handles split UTF-8 and rejects truncated streams', async () => {
  const info = { protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'], id: 'parser-agent', name: 'parser', platform: 'linux', capabilities: { durableQueue: true } };
  let truncate = false;
  const event = { sessionId: 'session', turnId: 'turn', sequence: 1, payload: { text: '你好，世界' } };
  const server = createServer((req, res) => {
    res.setHeader('x-cardbush-agent-id', info.id);
    if (req.url.endsWith('/info')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(info)); return; }
    res.setHeader('content-type', 'text/event-stream');
    const frames = [{ type: 'ready', agentId: info.id }, { type: 'event', event }, ...truncate ? [] : [{ type: 'end', afterSequence: 1 }]];
    const bytes = Buffer.from(': ping\r\n\r\n' + frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
    let offset = 0;
    const next = () => { if (offset >= bytes.length) { res.end(); return; } res.write(bytes.subarray(offset, offset += 3)); setImmediate(next); }; next();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new AgentHttpClient(`http://127.0.0.1:${server.address().port}/`, 'parser-token');
  try {
    await client.info(); const frames = [];
    for await (const frame of client.events({ sessionId: 'session', turnId: 'turn' }, new AbortController().signal)) frames.push(frame);
    assert.equal(frames[1].event.payload.text, '你好，世界');
    truncate = true;
    await assert.rejects(async () => { for await (const _ of client.events({ sessionId: 'session', turnId: 'turn' }, new AbortController().signal)) {} }, /disconnected/);
  } finally { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
