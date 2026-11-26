import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import create from '../assets/plugins/agentchatroom/runtime/index.mjs';
import { ToolRegistry, InMemoryRuntimeHost, InMemoryRuntimeEventLog, RuntimeToolLoop, SessionStore, ToolExecutionCoordinator, SubagentTaskStore } from '@cardbush/bush-runtime';
import { modelToolDefinitions } from '../packages/bush-runtime/dist/mcpToolDiscovery.js';
import { synchronizeBuiltinSchemas } from '../packages/bush-runtime/dist/builtinToolDisclosure.js';
import { bindResultDelivery, resultDelivery } from '../packages/bush-runtime/dist/taskResultDelivery.js';
import { PERSONAL_ASSISTANT_SESSION, assistantProfileSchema } from '@cardbush/bush-protocol';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-chatroom-'));
  const facts = new Map(), notifications = [], registry = new ToolRegistry();
  const api = { tools: registry, dataDirectory: directory, bindResultDelivery, conversations: {
    list: () => [...facts.values()], notify: (id, notice) => { notifications.push({ id, ...notice }); return true; },
    dismiss: (id, key) => { const index = notifications.findIndex(item => item.id === id && item.key === key); if (index >= 0) notifications.splice(index, 1); },
    wait: async (_id, _turn, pending) => { await pending; return 'task_completed'; },
  } };
  let plugin = create(api);
  const add = (id, project = 'project', status = 'running', delegated = false) => {
    const fact = { agentId: id, turnId: `turn-${id}`, status, ...(delegated ? { delegated: true } : {}), projectDir: join(directory, project), workspaceDir: join(directory, project) };
    facts.set(id, fact); return fact;
  };
  const call = async (agent, action, input = {}, options = {}) => {
    const tool = api.tools.resolve('agentchatroom');
    const result = await tool.execute({ sessionId: agent, turnId: facts.get(agent)?.turnId ?? `turn-${agent}`, input: tool.decodeInput({ action, ...input }),
      toolCall: { id: 'current-call' }, turn: { request: { metadata: options.metadata ?? {} } }, signal: options.signal });
    const delivery = resultDelivery(result);
    try { await delivery?.commit(options.presented ?? JSON.stringify(result)); }
    finally { delivery?.release(); }
    return result;
  };
  const reload = async () => {
    const previous = plugin; api.tools = new ToolRegistry(); plugin = create(api); previous.dispose();
    return plugin;
  };
  const reopen = async () => {
    await plugin.dispose();
    api.tools = new ToolRegistry(); plugin = create(api);
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
  return { add, call, facts, notifications, directory, reload, reopen, api, get plugin() { return plugin; } };
}

test('same-project discovery is minimal and does not reveal unrelated or unjoined idle sessions', async t => {
  const f = await fixture(t); const a = f.add('a'); f.add('b'); f.add('unrelated', 'elsewhere'); f.add('idle', 'project', 'idle');
  const context = await f.plugin.conversationContext(a); assert.equal(context[0].role, 'user'); assert.equal(context[0].visibility, 'internal');
  const result = await f.call('a', 'discover'); assert.deepEqual(result.peers.map(peer => peer.agent_id), ['b']);
  assert.doesNotMatch(JSON.stringify(result), /elsewhere|member_token|cursor|prompt/);
  await f.plugin.conversationChanged(a); assert.deepEqual(f.notifications.map(item => item.id), ['b']);
});

test('a withheld room receipt leaves the handoff unread until a complete delivery commits', async t => {
  const f = await fixture(t), a = f.add('a'); f.add('b');
  await f.plugin.conversationChanged(a);
  const { room_id } = (await f.call('a', 'discover')).coordination;
  await f.call('a', 'join', { room_id }); await f.call('b', 'join', { room_id });
  await f.call('a', 'send', { room_id, text: 'Hand off style.css after revision A.', client_message_id: 'handoff' });
  const identity = { requestId: 'withheld', sessionId: 'b', turnId: 'turn-b' };
  const request = { ...identity, protocol: 'bush.model_request.v1', model: 'fixture', messages: [], tools: f.api.tools.definitions(),
    metadata: {}, permissionMode: 'all_free' };
  let rejected = true;
  const loop = new RuntimeToolLoop({ registry: f.api.tools, eventLog: new InMemoryRuntimeEventLog(), identity, hooks: {
    before: async () => ({ messages: [] }),
    after: async () => ({ messages: [], ...(rejected ? { rejectToolResult: true, toolFeedback: 'Withheld by fixture policy' } : {}) }),
  } });
  const read = (round, modelContextIngressBudgetTokens) => loop.execute([{ protocol: 'bush.tool_call.v1', id: `read-${round}`,
    name: 'agentchatroom', argumentsText: JSON.stringify({ action: 'read', room_id }) }],
  { request, contextMessages: [], round, assistantMessageId: `answer-${round}`, modelContextIngressBudgetTokens });
  const blocked = await read(1);
  assert.doesNotMatch(blocked.messages[0].content, /Hand off style/);
  assert.match(blocked.messages[0].content, /Withheld by fixture policy/);
  await blocked.commitDeliveries();
  rejected = false;
  const clipped = await read(2, 0);
  assert.doesNotMatch(clipped.messages[0].content, /Hand off style/);
  await clipped.commitDeliveries();
  const next = await read(3);
  assert.equal(next.requiresDeliveryCheckpoint, true);
  assert.deepEqual(JSON.parse(next.messages[0].content).messages.map(message => message.text), ['Hand off style.css after revision A.']);
  await next.commitDeliveries();
  assert.deepEqual((await f.call('b', 'read', { room_id })).messages, []);
});

test('a same-project turn without the room tool does not receive or create an invitation', async t => {
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'cardbush-room-eligibility-'));
  const project = join(directory, 'project');
  await mkdir(project);
  const registry = new ToolRegistry(), requests = new Map();
  const first = Promise.withResolvers(), release = Promise.withResolvers();
  const host = new InMemoryRuntimeHost({ dataRoot: join(directory, 'runtime'), toolRegistry: registry,
    provider: { async *stream(request) {
      requests.set(request.sessionId, request);
      const event = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...event, sequence: 0, kind: 'response_started' };
      if (request.sessionId === 'eligible') { first.resolve(); await release.promise; }
      yield { ...event, sequence: 1, kind: 'text_delta', delta: 'Fixture done.' };
      yield { ...event, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    } } });
  host.installExtension(create, { id: 'agentchatroom', enabled: true, dataDirectory: join(directory, 'plugin') });
  const run = (id, tools) => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r-' + id, sessionId: id,
    turnId: 't-' + id, model: 'fixture', prefixMessages: [{ role: 'system', content: 'Eligibility fixture.' }],
    inputMessages: [{ messageId: 'u-' + id, message: { role: 'user', content: 'Fixture.' } }], tools,
    metadata: { projectDir: project, workspaceDir: project, environmentContext: true } });
  t.after(async () => {
    release.resolve();
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.equal(resolve(directory, '..'), base);
    assert.ok(directory.startsWith(join(base, 'cardbush-room-eligibility-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const eligible = run('eligible', registry.definitions());
  await Promise.race([first.promise, eligible]);
  try {
    const result = await run('excluded', registry.definitions().filter(tool => tool.name !== 'agentchatroom'));
    assert.equal(result.payload.status, 'completed');
    assert.ok(requests.has('excluded'));
    assert.ok(!requests.get('excluded').messages.some(message => message.name === 'workspace_agents' ||
      message.name === 'agent_peer_context' && message.content.includes('same_project_coordination')));
  } finally { release.resolve(); await eligible; }
  assert.equal(requests.size, 2);
});

test('A, B and C share an actual workspace: terminal and file writes arbitrate by path and revision',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async t => {
    const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'cardbush-abc-coordination-'));
    const work = join(directory, 'work'), overlap = join(work, 'style.css'), separate = join(work, 'main.js');
    await mkdir(work);
    await Promise.all([writeFile(overlap, 'style-baseline'), writeFile(separate, 'script-baseline')]);
    const expected = createHash('sha256').update('style-baseline').digest('hex');
    const registry = new ToolRegistry(), counts = new Map(), outcome = new Map();
    const aRead = Promise.withResolvers(), bRead = Promise.withResolvers(), aHeld = Promise.withResolvers(),
      bBlocked = Promise.withResolvers(), cWrote = Promise.withResolvers(), aDone = Promise.withResolvers(), bDone = Promise.withResolvers();
    const gates = [aRead, bRead, aHeld, bBlocked, cWrote, aDone, bDone];
    const timeout = AbortSignal.timeout(35_000), providerFailure = Promise.withResolvers();
    const awaitGate = async gate => {
      const expired = Promise.withResolvers();
      const abort = () => expired.reject(timeout.reason);
      timeout.throwIfAborted();
      timeout.addEventListener('abort', abort, { once: true });
      try { await Promise.race([gate.promise, expired.promise, providerFailure.promise.then(error => { throw error; })]); }
      finally { timeout.removeEventListener('abort', abort); }
    };
    const roomId = request => {
      const message = request.messages.findLast(item => item.name === 'agent_peer_context' && item.content.includes('Workspace agent context.'));
      return message && JSON.parse(message.content.split('\n').at(-1)).coordination?.room_id;
    };
    const terminal = (command, extra = {}) => ({ command, cwd: work, shell: 'powershell', yield_time_ms: 10_000, ...extra });
    const declared = [{ path: 'style.css', expected_sha256: expected }];
    let aHandle, bRoom;
    const host = new InMemoryRuntimeHost({ dataRoot: join(directory, 'runtime'), toolRegistry: registry,
      commandSandbox: { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] },
      provider: { async *stream(request) {
        try { yield* stream(request); }
        catch (error) { providerFailure.resolve(error); throw error; }
      } } });
    async function* stream(request) {
        const agent = request.sessionId, round = (counts.get(agent) ?? 0) + 1;
        counts.set(agent, round);
        const event = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
        const rawReceipt = request.messages.findLast(item => item.role === 'tool')?.content ?? '';
        const receipt = () => {
          const blocks = rawReceipt.split('\n\n');
          return JSON.parse(blocks[0].startsWith('{"runtimeError":') ? blocks[1] : blocks[0]);
        };
        const call = (name, args) => ({ name, args });
        let next;
        yield { ...event, sequence: 0, kind: 'response_started' };
        if (agent === 'a') {
          if (round === 1) next = call('read_file', { path: overlap });
          if (round === 2) {
            aRead.resolve();
            await awaitGate(bRead);
            next = call('terminal_exec', terminal(
              "[IO.File]::WriteAllText('style.css', 'style-from-A'); [void][Console]::ReadLine()",
              { write_paths: declared, yield_time_ms: 20, notify_on_exit: false }));
          }
          if (round === 3) {
            const running = receipt();
            assert.equal(running.state, 'running', rawReceipt);
            aHandle = running.terminalSessionId;
            aHeld.resolve();
            await Promise.all([awaitGate(bBlocked), awaitGate(cWrote)]);
            next = call('terminal_write', { session_id: aHandle, chars: '\n', yield_time_ms: 10_000 });
          }
          if (round > 3) {
            const done = receipt();
            if (done.state === 'running') next = call('terminal_poll', { session_id: aHandle, yield_time_ms: 1000 });
            else {
              assert.equal(done.exitCode, 0, rawReceipt);
              aDone.resolve();
            }
          }
        } else if (agent === 'b') {
          if (round === 1) { bRoom = roomId(request); assert.ok(bRoom); next = call('read_file', { path: overlap }); }
          if (round === 2) {
            bRead.resolve();
            await awaitGate(aHeld);
            next = call('write_file', { path: overlap, content: 'style-from-B' });
          }
          if (round === 3) {
            assert.match(rawReceipt, /workspace_resource_busy/);
            outcome.set('busy', rawReceipt);
            next = call('terminal_exec', terminal("[IO.File]::WriteAllText('style.css', 'style-from-B')", { write_paths: declared }));
          }
          if (round === 4) {
            assert.match(rawReceipt, /terminal_resource_busy/);
            bBlocked.resolve();
            await awaitGate(aDone);
            next = call('terminal_exec', terminal("[IO.File]::WriteAllText('style.css', 'style-from-B')", { write_paths: declared }));
          }
          if (round === 5) {
            assert.match(rawReceipt, /workspace_revision_conflict/);
            outcome.set('stale', rawReceipt);
            next = call('terminal_exec', terminal("[IO.File]::WriteAllText('main.js', 'undeclared-from-B')"));
          }
          if (round === 6) {
            const denied = receipt();
            assert.equal(denied.sandbox?.backend, 'windows-appcontainer', rawReceipt);
            assert.equal(denied.commandStarted, true, rawReceipt);
            assert.match(rawReceipt, /terminal_permission_denied/);
            assert.ok(Number.isInteger(denied.exitCode) && denied.exitCode !== 0, rawReceipt);
            bDone.resolve();
          }
        } else {
          if (round === 1) { assert.equal(roomId(request), bRoom); next = call('read_file', { path: separate }); }
          if (round === 2) next = call('write_file', { path: separate, content: 'script-from-C' });
          if (round === 3) {
            assert.equal(await readFile(separate, 'utf8'), 'script-from-C');
            outcome.set('parallel', rawReceipt);
            cWrote.resolve();
            await awaitGate(bDone);
          }
        }
        if (next) {
          yield { ...event, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `${agent}-${round}`,
            nameDelta: next.name, argumentsDelta: JSON.stringify(next.args) };
        } else yield { ...event, sequence: 1, kind: 'text_delta', delta: 'Fixture completed.' };
        yield { ...event, sequence: 2, kind: 'response_completed', finishReason: next ? 'tool_calls' : 'stop' };
    }
    host.installExtension(create, { id: 'agentchatroom', enabled: true, dataDirectory: join(directory, 'plugin') });
    const run = id => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `r-${id}`, sessionId: id, turnId: `t-${id}`,
      model: 'fixture', prefixMessages: [{ role: 'system', content: 'Isolated coordination fixture.' }],
      inputMessages: [{ messageId: `u-${id}`, message: { role: 'user', content: 'Run the fixture.' } }],
      tools: registry.definitions(), permissionMode: 'all_free', metadata: { workspaceDir: work, projectDir: work, environmentContext: true },
    }, { signal: timeout });
    t.after(async () => {
      gates.forEach(gate => gate.resolve());
      await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
      assert.equal(resolve(directory, '..'), base);
      assert.ok(directory.startsWith(join(base, 'cardbush-abc-coordination-')));
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    });
    const a = run('a');
    await awaitGate(aRead);
    const b = run('b');
    await awaitGate(aHeld);
    const c = run('c');
    const completed = await Promise.race([Promise.all([a, b, c]), providerFailure.promise.then(error => { throw error; })]);
    assert.ok(completed.every(result => result.payload.status === 'completed'), JSON.stringify(completed));
    assert.deepEqual([...outcome.keys()].sort(), ['busy', 'parallel', 'stale']);
    assert.equal(await readFile(overlap, 'utf8'), 'style-from-A');
    assert.equal(await readFile(separate, 'utf8'), 'script-from-C');
  });

test('concurrent same-project turns reuse one temporary room and admit a late third participant', async t => {
  const f = await fixture(t), a = f.add('a'), b = f.add('b');
  const child = f.add('child', 'project', 'running', true);
  child.projectCoordinationAvailable = false;
  const internal = f.add('internal'); internal.projectCoordinationAvailable = false;
  f.add('other-project', 'other');
  await Promise.all([a, b, a, child, internal].map(fact => f.plugin.conversationChanged(fact)));
  const invitations = f.notifications.filter(item => JSON.parse(item.content).event === 'same_project_coordination');
  assert.deepEqual(invitations.map(item => item.id).sort(), ['a', 'b']);
  const offer = JSON.parse(invitations[0].content), { room_id } = offer;
  assert.equal(offer.action, 'join');
  assert.match(offer.guidance, /paths you plan to write.*one writer and a handoff/);
  assert.ok(invitations.every(item => JSON.parse(item.content).room_id === room_id && !item.wake));
  await assert.rejects(f.call('a', 'join', { room_id: 'Workspace coordination' }), {
    code: 'room_id_invalid', details: { phase: 'validation_rejected' },
  });
  const joined = await Promise.all([f.call('a', 'join'), f.call('b', 'join', { room_id })]);
  assert.deepEqual(joined.map(receipt => receipt.room_id), [room_id, room_id]);
  await f.call('a', 'send', { room_id, text: 'I own css/style.css.', client_message_id: 'own-style' });
  await f.reload();
  const c = f.add('c');
  const [catalog] = await Promise.all([f.plugin.conversationContext(c), f.plugin.conversationChanged(c)]);
  const view = JSON.parse(catalog[0].content.split('\n').at(-1));
  assert.equal(view.coordination.room_id, room_id);
  assert.equal(view.rooms.length, 1);
  assert.deepEqual({ ...view.rooms[0], members: view.rooms[0].members.sort() }, { room_id, joined: false, unread: 0, members: ['a', 'b'], temporary: true });
  await assert.rejects(f.call('c', 'read', { room_id }), /Join this room/);
  assert.equal((await f.call('c', 'join', { room_id })).idle_wake, 'disabled for temporary coordination');
  assert.deepEqual((await f.call('c', 'read', { room_id })).messages.map(message => message.text), ['I own css/style.css.']);
  await f.call('c', 'send', { room_id, text: 'I own js/main.js.', client_message_id: 'own-js' });
  assert.ok((await f.call('a', 'read', { room_id })).messages.some(message => message.text === 'I own js/main.js.'));
  const delivery = f.notifications.filter(item => item.key === `agentchatroom:room:${room_id}`);
  assert.ok(delivery.length > 0 && delivery.every(item => !item.wake));
  await assert.rejects(f.call('other-project', 'join', { room_id }), /active same-project/);
  await assert.rejects(f.call('child', 'join', { room_id, user_authorized: true }), /active same-project/);
  await assert.rejects(f.call('internal', 'join', { room_id }), /active same-project/);
  await assert.rejects(f.call('c', 'invite', { room_id, agent_id: 'other-project', reason: 'No grant' }), /regular room/);
  assert.equal(await readFile(join(f.directory, 'rooms/events.jsonl'), 'utf8'), '', 'automatic coordination writes no durable room messages');
  await assert.rejects(readFile(join(f.directory, 'memberships.json')), { code: 'ENOENT' });
});

test('temporary room keeps the remaining participants together and retires at the end of the group', async t => {
  const f = await fixture(t), a = f.add('a'), b = f.add('b');
  await f.plugin.conversationChanged(b);
  const { room_id } = (await f.call('a', 'discover')).coordination;
  await f.call('a', 'join', { room_id });
  await f.call('b', 'join', { room_id });
  const wait = f.api.conversations.wait;
  let waiting = Promise.withResolvers();
  f.api.conversations.wait = (...args) => { waiting.resolve(); return wait(...args); };
  const pending = f.call('a', 'read', { room_id, wait_ms: 30000 });
  await waiting.promise;
  waiting = Promise.withResolvers();
  const peerWait = f.call('b', 'read', { room_id, wait_ms: 30000 });
  await waiting.promise;
  a.status = 'stopped'; await f.plugin.conversationChanged(a);
  assert.equal((await pending).status, 'membership_revoked');
  assert.equal((await peerWait).status, 'peer_left');
  assert.deepEqual((await peerWait).departed_peers, [{ agent_id: 'a' }]);
  const c = f.add('c'); await f.plugin.conversationChanged(c);
  assert.equal((await f.call('c', 'discover')).coordination.room_id, room_id);
  await f.call('c', 'join', { room_id });
  await f.call('c', 'send', { room_id, text: 'Continue with the remaining member.', client_message_id: 'remaining' });
  assert.equal(f.notifications.some(item => item.id === 'a' && item.key === `agentchatroom:room:${room_id}`), false);
  await f.call('c', 'read', { room_id });
  waiting = Promise.withResolvers();
  const explicitExitWait = f.call('c', 'read', { room_id, wait_ms: 30000 });
  await waiting.promise;
  await f.call('b', 'leave', { room_id });
  assert.equal((await explicitExitWait).status, 'peer_left');
  assert.deepEqual((await explicitExitWait).departed_peers, [{ agent_id: 'b' }]);
  assert.equal((await f.call('b', 'discover')).coordination, undefined);
  b.status = 'idle'; c.status = 'stopped';
  await Promise.all([f.plugin.conversationChanged(b), f.plugin.conversationChanged(c)]);
  a.status = 'running'; a.turnId = 'turn-a-next';
  await f.plugin.conversationChanged(a);
  assert.deepEqual((await f.call('a', 'discover')).rooms, []);
  await assert.rejects(f.call('a', 'join', { room_id }), { code: 'room_ended' });
  await assert.rejects(f.call('a', 'read', { room_id }), { code: 'room_ended' });
  await f.reopen();
  await assert.rejects(f.call('a', 'join', { room_id }), { code: 'room_ended' });
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'temporary-room-ids.json'), 'utf8')), [room_id]);
  const d = f.add('d'); await f.plugin.conversationChanged(d);
  const nextRoom = (await f.call('a', 'discover')).coordination.room_id;
  assert.notEqual(nextRoom, room_id);
  await f.call('a', 'join', { room_id: nextRoom });
  assert.deepEqual((await f.call('a', 'read', { room_id: nextRoom })).messages, []);
});

test('one tool owns room coordination, reads or waits once, and persists membership/cursors', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  assert.deepEqual(f.api.tools.definitions().map(tool => tool.name), ['agentchatroom']);
  for (const action of ['discover','join','invite','send','read','wait','leave']) assert.equal(f.api.tools.resolve(`agentchatroom_${action}`), undefined);
  const view = await f.call('a', 'discover');
  assert.equal(view.tool, 'agentchatroom'); assert.equal(view.tools, undefined);
  const { room_id } = await f.call('a', 'join');
  assert.equal((await f.call('b', 'join')).room_id, room_id);
  const waiting = f.call('a', 'read', { room_id, wait_ms: 30000 });
  await f.call('b', 'send', { room_id, text: 'I own the interface', client_message_id: 'interface' });
  assert.deepEqual((await waiting).messages.map(item => item.text), ['I own the interface']);
  assert.equal((await f.call('a', 'read', { room_id })).messages.length, 0, 'the consumed page is not returned twice');
  await f.call('a', 'send', { room_id, text: 'I own the tests', client_message_id: 'tests' });
  const immediate = await f.call('b', 'read', { room_id, wait_ms: 30000 });
  assert.equal(immediate.messages.length, 2, 'existing messages return immediately without a separate wait call');
  await f.reload(); assert.equal((await f.call('b', 'read', { room_id })).messages.length, 0);
  await f.call('a', 'leave', { room_id });
  await assert.rejects(f.call('a', 'send', { room_id, text: 'left', client_message_id: 'left' }), /Join this room/);
});

test('canonical actions reject irrelevant fields and cannot become a child/peer messaging bypass', async t => {
  const f = await fixture(t); f.add('a', 'project', 'running', true);
  await assert.rejects(f.call('a', 'join', { agent_id: 'spoofed' }), /Unrecognized/);
  await assert.rejects(f.call('a', 'send', { room_id: 'room', text: 'missing retry identity' }), /client_message_id/);
  await assert.rejects(f.call('a', 'read', { room_id: 'room', wait_ms: 30001 }), /30000/);
  await assert.rejects(f.call('a', 'send', { room_id: 'room', text: 'no', client_message_id: 'no', user_authorized: true }), /Unrecognized/);
  await assert.rejects(f.call('a', 'read', { room_id: 'room' }), { code: 'room_id_invalid' });
});

test('active children share same-project coordination regardless of parent and require room membership', async t => {
  const f = await fixture(t); const parent = f.add('parent');
  const child = f.add('child', 'project', 'running', true);
  f.add('sibling', 'project', 'running', true);
  f.add('outsider', 'other-project', 'running', true);
  await f.plugin.conversationChanged(child); await f.plugin.conversationChanged(parent);
  assert.equal((await f.plugin.conversationContext(child)).length, 1);
  const { coordination, peers } = await f.call('child', 'discover');
  const { room_id } = coordination;
  assert.deepEqual(peers.map(peer => peer.agent_id), ['parent', 'sibling']);
  assert.equal((await f.call('sibling', 'discover')).coordination.room_id, room_id);
  await assert.rejects(f.call('sibling', 'read', { room_id }), /Join this room/);
  await assert.rejects(f.call('outsider', 'join', { room_id }), /only to the active same-project turns/);
  await f.call('child', 'join', { room_id });
  await f.call('sibling', 'join', { room_id });
  await f.call('child', 'send', { room_id, text: 'Ready', client_message_id: 'ready' });
  assert.deepEqual((await f.call('sibling', 'read', { room_id })).messages.map(message => message.text), ['Ready']);
});

test('child room membership and cursors persist across reload and leave removes access', async t => {
  const f = await fixture(t); f.add('parent');
  const child = f.add('child', 'project', 'running', true); f.add('sibling', 'project', 'running', true);
  const { room_id } = await f.call('parent', 'join');
  const joined = await f.call('child', 'join', { room_id }, { metadata: { agentRole: 'child' } });
  assert.match(joined.idle_wake, /controlled by its parent/);
  assert.equal((await f.call('child', 'join', { room_id })).joined, true);
  assert.deepEqual((await f.call('parent', 'discover')).peers.map(peer => peer.agent_id), ['child', 'sibling']);
  assert.equal((await f.plugin.conversationContext(child)).length, 1);
  await f.call('parent', 'send', { room_id, text: 'API ready', client_message_id: 'parent-1' });
  assert.ok(f.notifications.some(notice => notice.id === 'child' && notice.key === `room:${room_id}` && !notice.wake));
  assert.equal((await f.call('child', 'read', { room_id })).messages[0].text, 'API ready');
  const waiting = f.call('child', 'read', { room_id, wait_ms: 30000 });
  await f.call('parent', 'send', { room_id, text: 'Schema ready', client_message_id: 'parent-2' });
  assert.equal((await waiting).messages[0].text, 'Schema ready');
  await f.call('child', 'send', { room_id, text: 'Tests ready', client_message_id: 'child-1' });
  assert.ok((await f.call('parent', 'read', { room_id })).messages.some(message => message.text === 'Tests ready'));
  await f.plugin.dispose(); await f.reload();
  assert.equal((await f.call('child', 'join', { room_id })).joined, true);
  await assert.rejects(f.call('sibling', 'read', { room_id }), /Join this room/);
  await f.call('child', 'leave', { room_id });
  assert.equal((await f.call('parent', 'discover')).rooms.find(room => room.room_id === room_id).members.includes(child.agentId), false);
  await assert.rejects(f.call('child', 'read', { room_id }), /Join this room/);
  await f.call('parent', 'send', { room_id, text: 'after leave', client_message_id: 'parent-3' });
  assert.equal(f.notifications.some(notice => notice.id === 'child' && notice.key === `room:${room_id}`), false);
  assert.equal((await f.call('child', 'join', { room_id, user_authorized: true })).joined, true);
});

test('child room access is project-scoped and cross-project acceptance requires an invitation', async t => {
  const f = await fixture(t); f.add('parent'); f.add('backend', 'backend'); f.add('child', 'project', 'running', true);
  const own = await f.call('parent', 'join'); const remote = await f.call('backend', 'join');
  await f.call('child', 'join', { room_id: own.room_id });
  await assert.rejects(f.call('child', 'join', { room_id: remote.room_id, user_authorized: true }), /explicit invitation/);
  await f.call('backend', 'invite', { room_id: remote.room_id, agent_id: 'child', reason: 'API coordination' });
  await assert.rejects(f.call('child', 'read', { room_id: remote.room_id }), /Join this room/);
  await f.call('child', 'join', { room_id: remote.room_id });
  await f.call('child', 'send', { room_id: remote.room_id, text: 'Contract confirmed', client_message_id: 'contract' });
  assert.equal((await f.call('backend', 'read', { room_id: remote.room_id })).messages[0].text, 'Contract confirmed');
  f.facts.get('child').projectDir = f.facts.get('child').workspaceDir = join(f.directory, 'moved');
  await assert.rejects(f.call('child', 'join', { room_id: own.room_id }), /explicit invitation/);
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
  const waiting = f.call('a', 'read', { room_id, wait_ms: 30000 });
  await f.call('b', 'send', { room_id, text: 'ready', client_message_id: 'ready' });
  assert.equal((await waiting).messages[0].text, 'ready'); await f.call('b', 'read', { room_id });
  assert.deepEqual((await f.call('a', 'read', { room_id })).messages, []);
  const controller = new AbortController();
  const cancelled = f.call('a', 'read', { room_id, wait_ms: 30000 }, { signal: controller.signal }); controller.abort();
  assert.equal((await cancelled).status, 'cancelled');
  const leaving = f.call('b', 'read', { room_id, wait_ms: 30000 });
  await f.call('b', 'leave', { room_id }); assert.equal((await leaving).status, 'membership_revoked');
  const reloading = f.call('a', 'read', { room_id, wait_ms: 30000 });
  // Ensure this invocation has entered its wait before replacing the instance.
  await new Promise(resolve => setTimeout(resolve, 10)); await f.reload(); assert.equal((await reloading).status, 'cancelled');
  const before = f.notifications.filter(item => item.id === 'b' && item.wake).length;
  await f.call('a', 'send', { room_id, text: 'after leave', client_message_id: 'after' });
  assert.equal(f.notifications.filter(item => item.id === 'b' && item.wake).length, before);
});

test('host identity cannot be spoofed and shadow/automation sessions remain excluded', async t => {
  const f = await fixture(t); f.add('a');
  for (const metadata of [{ agentRole: 'child' }, { parentSessionId: 'parent' }]) {
    await assert.rejects(f.call('a', 'join', { user_authorized: true }, { metadata }), /host has not registered/);
  }
  for (const metadata of [{ shadowMode: 'fork' }, { automationRunId: 'job' }]) {
    await assert.rejects(f.call('a', 'join', { user_authorized: true }, { metadata }), /through their parent/);
  }
  await assert.rejects(f.call('missing', 'discover'), /active conversation/);
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
  await f.plugin.conversationChanged(f.facts.get('a'));
  assert.equal((await f.call('a', 'discover')).peers[0].relation, 'same_project');
  assert.equal((await f.call('a', 'discover')).coordination.room_id, (await f.call('b', 'discover')).coordination.room_id);
  assert.equal(f.facts.get('b').workspaceDir, join(f.directory, 'copy'));
});

test('deferred call_tool allows children with the tool enabled and enforces explicit child tool policy', async t => {
  const f = await fixture(t); await f.plugin.dispose();
  f.add('a', 'project', 'running', true).turnId = 't';
  const registry = new ToolRegistry(), host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  let extension;
  host.installExtension(api => extension = create({ ...api, conversations: f.api.conversations }), { id: 'agentchatroom', enabled: true, dataDirectory: join(f.directory, 'host') });
  t.after(async () => { host.removeExtension('agentchatroom'); await extension.dispose(); });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'a', turnId: 't', model: 'fixture', messages: [], tools: registry.definitions(), metadata: {}, permissionMode: 'all_free' };
  assert.deepEqual(request.tools.filter(tool => tool.name.startsWith('agentchatroom')).map(tool => tool.name), ['agentchatroom']);
  assert.equal(registry.resolve('agentchatroom_join'), undefined, 'retired handlers are not staged');
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
  assert.equal((await run('call_tool', { name: 'agentchatroom', arguments: { action: 'join' } })).kind, 'returned');
  request.metadata.disabledTools = ['agentchatroom'];
  assert.equal((await run('call_tool', { name: 'agentchatroom', arguments: { action: 'join', user_authorized: true } })).error.code, 'child_agent_tool_unavailable');
  host.removeExtension('agentchatroom');
  await extension.dispose();
});

test('actual Runtime delivers peer context at safe boundaries and wakes only joined idle sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-peer-runtime-'));
  const registry = new ToolRegistry(), observed = [], errors = [], gate = Promise.withResolvers(), gateB = Promise.withResolvers();
  let extension, firstA = true, firstB = true;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false,
    onRecoveryError: error => errors.push(error), provider: { async *stream(request) {
      observed.push(structuredClone(request));
      if (request.sessionId === 'a' && firstA) { firstA = false; await gate.promise; }
      if (request.sessionId === 'b' && firstB) { firstB = false; await gateB.promise; }
      yield event(request, 0, 'text_delta', { delta: 'Coordination checked.' });
      yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    } } });
  host.installExtension(api => extension = create(api), { id: 'agentchatroom', enabled: true, dataDirectory: join(directory, 'plugin') });
  t.after(async () => {
    gate.resolve(); gateB.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    host.removeExtension('agentchatroom'); await extension.dispose();
    assert.ok(directory.startsWith(tmpdir() + sep)); await rm(directory, { recursive: true, force: true });
  });
  const request = (id, turn = `turn-${id}`) => ({ protocol: 'bush.session_turn_request.v1', sessionId: id, turnId: turn, requestId: `r-${turn}`,
    model: 'fixture', prefixMessages: [{ role: 'system', content: 'fixed-prefix' }],
    inputMessages: [{ messageId: `user-${turn}`, message: { role: 'user', content: `Own task ${id}` } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { projectDir: directory, workspaceDir: directory, environmentContext: true } });
  const call = (id, name, args) => {
    const tool = registry.resolve('agentchatroom');
    return tool.execute({ sessionId: id, turnId: `turn-${id}`, input: tool.decodeInput({action: name, ...args}), turn: { request: { metadata: {} } } });
  };
  const runningA = host.runSessionTurn(request('a')); await until(() => observed.some(req => req.sessionId === 'a'));
  const { room_id } = await call('a', 'join', {});
  // B's context and turn start happen before its provider response, so send while it is active.
  let joinedB, automaticRoom, thirdRoom;
  const previousContext = extension.conversationContext;
  extension.conversationContext = async fact => {
    const result = await previousContext(fact);
    if (fact.agentId === 'b') {
      automaticRoom = JSON.parse(result[0].content.split('\n').at(-1)).coordination.room_id;
      assert.equal((await call('b', 'join', {})).room_id, automaticRoom);
      await call('b', 'send', { room_id: automaticRoom, text: 'I will edit css/style.css.', client_message_id: 'auto-b' });
      joinedB = await call('b', 'join', { room_id });
      await call('b', 'send', { room_id, text: 'I own the API contract; please own the UI.', client_message_id: 'b-first' });
    } else if (fact.agentId === 'c') {
      thirdRoom = JSON.parse(result[0].content.split('\n').at(-1)).coordination.room_id;
      await call('c', 'join', { room_id: thirdRoom });
      assert.ok((await call('c', 'read', { room_id: thirdRoom })).messages.some(message => message.text === 'I will edit css/style.css.'));
    }
    return result;
  };
  const runningB = host.runSessionTurn(request('b'));
  await until(() => observed.some(req => req.sessionId === 'b'));
  await host.runSessionTurn(request('c'));
  assert.equal(thirdRoom, automaticRoom);
  assert.notEqual(automaticRoom, room_id);
  gateB.resolve(); await runningB;
  assert.equal(joinedB.room_id, room_id);
  const bMessages = observed.find(req => req.sessionId === 'b').messages;
  const environment = JSON.parse(bMessages.find(message => message.name === 'runtime_environment').content);
  assert.ok(environment.sections.agents.items.some(fact => fact.agentId === 'a'));
  const catalog = bMessages.find(message => message.name === 'agent_peer_context' && message.visibility === 'internal' && message.content.includes('Workspace agent context.'));
  const observedOffer = JSON.parse(catalog.content.split('\n').at(-1));
  assert.ok(observedOffer.peers.some(peer => peer.agent_id === 'a'));
  assert.equal(observedOffer.coordination.room_id, automaticRoom);
  gate.resolve(); await runningA;
  const aRequests = observed.filter(req => req.sessionId === 'a');
  assert.ok(aRequests.some(req => req.messages.some(message => message.name === 'agent_peer_context' && message.visibility === 'internal' &&
    message.content.includes('same_project_coordination') && message.content.includes(automaticRoom))));
  assert.ok(aRequests.every(req => req.messages[0].content === 'fixed-prefix'));
  assert.ok(aRequests.every(req => req.tools.every(tool => !tool.name.startsWith('agentchatroom_'))));
  // A second human turn in B sends to idle joined A. Runtime starts a normal persisted follow-up.
  extension.conversationContext = async fact => {
    const result = await previousContext(fact);
    if (fact.agentId === 'b') {
      const tool = registry.resolve('agentchatroom');
      await tool.execute({ sessionId: 'b', turnId: fact.turnId, input: tool.decodeInput({ action: 'send', room_id, text: 'Schema is v2', client_message_id: 'b-next' }), turn: { request: { metadata: {} } } });
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

test('a real forked child joins, exchanges messages and stays finished after later room activity', async t => {
  const f = await fixture(t); await f.plugin.dispose();
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), seen = [], rounds = new Map();
  let extension, conversations, roomId;
  const call = (fact, action, input = {}) => {
    const tool = registry.resolve('agentchatroom');
    return tool.execute({ sessionId: fact.agentId, turnId: fact.turnId, input: tool.decodeInput({ action, ...input }),
      turn: { request: { metadata: {} } } });
  };
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, subagentTaskStore: tasks, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      seen.push(structuredClone(request));
      const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
      let name, args;
      if (request.metadata.agentRole === 'child') {
        if (round === 1) { name = 'get_tool_schema'; args = { name: 'agentchatroom' }; }
        if (round === 2) { name = 'call_tool'; args = { name: 'agentchatroom', arguments: { action: 'join', room_id: roomId } }; }
        if (round === 3) {
          await call(conversations.list().find(fact => fact.agentId === 'parent'), 'send', { room_id: roomId, text: 'API v2', client_message_id: 'parent-v2' });
          name = 'call_tool'; args = { name: 'agentchatroom', arguments: { action: 'send', room_id: roomId, text: 'Tests verified', client_message_id: 'child-tests' } };
        }
        if (round === 4) {
          name = 'call_tool'; args = { name: 'agentchatroom', arguments: { action: 'read', room_id: roomId } };
        }
        if (round === 5) {
          assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('API v2')));
          const page = await call(conversations.list().find(fact => fact.agentId === 'parent'), 'read', { room_id: roomId });
          assert.ok(page.messages.some(message => message.text === 'Tests verified'));
        }
      } else if (request.turnId === 'dispatch' && round === 1) {
        name = 'subagent'; args = { prompt: 'Implement tests.', mode: 'fork' };
      }
      if (name) yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: `${request.turnId}-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(args) });
      else yield event(request, 0, 'text_delta', { delta: 'Finished assigned work.' });
      yield event(request, 1, 'response_completed', { finishReason: name ? 'tool_calls' : 'stop' });
    } } });
  host.installExtension(api => { conversations = api.conversations; return extension = create(api); },
    { id: 'agentchatroom', enabled: true, dataDirectory: join(f.directory, 'runtime') });
  t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); host.removeExtension('agentchatroom'); await extension.dispose(); });
  const context = extension.conversationContext;
  extension.conversationContext = async fact => {
    if (fact.agentId === 'parent') {
      roomId = (await call(fact, 'join')).room_id;
      if (fact.turnId === 'after-child') await call(fact, 'send', { room_id: roomId, text: 'Later change', client_message_id: 'later' });
    }
    return context(fact);
  };
  const request = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turnId}`, sessionId: 'parent', turnId, model: 'fixture',
    prefixMessages: [], inputMessages: [{ messageId: `u-${turnId}`, message: { role: 'user', content: 'Delegate tests.' } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { projectDir: f.directory, workspaceDir: f.directory, environmentContext: true } });
  assert.equal((await host.runSessionTurn(request('dispatch'))).payload.status, 'completed');
  const task = tasks.list('parent')[0]; assert.ok(task); assert.equal(task.status, 'completed');
  const childRequests = seen.filter(item => item.sessionId === task.childSessionId);
  assert.ok(childRequests.some(item => item.messages.some(message => message.name === 'agent_peer_context' && message.content.includes('unread_room_messages'))));
  // Presence is available to every child; collaboration membership still requires joining.
  const childEnvironment = childRequests[0].messages.filter(message => message.name === 'runtime_environment').map(message => JSON.parse(message.content)).find(fact => fact.sessionId === task.childSessionId);
  assert.equal(childEnvironment.sections.agents.self.agentId, task.childSessionId);
  assert.ok(childRequests[0].messages.some(message => message.name === 'agent_peer_context' &&
    message.content.includes('Workspace agent context.') && message.content.includes(`"self":"${task.childSessionId}"`)));
  const history = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: task.childSessionId } });
  assert.equal(history.turns.length, 1);
  assert.equal((await host.runSessionTurn(request('after-child'))).payload.status, 'completed');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(seen.filter(item => item.sessionId === task.childSessionId).length, childRequests.length);
  assert.equal(tasks.list('parent').length, 1);
});

for (const sameParent of [true, false]) {
  test(`real child editors exchange messages ${sameParent ? 'under Assistant' : 'across parents'}`, { timeout: 40_000 }, async t => {
    const f = await fixture(t); await f.plugin.dispose();
    const workspace = await realpath(f.directory);
    const project = join(workspace, 'editors');
    await mkdir(project);
    const path = name => join(project, name);
    const part = name => path(`part-${name}.md`);
    const log = path('log.md');
    await Promise.all([writeFile(part('A'), 'Draft A\n'), writeFile(part('B'), 'Draft B\n'), writeFile(log, '# Log\n')]);
    const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), sessions = new SessionStore();
    sessions.ensureSession(PERSONAL_ASSISTANT_SESSION);
    const steps = new Map(), children = new Map(), rooms = new Map(), inbox = new Map();
    const started = Promise.withResolvers(), joined = Promise.withResolvers(), sent = Promise.withResolvers(), firstLogged = Promise.withResolvers();
    const joins = new Set(), sends = new Set();
    const labels = ['A', 'B'];
    const hash = content => createHash('sha256').update(content).digest('hex');
    const messageText = name => `${name} finished editing part-${name}.md`;
    const call = (name, args) => ({ name, args });
    const chat = (action, args = {}) => call('call_tool', { name: 'agentchatroom', arguments: { action, ...args } });
    const childCall = name => call('subagent', { name, prompt: `Edit part-${name}.md, then coordinate the shared log with the other editor.` });
    const output = (request, round, ordinal = 0) => {
      const id = `${request.turnId}:${round}:${ordinal}`;
      const receipt = request.messages.find(message => message.role === 'tool' && message.toolCallId === id);
      assert.ok(receipt, `missing tool receipt ${id}`);
      return JSON.parse(receipt.content.split('\n\n', 1)[0]);
    };
    const providerFailures = [];
    const host = new InMemoryRuntimeHost({ toolRegistry: registry, subagentTaskStore: tasks, sessionStore: sessions, dataRoot: join(f.directory, 'state'),
      provider: {
        async *stream(request) {
          try {
            const round = (steps.get(request.turnId) ?? 0) + 1; steps.set(request.turnId, round);
            const name = request.metadata.subagentName;
            let calls = [];
            if (request.metadata.agentRole === 'child') {
              const other = name === 'A' ? 'B' : 'A';
              assert.ok(labels.includes(name));
              if (round === 1) {
                children.set(name, request.sessionId);
                if (children.size === 2) started.resolve();
                calls = [call('read_file', { path: part(name) }), call('read_file', { path: log })];
              } else if (round === 2) {
                const receipt = output(request, 1);
                assert.equal(receipt.sha256, hash(`Draft ${name}\n`), JSON.stringify(receipt));
                calls = [call('edit_file', { path: part(name), old_text: `Draft ${name}`, new_text: `Edited by ${name}` }),
                  call('get_tool_schema', { name: 'agentchatroom' })];
              } else if (round === 3) {
                assert.equal(await readFile(part(name), 'utf8'), `Edited by ${name}\n`);
                await started.promise;
                calls = [chat('discover')];
              } else if (round === 4) {
                const discovery = output(request, 3);
                assert.ok(discovery.peers.some(peer => peer.agent_id === children.get(other)));
                rooms.set(name, discovery.coordination.room_id);
                calls = [chat('join', { room_id: rooms.get(name) })];
              } else if (round === 5) {
                assert.equal(output(request, 4).joined, true);
                joins.add(name); if (joins.size === 2) joined.resolve();
                await joined.promise;
                calls = [chat('send', { room_id: rooms.get(name), text: messageText(name), client_message_id: `editor-${name}`, to_agent_ids: [children.get(other)] })];
              } else if (round === 6) {
                assert.equal(output(request, 5).duplicate, false);
                sends.add(name); if (sends.size === 2) sent.resolve();
                await sent.promise;
                calls = [chat('read', { room_id: rooms.get(name), wait_ms: 1000 })];
              } else if (round === 7) {
                const received = output(request, 6).messages.find(message => message.text === messageText(other));
                assert.ok(received, `${name} did not read the other editor's message`);
                inbox.set(name, received.text);
                if (name === 'B') await firstLogged.promise;
                calls = [call('read_file', { path: log })];
              } else if (round === 8) {
                const content = name === 'A' ? '# Log\n' : '# Log\nA received B\n';
                assert.equal(output(request, 7).sha256, hash(content));
                calls = [call('edit_file', { path: log, old_text: content, new_text: `${content}${name} received ${other}\n` })];
              } else if (round === 9) {
                assert.match(await readFile(log, 'utf8'), new RegExp(`${name} received ${other}`));
                if (name === 'A') firstLogged.resolve();
              }
            } else if (round === 1) {
              calls = (sameParent ? labels : [request.sessionId === 'parent-A' ? 'A' : 'B']).map(childCall);
            }
            for (const [index, item] of calls.entries()) yield event(request, index, 'tool_call_delta', {
              index, toolCallId: `${request.turnId}:${round}:${index}`, nameDelta: item.name, argumentsDelta: JSON.stringify(item.args),
            });
            if (!calls.length) yield event(request, 0, 'text_delta', { delta: name ? `${name} finished.` : 'Editors dispatched.' });
            yield event(request, Math.max(1, calls.length), 'response_completed', { finishReason: calls.length ? 'tool_calls' : 'stop' });
          } catch (error) {
            providerFailures.push(error);
            throw error;
          }
        },
      },
    });
    host.installExtension(create, { id: 'agentchatroom', enabled: true, dataDirectory: join(f.directory, 'chatroom') });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const content = 'Have two child agents edit the project in parallel and exchange direct messages.';
    const request = sessionId => ({ protocol: 'bush.session_turn_request.v1', requestId: `request-${sessionId}`,
      sessionId, turnId: `turn-${sessionId}`, model: 'fixture', prefixMessages: [],
      inputMessages: [{ messageId: `input-${sessionId}`, message: { role: 'user', content } }], tools: registry.definitions(),
      permissionMode: 'all_free', metadata: { projectDir: project, workspaceDir: workspace, individuation: { habits: false, predictions: false } } });
    const parents = sameParent ? [PERSONAL_ASSISTANT_SESSION] : ['parent-A', 'parent-B'];
    if (sameParent) {
      await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'turn', sessionId: PERSONAL_ASSISTANT_SESSION,
        profile: assistantProfileSchema.parse({}), parent: request(PERSONAL_ASSISTANT_SESSION),
        entry: { id: `input-${PERSONAL_ASSISTANT_SESSION}`, role: 'user', content, visibility: 'conversation', source: 'text', createdAt: new Date().toISOString() },
      } });
    } else {
      await Promise.all(parents.map(sessionId => host.runSessionTurn(request(sessionId))));
    }
    const settled = () => parents.flatMap(parent => tasks.list(parent));
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && (settled().length !== 2 || settled().some(task => task.status === 'running')))
      await new Promise(resolve => setTimeout(resolve, 30));
    if (providerFailures.length) throw new AggregateError(providerFailures, 'Fixture prepared unexpected child inputs');
    assert.deepEqual(settled().map(task => [task.status, task.errorMessage]), [['completed', ''], ['completed', '']]);
    assert.equal(rooms.get('A'), rooms.get('B'));
    assert.equal(inbox.get('A'), messageText('B'));
    assert.equal(inbox.get('B'), messageText('A'));
    assert.equal(await readFile(log, 'utf8'), '# Log\nA received B\nB received A\n');
  });
}

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
