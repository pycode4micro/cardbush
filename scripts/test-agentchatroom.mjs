import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import create from '../assets/plugins/agentchatroom/runtime/index.mjs';
import { ToolRegistry, InMemoryRuntimeHost, ToolExecutionCoordinator } from '@cardbush/bush-runtime';
import { modelToolDefinitions } from '../packages/bush-runtime/dist/mcpToolDiscovery.js';
import { synchronizeBuiltinSchemas } from '../packages/bush-runtime/dist/builtinToolDisclosure.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-chatroom-'));
  const facts = new Map(), notifications = [], registry = new ToolRegistry();
  const api = { tools: registry, dataDirectory: directory, conversations: {
    list: () => [...facts.values()], notify: (id, notice) => { notifications.push({ id, ...notice }); return true; },
    dismiss: (id, key) => { const index = notifications.findIndex(item => item.id === id && item.key === key); if (index >= 0) notifications.splice(index, 1); },
    wait: async (_id, _turn, pending) => { await pending; return 'task_completed'; },
  } };
  let plugin = create(api);
  const add = (id, project = 'project', status = 'running') => {
    const fact = { agentId: id, turnId: `turn-${id}`, status, projectDir: join(directory, project), workspaceDir: join(directory, project) };
    facts.set(id, fact); return fact;
  };
  const call = async (agent, name, input = {}, options = {}) => {
    const tool = api.tools.resolve(`agentchatroom_${name}`);
    return tool.execute({ sessionId: agent, turnId: `turn-${agent}`, input: tool.decodeInput(input),
      toolCall: { id: 'call' }, turn: { request: { metadata: options.metadata ?? {} } }, signal: options.signal });
  };
  const coordinate = async (agent, action, input = {}, options = {}) => {
    const tool = api.tools.resolve('agentchatroom');
    return tool.execute({ sessionId: agent, turnId: `turn-${agent}`, input: tool.decodeInput({ action, ...input }),
      toolCall: { id: 'current-call' }, turn: { request: { metadata: options.metadata ?? {} } }, signal: options.signal });
  };
  const reload = async () => {
    const previous = plugin; api.tools = new ToolRegistry(); plugin = create(api); previous.dispose();
    return plugin;
  };
  t.after(async () => {
    await plugin.dispose();
    // The native plugin disposal is synchronous; its final writer release drains pending fsyncs.
    for (let n = 0; n < 100; n++) {
      try { await readFile(join(directory, 'rooms/writer.lock')); await new Promise(r => setTimeout(r, 5)); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    assert.ok(directory.startsWith(tmpdir() + sep)); await rm(directory, { recursive: true, force: true });
  });
  return { add, call, coordinate, facts, notifications, directory, reload, api, get plugin() { return plugin; } };
}

test('same-project discovery is minimal and does not reveal unrelated or unjoined idle sessions', async t => {
  const f = await fixture(t); const a = f.add('a'); f.add('b'); f.add('unrelated', 'elsewhere'); f.add('idle', 'project', 'idle');
  const context = await f.plugin.conversationContext(a); assert.equal(context[0].role, 'user'); assert.equal(context[0].visibility, 'internal');
  const result = await f.call('a', 'discover'); assert.deepEqual(result.peers.map(peer => peer.agent_id), ['b']);
  assert.doesNotMatch(JSON.stringify(result), /elsewhere|member_token|cursor|prompt/);
  await f.plugin.conversationChanged(a); assert.deepEqual(f.notifications.map(item => item.id), ['b']);
});

test('one canonical tool owns room coordination, reads or waits once, and shares legacy membership/cursors', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  assert.deepEqual(f.api.tools.definitions().map(tool => tool.name), ['agentchatroom']);
  assert.equal(f.api.tools.definitions({ includeSuperseded: true }).length, 8);
  const view = await f.coordinate('a', 'discover');
  assert.equal(view.tool, 'agentchatroom'); assert.equal(view.tools, undefined);
  const { room_id } = await f.coordinate('a', 'join');
  assert.equal((await f.call('b', 'join')).room_id, room_id);
  const waiting = f.coordinate('a', 'read', { room_id, wait_ms: 30000 });
  await f.coordinate('b', 'send', { room_id, text: 'I own the interface', client_message_id: 'interface' });
  assert.deepEqual((await waiting).messages.map(item => item.text), ['I own the interface']);
  assert.equal((await f.call('a', 'read', { room_id })).messages.length, 0, 'both paths share one cursor');
  await f.coordinate('a', 'send', { room_id, text: 'I own the tests', client_message_id: 'tests' });
  const immediate = await f.coordinate('b', 'read', { room_id, wait_ms: 30000 });
  assert.equal(immediate.messages.length, 2, 'existing messages return immediately without a separate wait call');
  await f.reload(); assert.equal((await f.coordinate('b', 'read', { room_id })).messages.length, 0);
  await f.coordinate('a', 'leave', { room_id });
  await assert.rejects(f.coordinate('a', 'send', { room_id, text: 'left', client_message_id: 'left' }), /Join this room/);
});

test('canonical actions reject irrelevant fields and cannot become a child/peer messaging bypass', async t => {
  const f = await fixture(t); f.add('a');
  await assert.rejects(f.coordinate('a', 'join', { agent_id: 'spoofed' }), /Unrecognized/);
  await assert.rejects(f.coordinate('a', 'send', { room_id: 'room', text: 'missing retry identity' }), /client_message_id/);
  await assert.rejects(f.coordinate('a', 'read', { room_id: 'room', wait_ms: 30001 }), /30000/);
  for (const action of ['discover', 'join']) {
    await assert.rejects(f.coordinate('a', action, {}, { metadata: { agentRole: 'child' } }), /through their parent/);
  }
});

test('explicit joins reuse one project room; sends are durable/idempotent and never consume unread messages', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  const [a, b] = await Promise.all([f.call('a', 'join'), f.call('b', 'join')]); assert.equal(a.room_id, b.room_id);
  const room_id = a.room_id;
  await f.call('b', 'send', { room_id, text: 'I own the data contract', client_message_id: 'b-1' });
  const sent = await f.call('a', 'send', { room_id, text: 'I own the UI', client_message_id: 'a-1' });
  assert.equal(sent.read_cursor_advanced, false);
  const retry = await f.call('a', 'send', { room_id, text: 'I own the UI', client_message_id: 'a-1' }); assert.equal(retry.duplicate, true);
  await assert.rejects(f.call('a', 'send', { room_id, text: 'different', client_message_id: 'a-1' }), /already used/);
  const page = await f.call('a', 'read', { room_id, limit: 1 }); assert.equal(page.messages[0].text, 'I own the data contract'); assert.equal(page.has_more, true);
  assert.equal((await f.call('a', 'discover')).rooms[0].unread, 1);
  await f.reload();
  const next = await f.call('a', 'read', { room_id }); assert.deepEqual(next.messages.map(message => message.text), ['I own the UI']);
  assert.equal((await f.call('a', 'read', { room_id })).messages.length, 0);
  // A full release/reopen uses the saved room/cursor, not just the hot-reload writer lease.
  await f.plugin.dispose(); await f.reload();
  assert.equal((await f.call('a', 'discover')).rooms[0].unread, 0);
  await f.call('b', 'send', { room_id, text: 'after restart', client_message_id: 'b-2' });
  assert.equal((await f.call('a', 'read', { room_id })).messages[0].text, 'after restart');
});

test('cross-project rooms stay private until targeted invitation is accepted; unrelated agents cannot join/read/send', async t => {
  const f = await fixture(t); f.add('a'); f.add('b', 'backend'); f.add('c', 'backend'); f.add('outsider', 'unrelated');
  const { room_id } = await f.call('a', 'join');
  await assert.rejects(f.call('b', 'join', { room_id }), /explicit invitation/);
  await f.call('a', 'invite', { room_id, agent_id: 'b', reason: 'Coordinate the frontend API with backend changes' });
  assert.equal((await f.call('b', 'discover')).invitations.length, 1);
  assert.equal((await f.call('c', 'discover')).invitations.length, 0);
  assert.equal((await f.call('b', 'discover')).peers.some(peer => peer.agent_id === 'a'), false);
  await assert.rejects(f.call('b', 'read', { room_id }), /Join this room/);
  await f.call('b', 'join', { room_id });
  assert.equal((await f.call('c', 'discover')).peers.find(peer => peer.agent_id === 'a').relation, 'linked_project');
  await assert.rejects(f.call('outsider', 'join', { room_id }), /explicit invitation/);
  await assert.rejects(f.call('outsider', 'send', { room_id, text: 'no', client_message_id: 'no' }), /Join this room/);
  assert.equal((await f.call('outsider', 'discover')).rooms.length, 0);
});

test('room wait wakes for committed messages, cancellation, departure and plugin reload', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  const { room_id } = await f.call('a', 'join'); await f.call('b', 'join');
  const waiting = f.call('a', 'wait', { room_id, timeout_ms: 30000 });
  await f.call('b', 'send', { room_id, text: 'ready', client_message_id: 'ready' });
  assert.equal((await waiting).status, 'messages'); await f.call('a', 'read', { room_id });
  const controller = new AbortController();
  const cancelled = f.call('a', 'wait', { room_id, timeout_ms: 30000 }, { signal: controller.signal }); controller.abort();
  assert.equal((await cancelled).status, 'cancelled');
  const leaving = f.call('b', 'wait', { room_id, timeout_ms: 30000 });
  await f.call('b', 'leave', { room_id }); assert.equal((await leaving).status, 'membership_revoked');
  const reloading = f.call('a', 'wait', { room_id, timeout_ms: 30000 });
  // Ensure this invocation has entered its wait before replacing the instance.
  await new Promise(resolve => setTimeout(resolve, 10)); await f.reload(); assert.equal((await reloading).status, 'cancelled');
  const before = f.notifications.filter(item => item.id === 'b' && item.wake).length;
  await f.call('a', 'send', { room_id, text: 'after leave', client_message_id: 'after' });
  assert.equal(f.notifications.filter(item => item.id === 'b' && item.wake).length, before);
});

test('host identity cannot be spoofed and delegated agents cannot discover, join or message', async t => {
  const f = await fixture(t); f.add('a');
  for (const metadata of [{ agentRole: 'child' }, { parentSessionId: 'parent' }, { shadowMode: 'fork' }]) {
    for (const name of ['discover', 'join']) await assert.rejects(f.call('a', name, {}, { metadata }), /through their parent/);
  }
  await assert.rejects(f.call('missing', 'discover'), /active independent/);
  await assert.rejects(f.call('a', 'discover', { agent_id: 'someone-else' }), /Unrecognized/);
  const { room_id } = await f.call('a', 'join');
  f.facts.get('a').projectDir = join(f.directory, 'moved');
  f.facts.get('a').workspaceDir = join(f.directory, 'moved');
  await assert.rejects(f.call('a', 'read', { room_id }), /current project/);
});

test('source and git worktree share discovery without changing their file roots', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'source/.git/worktrees/copy'), { recursive: true }); await mkdir(join(f.directory, 'copy'));
  await writeFile(join(f.directory, 'copy/.git'), `gitdir: ../source/.git/worktrees/copy\n`);
  await writeFile(join(f.directory, 'source/.git/worktrees/copy/commondir'), '../..\n');
  f.add('a', 'source'); f.add('b', 'copy');
  assert.equal((await f.call('a', 'discover')).peers[0].relation, 'same_project');
  assert.equal(f.facts.get('b').workspaceDir, join(f.directory, 'copy'));
});

test('bundled tools are deferred and discovery never bypasses execution-time child policy', async t => {
  const f = await fixture(t); await f.plugin.dispose();
  const registry = new ToolRegistry(), host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  let extension;
  host.installExtension(api => extension = create(api), { id: 'agentchatroom', enabled: true, dataDirectory: join(f.directory, 'host') });
  t.after(async () => { host.removeExtension('agentchatroom'); await extension.dispose(); });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'a', turnId: 't', model: 'fixture', messages: [], tools: registry.definitions(), metadata: {}, permissionMode: 'all_free' };
  assert.deepEqual(request.tools.filter(tool => tool.name.startsWith('agentchatroom')).map(tool => tool.name), ['agentchatroom']);
  assert.ok(registry.resolve('agentchatroom_join'), 'legacy handlers survive extension staging');
  assert.ok(modelToolDefinitions(registry, request).every(tool => !tool.name.startsWith('agentchatroom')));
  const coordinator = new ToolExecutionCoordinator({ registry }); let seq = 0; const messages = [];
  const run = (name, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c${++seq}`, name, argumentsText: JSON.stringify(input) },
    { requestId: 'r', sessionId: 'a', turnId: 't', round: 1, ordinal: seq }, undefined, { request, contextMessages: messages });
  assert.equal((await run('agentchatroom', { action: 'join' })).error.code, 'builtin_schema_required');
  const loaded = await run('get_tool_schema', { name: 'agentchatroom' }); assert.equal(loaded.kind, 'returned');
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'get_tool_schema', argumentsText: '{"name":"agentchatroom"}' }] },
    { role: 'tool', toolCallId: 'load', content: JSON.stringify(loaded.result) });
  synchronizeBuiltinSchemas(registry, request, messages);
  request.metadata.agentRole = 'child';
  assert.equal((await run('call_tool', { name: 'agentchatroom', arguments: { action: 'join' } })).error.code, 'child_agent_tool_unavailable');
  host.removeExtension('agentchatroom');
  await extension.dispose();
});

test('actual Runtime delivers peer context at safe boundaries and wakes only joined idle sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-peer-runtime-'));
  const registry = new ToolRegistry(), observed = [], errors = [], gate = Promise.withResolvers();
  let extension, firstA = true;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false,
    onRecoveryError: error => errors.push(error), provider: { async *stream(request) {
      observed.push(structuredClone(request));
      if (request.sessionId === 'a' && firstA) { firstA = false; await gate.promise; }
      yield event(request, 0, 'text_delta', { delta: 'Coordination checked.' });
      yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    } } });
  host.installExtension(api => extension = create(api), { id: 'agentchatroom', enabled: true, dataDirectory: join(directory, 'plugin') });
  t.after(async () => {
    gate.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    host.removeExtension('agentchatroom'); await extension.dispose();
    assert.ok(directory.startsWith(tmpdir() + sep)); await rm(directory, { recursive: true, force: true });
  });
  const request = (id, turn = `turn-${id}`) => ({ protocol: 'bush.session_turn_request.v1', sessionId: id, turnId: turn, requestId: `r-${turn}`,
    model: 'fixture', prefixMessages: [{ role: 'system', content: 'fixed-prefix' }],
    inputMessages: [{ messageId: `user-${turn}`, message: { role: 'user', content: `Own task ${id}` } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { projectDir: directory, workspaceDir: directory } });
  const call = (id, name, args) => {
    const tool = registry.resolve(`agentchatroom_${name}`);
    return tool.execute({ sessionId: id, turnId: `turn-${id}`, input: tool.decodeInput(args), turn: { request: { metadata: {} } } });
  };
  const runningA = host.runSessionTurn(request('a')); await until(() => observed.some(req => req.sessionId === 'a'));
  const { room_id } = await call('a', 'join', {});
  // B's context and turn start happen before its provider response, so send while it is active.
  let joinedB;
  const previousContext = extension.conversationContext;
  extension.conversationContext = async fact => {
    const result = await previousContext(fact);
    if (fact.agentId === 'b') {
      joinedB = await call('b', 'join', {});
      await call('b', 'send', { room_id, text: 'I own the API contract; please own the UI.', client_message_id: 'b-first' });
    }
    return result;
  };
  await host.runSessionTurn(request('b'));
  assert.equal(joinedB.room_id, room_id);
  assert.match(observed.find(req => req.sessionId === 'b').messages.find(message => message.name === 'workspace_agents').content, /"agent_id":"a"/);
  gate.resolve(); await runningA;
  const aRequests = observed.filter(req => req.sessionId === 'a');
  assert.ok(aRequests.some(req => req.messages.some(message => message.name === 'agent_peer_context' && message.visibility === 'internal')));
  assert.ok(aRequests.every(req => req.messages[0].content === 'fixed-prefix'));
  assert.ok(aRequests.every(req => req.tools.every(tool => !tool.name.startsWith('agentchatroom_'))));
  // A second human turn in B sends to idle joined A. Runtime starts a normal persisted follow-up.
  extension.conversationContext = async fact => {
    const result = await previousContext(fact);
    if (fact.agentId === 'b') {
      const tool = registry.resolve('agentchatroom_send');
      await tool.execute({ sessionId: 'b', turnId: fact.turnId, input: tool.decodeInput({ room_id, text: 'Schema is v2', client_message_id: 'b-next' }), turn: { request: { metadata: {} } } });
    }
    return result;
  };
  await host.runSessionTurn(request('b', 'b-followup'));
  await until(() => observed.some(req => req.sessionId === 'a' && req.metadata.peerMessageWake === true));
  await until(() => !host.hasActiveSession('a'));
  const woke = observed.find(req => req.metadata.peerMessageWake === true);
  assert.ok(woke.messages.some(message => message.name === 'agent_peer_wake' && message.visibility === 'internal'));
  const history = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'a' } });
  assert.equal(history.turns.length, 2);
  assert.deepEqual(errors, []);
});

test('hot enabling a plugin appends current context to an active turn without rewriting its prefix', async () => {
  const gate = Promise.withResolvers(), seen = [];
  const host = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false, provider: { async *stream(request) {
    seen.push(structuredClone(request)); if (seen.length === 1) await gate.promise;
    yield event(request, 0, 'text_delta', { delta: 'done' }); yield event(request, 1, 'response_completed', { finishReason: 'stop' });
  } } });
  let contextCalls = 0;
  const request = { protocol: 'bush.session_turn_request.v1', sessionId: 'hot', turnId: 'hot-turn', requestId: 'hot-request', model: 'fixture',
    tools: [], prefixMessages: [{ role: 'system', content: 'original' }], inputMessages: [{ messageId: 'human', message: { role: 'user', content: 'Continue' } }], metadata: {} };
  const pending = host.runSessionTurn(request);
  try {
    await until(() => seen.length === 1);
    host.installExtension(() => ({ id: 'peer-fixture', features: [], commands: {}, conversationContext: async () => {
      contextCalls++; return [{ role: 'user', content: 'current workspace peers: agent-two' }];
    } }), { enabled: true });
    await until(() => contextCalls > 0); await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await pending;
    assert.equal(seen.length, 2);
    assert.ok(seen[1].messages.some(message => message.name === 'agent_peer_context' && message.visibility === 'internal' && message.content.includes('agent-two')));
    assert.equal(seen[1].messages[0].content, 'original');
  } finally { gate.resolve(); await pending; await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('peer notification wakes an active plugin wait through Runtime signals without impersonating user guidance', async () => {
  const registry = new ToolRegistry(), observed = [], entered = Promise.withResolvers();
  let conversations;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, provider: { async *stream(request) {
    observed.push(structuredClone(request));
    if (observed.length === 1) {
      yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: 'wait-call', nameDelta: 'fixture_wait', argumentsDelta: '{}' });
      yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      yield event(request, 0, 'text_delta', { delta: 'Received peer notice.' }); yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  host.installExtension(api => {
    conversations = api.conversations;
    api.tools.register({ definition: { name: 'fixture_wait', description: 'Fixture wait', inputSchema: { type: 'object' } },
      manifest: { owner: 'fixture', operation: 'wait', effect_kind: 'observation', risk: 'low', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: input => input, execute: async context => {
        entered.resolve(); return { reason: await api.conversations.wait(context.sessionId, context.turnId, new Promise(() => {}), context.signal) };
      } });
    return { id: 'peer-wait-fixture', features: [], commands: {} };
  }, { enabled: true });
  const request = { protocol: 'bush.session_turn_request.v1', sessionId: 'waiter', turnId: 'wait-turn', requestId: 'wait-request', model: 'fixture',
    tools: registry.definitions(), prefixMessages: [], inputMessages: [{ messageId: 'human', message: { role: 'user', content: 'Wait for relevant coordination' } }], metadata: {} };
  let ended = false;
  const pending = host.runSessionTurn(request).finally(() => { ended = true; });
  await Promise.race([entered.promise, until(() => ended).then(() => {
    throw new Error(`Turn ended before event wait: ${JSON.stringify(host.events('waiter', 'wait-turn').filter(event => event.kind === 'tool_failed' || event.kind === 'turn_terminal'))}`);
  })]);
  conversations.notify('waiter', { key: 'room', content: 'room has new messages' }); await pending;
  assert.equal(observed.length, 2);
  assert.ok(observed[1].messages.some(message => message.role === 'tool' && message.content.includes('peer_message')));
  assert.ok(observed[1].messages.some(message => message.name === 'agent_peer_context'));
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});

function event(request, sequence, kind, payload) {
  return { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: new Date().toISOString(), kind, ...payload };
}
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for Runtime fact'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
