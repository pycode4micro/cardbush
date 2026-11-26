import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import test from 'node:test';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as sessionId } from '@cardbush/bush-protocol';
import {
  FileRuntimeEventPersistence, FileSessionEventPersistence, FileSubagentTaskPersistence,
  InMemoryRuntimeEventLog, InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry,
} from '../dist/index.js';

const startText = 'Fixture task dispatched.';
const stopText = 'Fixture task stopped.';
const lateText = 'Fixture completed after being stopped.';
const capabilityId = 'fixture:read';
const prefix = ['dispatch', 'wait-for-approval', 'stop'];
const allowedEvents = new Set(['late-approval', 'late-completion', 'repeat-stop-receipt', 'deliver', 'reconnect']);
const version = 1;
const resultPollInterval = 1200;
const seedFromEnv = process.env.CARDBUSH_STOP_REPLAY_SEED;
const replayPath = process.env.CARDBUSH_STOP_REPLAY_FILE;
const persisted = value => JSON.parse(JSON.stringify(value));

function seededEvents(seed) {
  // Low three bits give all eight combinations for consecutive seeds.
  const order = Math.imul(seed, 1664525) + 1013904223;
  const pair = reversed => reversed ? ['late-completion', 'late-approval'] : ['late-approval', 'late-completion'];
  return [...pair(order & 1), 'repeat-stop-receipt', ...(order & 2 ? ['deliver'] : []),
    'reconnect', ...pair(order & 4)];
}

function scriptResponse(request, output) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  const text = typeof output === 'string';
  return [
    { ...base, sequence: 0, kind: 'response_started' },
    text ? { ...base, sequence: 1, kind: 'text_delta', delta: output } : {
      ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: output.name,
      nameDelta: output.name, argumentsDelta: JSON.stringify(output.args ?? {}),
    },
    { ...base, sequence: 2, kind: 'response_completed', finishReason: text ? 'stop' : 'tool_calls' },
  ];
}

async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await yieldTurn();
  }
  assert.fail(label);
}

async function replay(events, tick) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-stop-replay-'));
  const effects = [], requests = [], attention = [], recoveryErrors = [];
  const profile = assistantProfileSchema.parse({});
  let connection, child, approval, terminal, entryCount, step = 'setup';
  const send = (kind, payload) => connection.host.sendCommand({ kind, payload });
  const command = payload => send('runtime.assistant_conversation', { sessionId, ...payload });
  const read = () => command({ action: 'read' });
  const provider = { async *stream(request) {
    let output;
    if (request.metadata.agentRole === 'child') {
      const round = requests.filter(item => item === 'child').length;
      requests.push('child');
      output = round === 0 ? { name: 'replay_probe' } : round === 1 ? { name: 'replay_protected' } : lateText;
    } else {
      const result = request.messages.findLast(message => message.name === 'background_task_result');
      if (result) {
        requests.push('result');
        output = JSON.parse(result.content).status === 'stopped' ? stopText : lateText;
      } else {
        output = requests.includes('dispatch') ? startText : { name: 'subagent', args: { prompt: 'Read the replay fixture.' } };
        requests.push(typeof output === 'string' ? 'acknowledge' : 'dispatch');
      }
    }
    yield* scriptResponse(request, output);
  } };
  function connect() {
    const registry = new ToolRegistry();
    for (const name of ['replay_probe', 'replay_protected']) {
      const protectedTool = name === 'replay_protected';
      registry.register({
        definition: { name, description: 'Record a synthetic tool execution.', inputSchema: { type: 'object' } },
        manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false },
        visibleToChild: true, decodeInput: input => input,
        ...(protectedTool ? { authorize: () => ({ kind: 'ask', request: {
          reason: 'Read the protected replay fixture', actions: ['external_tool_call'],
          targets: [{ kind: 'mcp_resource', value: 'mcp://fixture/tools/replay_protected' }],
          capabilityIds: [capabilityId], requiresHuman: true,
        } }) } : {}),
        execute: () => { effects.push(name); return { ok: true }; },
      });
    }
    const sessions = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    const events = new FileRuntimeEventPersistence({ root: join(root, 'events') });
    const journal = new FileSubagentTaskPersistence({ root: join(root, 'tasks') });
    const tasks = new SubagentTaskStore({ persistence: journal });
    const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, provider, subagentTaskStore: tasks,
      sessionStore: new SessionStore({ persistence: sessions }), eventLog: new InMemoryRuntimeEventLog({ persistence: events }),
      onAssistantAttention: notice => attention.push(notice), onRecoveryError: error => recoveryErrors.push(error),
    });
    return { host, tasks, journal, tools: registry.definitions(), async close() {
      try { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
      finally { journal.close(); events.close(); sessions.close(); }
    } };
  }

  const settleDelivery = async () => {
    tick();
    await until(async () => {
      const view = await read();
      return !view.busy && (view.error || requests.includes('result'));
    }, 'stopped result was not delivered');
  };
  const statusOfChild = () => connection.tasks.get(sessionId, child.taskId);
  const childEvents = () => connection.host.events(child.childSessionId, child.childTurnId);
  const rejectLateApproval = () => assert.rejects(send('runtime.answer_permission', { protocol: 'bush.runtime_permission_answer.v1',
    permissionId: approval.permissionId, answerId: 'replayed-approval', decision: 'allow_once',
    grantedCapabilityIds: [capabilityId] }), { code: 'permission_not_pending' }, 'stale approval must be rejected');
  const terminalReceipt = () => ({ parentSessionId: sessionId, taskId: child.taskId, status: terminal.status,
    finalResponse: terminal.finalResponse, errorMessage: terminal.errorMessage, usage: terminal.usage,
    submission: terminal.submission, diagnostics: terminal.diagnostics });

  async function checkStopped() {
    const view = await read();
    assert.equal(view.error, '', 'Assistant ended with an error');
    assert.equal(view.workingTasks, 0, 'stopped task returned to the active list');
    assert.deepEqual(view.management.permissions, [], 'stopped approval returned to the pending list');
    assert.deepEqual(persisted(connection.tasks.list(sessionId)), [terminal], 'task journal changed the stopped execution');
    assert.equal(connection.journal.load(sessionId).length, entryCount, 'task journal appended a duplicate execution revision');
    const turnEvents = childEvents();
    assert.deepEqual(turnEvents.filter(event => event.kind === 'turn_terminal').map(event => event.payload.status),
      ['stopped'], 'child turn did not stay stopped');
    assert.equal(turnEvents.filter(event => event.kind === 'permission_cancelled').length, 1, 'approval cancellation was not recorded once');
    assert.equal(turnEvents.filter(event => event.kind === 'permission_answered').length, 0, 'late approval was accepted');
    assert.deepEqual(effects, ['replay_probe'], 'a tool executed again or after stopping');
    assert.equal(requests.filter(item => item === 'child').length, 2, 'child model was called again');
    assert.ok(requests.length <= 5, 'an extra model request was issued');
    assert.ok(attention.filter(notice => !notice.interaction && notice.text !== startText).length <= 1, 'duplicate user notification');
    assert.deepEqual(recoveryErrors, [], 'Runtime reported a recovery error');
  }

  try {
    step = 'dispatch';
    connection = connect();
    await send('runtime.create_session', { sessionId });
    const entry = { id: 'replay-user', role: 'user', source: 'text', visibility: 'conversation',
      content: 'Run the offline fixture.', createdAt: new Date().toISOString() };
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'replay-request',
      sessionId, turnId: 'replay-parent', model: 'script', prefixMessages: [],
      inputMessages: [{ messageId: entry.id, message: { role: 'user', content: entry.content } }],
      tools: connection.tools, permissionMode: 'ask_for_approval',
      metadata: { workspaceDir: root, subagentPermissionRouting: 'parent', individuation: { habits: false, predictions: false } },
    };
    await send('runtime.friends', { action: 'configure', parent, assistant: profile,
      profile: { name: 'Assistant', language: 'en', timeZone: 'UTC', recognition: {}, confirmedAt: entry.createdAt } });
    await command({ action: 'turn', parent, profile, entry });

    step = 'wait-for-approval';
    await until(async () => {
      const view = await read();
      approval = view.management.permissions[0];
      return !view.busy && approval;
    }, 'child did not reach the approval gate');
    [child] = connection.tasks.list(sessionId);
    assert.equal(approval.subagentTaskId, child.taskId, 'approval belongs to a different task');
    assert.equal(approval.sourceTurnId, child.childTurnId, 'approval belongs to a different turn');
    assert.equal(child.resultWatched, true, 'Assistant did not watch the child result');
    assert.deepEqual(effects, ['replay_probe'], 'approval gate did not stop the protected tool');

    step = 'stop';
    const stop = await send('runtime.stop_turn', { sessionId: child.childSessionId, turnId: child.childTurnId });
    assert.equal(stop.accepted, true, 'desktop stop was rejected');
    await rejectLateApproval();
    await connection.tasks.waitForCompletion(sessionId, child.taskId, AbortSignal.timeout(5000));
    terminal = persisted(statusOfChild());
    assert.equal(terminal.status, 'stopped', 'task failed to stop');
    entryCount = connection.journal.load(sessionId).length;
    await checkStopped();

    for (step of events) {
      if (step === 'late-approval') {
        await rejectLateApproval();
      } else if (step === 'late-completion') {
        // This is the settlement ingress used by the child runner after it returns.
        assert.throws(() => connection.tasks.finish({ ...terminalReceipt(), status: 'completed',
          finalResponse: lateText, errorMessage: '' }), /already terminal/, 'late completion must be rejected');
      } else if (step === 'repeat-stop-receipt') {
        assert.deepEqual(persisted(connection.tasks.finish(terminalReceipt())), terminal, 'replayed stop receipt changed the task');
      } else if (step === 'deliver') {
        await settleDelivery();
      } else if (step === 'reconnect') {
        await connection.close();
        connection = connect();
        const restored = await connection.host.restoreAssistantEvents(async saved => saved, AbortSignal.timeout(5000));
        assert.equal(restored, true, 'Assistant did not restore its saved configuration');
      }
      await checkStopped();
    }

    step = 'verify-delivery';
    await settleDelivery();
    tick();
    await yieldTurn();
    await checkStopped();
    const view = await read();
    assert.deepEqual(view.entries.filter(entry => entry.role === 'assistant' && entry.visibility === 'conversation').map(entry => entry.content),
      [startText, stopText], 'the conversation did not retain exactly one stop notification');
    assert.deepEqual(view.entries.filter(entry => entry.visibility === 'internal' && entry.id.startsWith(`task-${child.taskId}-`))
      .map(entry => JSON.parse(entry.content).status), ['stopped'], 'Assistant consumed the stopped result more than once');
    assert.deepEqual(attention.filter(notice => !notice.interaction).map(notice => notice.text),
      [startText, stopText], 'user attention did not emit exactly one stop notification');
    assert.equal(attention.filter(notice => notice.interaction).length, 1, 'the approval notification was emitted more than once');
    assert.deepEqual(requests.filter(item => item !== 'child'), ['dispatch', 'acknowledge', 'result'], 'Assistant issued unexpected model requests');
  } catch (error) {
    throw Object.assign(new Error(`${step}: ${error.message.split('\n')[0]}`, { cause: error }), { step });
  } finally {
    await connection?.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.startsWith(join(tmpdir(), 'cardbush-stop-replay-')));
    await rm(root, { recursive: true, force: true });
  }
}

function* subsequences(events, size, start = 0, selected = []) {
  if (selected.length === size) { yield selected; return; }
  for (let i = start; i <= events.length - size + selected.length; i++) {
    yield* subsequences(events, size, i + 1, [...selected, events[i]]);
  }
}

async function shortestReproduction(events, reproduces) {
  for (let size = 0; size <= events.length; size++) {
    const tried = new Set();
    for (const candidate of subsequences(events, size)) {
      const key = JSON.stringify(candidate);
      if (tried.has(key)) continue;
      tried.add(key);
      if (await reproduces(candidate)) return candidate;
    }
  }
}

async function saveFailure(seed, events, failure, run) {
  const folder = await mkdtemp(join(tmpdir(), 'cardbush-stop-replay-failure-'));
  const path = join(folder, 'replay.json');
  const artifact = { version, seed, prefix, events, failure: failure.message };
  const write = () => writeFile(path, JSON.stringify(artifact, null, 2) + '\n');
  await write();
  if (failure.step) {
    const minimalEvents = await shortestReproduction(events, async candidate => {
      try { await run(candidate); return false; }
      catch (error) { return error.message === failure.message; }
    });
    if (minimalEvents) artifact.minimalEvents = minimalEvents;
    else artifact.reproduced = false;
    await write();
  }
  return path;
}

test('stop replay saves the shortest matching event subsequence', async t => {
  const events = ['late-approval', 'late-completion', 'reconnect', 'late-approval'];
  const failure = Object.assign(new Error('fixture invariant'), { step: 'verify-delivery' });
  // Either the first two events or reconnect alone triggers this synthetic failure.
  const path = await saveFailure(42, events, failure, async candidate => {
    if (candidate.includes('reconnect') || (candidate.includes('late-approval') && candidate.includes('late-completion'))) throw failure;
  });
  t.after(async () => { await rm(path, { force: true }); await rmdir(dirname(path)); });
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(artifact.seed, 42);
  assert.deepEqual(artifact.events, events);
  assert.deepEqual(artifact.minimalEvents, ['reconnect']);
  assert.equal(await shortestReproduction(events, async () => false), undefined);
});

test('offline Assistant stop replay with late approvals, completion receipts and reconnect', async t => {
  const saved = replayPath ? JSON.parse(await readFile(replayPath, 'utf8')) : undefined;
  if (saved) assert.equal(saved.version, version);
  const seeds = saved ? [saved.seed] : seedFromEnv !== undefined ? [Number(seedFromEnv)] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const seed of seeds) {
    assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be an unsigned 32-bit integer');
    const events = saved ? saved.minimalEvents ?? saved.events : seededEvents(seed);
    assert.ok(Array.isArray(events) && events.length <= 7 && events.every(event => allowedEvents.has(event)), 'invalid replay events');
    await t.test(`seed ${seed}`, async runTest => {
      runTest.mock.timers.enable({ apis: ['setTimeout'] });
      const run = events => replay(events, () => runTest.mock.timers.tick(resultPollInterval));
      try { await run(events); }
      catch (failure) {
        const path = await saveFailure(seed, events, failure, run);
        throw new Error(`Replay failed for seed ${seed}. Set CARDBUSH_STOP_REPLAY_FILE to ${path} to replay.`, { cause: failure });
      }
    });
  }
});
