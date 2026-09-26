import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, TerminalSessionManager } from '../dist/index.js';
import { TerminalCompletionNotifications } from '../dist/terminalCompletionNotifications.js';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';

const shell = process.platform === 'win32' ? 'powershell' : 'posix';
const command = script => process.platform === 'win32'
  ? `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`
  : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-terminal-notice-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-terminal-notice-')); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function* response(request, call, text = 'done') {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(), nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: text };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
}
const manifest = { protocol: 'bush.tool.action_manifest.v1', manifest_id: 'manifest', effect_kind: 'process_execution', operation: 'terminal.execute', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true };
function context(controller, turnId = 't') { return { requestId: 'r', sessionId: 's', turnId,
  toolCall: { protocol: 'bush.tool_call.v1', id: 'start', name: 'terminal_exec', argumentsText: '{}' },
  actionManifest: manifest, turn: { signal: controller.signal, request: { sessionId: 's', turnId }, contextMessages: [] } }; }

test('real terminal exit is delivered once, with no model polling and a stable message prefix', { timeout: 20000 }, async t => {
  const root = temporary(t), registry = new ToolRegistry(), store = new ToolExecutionStore();
  let rounds = 0, worked = false, previous = [], taskId;
  registry.register({ definition: { name: 'independent', description: 'independent fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false }, decodeInput: v => v,
    execute: () => { worked = true; return { done: true }; } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, toolExecutionStore: store, provider: { async *stream(request) {
    rounds++;
    assert.deepEqual(request.messages.slice(0, previous.length), previous, 'already sent messages are immutable');
    previous = structuredClone(request.messages);
    if (rounds === 1) yield* response(request, { name: 'terminal_exec', args: { command: command('setTimeout(()=>{console.log("notice-output");process.exit(7)},600)'), cwd: root, shell, yield_time_ms: 1 } });
    else if (rounds === 2) {
      const receipt = request.messages.filter(m => m.role === 'tool').at(-1).content;
      assert.match(receipt, /"completion_notification":true/);
      taskId = JSON.parse(receipt.split('\n\n')[0]).completion_task_id;
      yield* response(request, { name: 'independent', args: {} });
    } else if (rounds === 3) yield* response(request, { name: 'manage_tool_calls', args: { action: 'wait', task_ids: [taskId] } });
    else {
      const notices = request.messages.filter(m => m.name === 'background_tool_result');
      assert.equal(notices.length, 1); assert.equal(notices[0].visibility, 'internal');
      assert.match(notices[0].content, /notice-output/); assert.match(notices[0].content, /"exitCode":7/);
      assert.match(notices[0].content, /command failed/); assert.match(notices[0].content, /tool-result:\/\//);
      yield* response(request);
    }
  } } });
  const result = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'all_free',
    messages: [{ role: 'user', content: 'test a long command' }], tools: registry.definitions(), metadata: { workspaceDir: root } });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result));
  assert.equal(rounds, 4); assert.equal(worked, true);
  assert.equal(store.listByTool('s', 'terminal_poll').length, 0);
  assert.equal(store.listByTool('s', 'terminal_completion').length, 1);
  for (const detail of ['summary', 'full']) {
    const history = await host.sendCommand({ kind: 'runtime.list_turn_tool_executions', payload: { sessionId: 's', turnId: 't', detail } });
    assert.ok(history.every(record => record.toolCall.name !== 'terminal_completion'), 'reloading must not add a phantom tool row');
  }
});

test('observer cancellation does not stop the process, drain logs or leak results into another turn', { timeout: 15000 }, async t => {
  const root = temporary(t), terminals = new TerminalSessionManager(), store = new ToolExecutionStore(), controller = new AbortController(), deliveries = [];
  const watcher = new TerminalCompletionNotifications(terminals, store, undefined, (s, turn, id, promise) => deliveries.push({ s, turn, id, promise }));
  const initial = await terminals.start({ ownerSessionId: 's', cwd: root, shell, command: command('setTimeout(()=>console.log("still-ran"),500)'), yieldTimeMs: 1 });
  watcher.watch(context(controller), initial);
  assert.equal(watcher.list('other', 't').length, 0); assert.equal(watcher.list('s', 'different').length, 0);
  controller.abort();
  assert.match((await deliveries[0].promise).content, /cancelled/);
  const exit = await terminals.waitForCompletion('s', initial.terminalSessionId);
  assert.equal(exit.state, 'exited'); assert.match(exit.stdout, /still-ran/);
  const polled = await terminals.poll('s', { sessionId: initial.terminalSessionId, yieldTimeMs: 1 });
  assert.match(polled.stdout, /still-ran/, 'observer never consumes manual output');
  assert.equal(store.listTurn('s', 't').length, 0); watcher.endTurn('s', 't'); assert.equal(watcher.list('s', 't').length, 0);
});

test('SSH observers renew in the host and wait(any) ignores already settled jobs', async () => {
  const controller = new AbortController(), store = new ToolExecutionStore(), deliveries = [];
  let observations = 0;
  const remote = { async request(action, payload, signal) {
    assert.equal(action, 'execute'); assert.equal(payload.name, 'terminal_observe'); assert.equal(payload.owner, 's');
    signal.throwIfAborted(); observations++;
    return { terminalSessionId: 'ssh-handle', state: observations < 3 ? 'running' : 'completed', stdout: 'ssh-done', stderr: '', exitCode: observations < 3 ? null : 0 };
  } };
  const watcher = new TerminalCompletionNotifications(new TerminalSessionManager(), store, remote, (_s, _t, _id, promise) => deliveries.push(promise));
  const id = watcher.watch(context(controller), { terminalSessionId: 'ssh-handle', state: 'running', executionEnvironment: { kind: 'ssh', workspaceDir: 'ssh://test/tmp' } });
  const registry = new ToolRegistry(), jobs = new BackgroundToolCalls(registry, () => {}, (s, t) => watcher.list(s, t)); jobs.register();
  const manage = registry.resolve('manage_tool_calls');
  const run = (input, sessionId = 's') => manage.execute({ sessionId, turnId: 't', input: manage.decodeInput(input) });
  await assert.rejects(() => run({ action: 'wait', task_ids: [id] }, 'foreign'), /belong/);
  const waited = await run({ action: 'wait', task_ids: [id] });
  assert.equal(waited.tasks[0].status, 'completed'); assert.equal(observations, 3);
  assert.match((await deliveries[0]).content, /ssh-done/);
  assert.deepEqual((await run({ action: 'wait' })).tasks, []);
  watcher.endTurn('s', 't');
});

test('stopping while awaiting a terminal never resumes the model; persistent opt-out can finish the turn', { timeout: 20000 }, async t => {
  const root = temporary(t);
  for (const notify of [true, false]) {
    const registry = new ToolRegistry(), controller = new AbortController(), store = new ToolExecutionStore();
    let rounds = 0, handle;
    const host = new InMemoryRuntimeHost({ toolRegistry: registry, toolExecutionStore: store, provider: { async *stream(request) {
      rounds++;
      if (rounds === 1) yield* response(request, { name: 'terminal_exec', args: { command: command('setTimeout(()=>console.log("later"),5000)'), cwd: root, shell, yield_time_ms: 1, notify_on_exit: notify } });
      else {
        assert.equal(rounds, 2, 'a stopped turn must not receive a late callback');
        const receipt = JSON.parse(request.messages.filter(m => m.role === 'tool').at(-1).content.split('\n\n')[0]);
        handle = receipt.terminalSessionId;
        if (notify) {
          assert.equal(receipt.completion_notification, true);
          setTimeout(() => controller.abort(), 40);
          yield* response(request, { name: 'manage_tool_calls', args: { action: 'wait', task_ids: [receipt.completion_task_id] } });
        } else { assert.equal(receipt.completion_notification, undefined); yield* response(request); }
      }
    } } });
    try {
      const result = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'all_free',
        messages: [{ role: 'user', content: 'fixture' }], tools: registry.definitions(), metadata: { workspaceDir: root } }, { signal: controller.signal });
      assert.equal(result.payload.status, notify ? 'stopped' : 'completed');
      assert.equal(rounds, 2); assert.equal(store.listByTool('s', 'terminal_completion').length, 0);
    } finally {
      if (handle) { const stop = registry.resolve('terminal_stop'); await stop.execute({ sessionId: 's', input: stop.decodeInput({ session_id: handle }) }); }
    }
  }
});
