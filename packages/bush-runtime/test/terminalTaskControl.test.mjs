import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TerminalSessionManager, InMemoryRuntimeHost, ToolRegistry } from '../dist/index.js';

const shell = process.platform === 'win32' ? 'powershell' : 'posix';
const command = script => process.platform === 'win32' ? `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`
  : `'${process.execPath.replaceAll("'", "'\\''")}' -e '${script.replaceAll("'", "'\\''")}'`;
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-terminal-control-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('cardbush-terminal-control-')); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return root;
}

test('simultaneous identical starts create one process; ownership and later reruns remain independent', { timeout: 15000 }, async t => {
  const root = temporary(t), manager = new TerminalSessionManager();
  t.after(async () => { for (const owner of ['s', 'other']) for (const item of manager.list(owner)) if (item.state === 'running') await manager.stop(owner, item.terminalSessionId); });
  const input = { ownerSessionId: 's', command: command('setInterval(()=>{},1000)'), cwd: root, shell, yieldTimeMs: 1 };
  const starts = await Promise.allSettled([manager.start(input), manager.start(input)]);
  const started = starts.find(item => item.status === 'fulfilled').value;
  const denied = starts.find(item => item.status === 'rejected').reason;
  assert.equal(denied.code, 'terminal_command_already_running'); assert.equal(denied.details.terminalSessionId, started.terminalSessionId);
  assert.equal(manager.list('s').length, 1);
  assert.throws(() => manager.status('other', started.terminalSessionId), { code: 'terminal_session_not_found' });
  const other = await manager.start({ ...input, ownerSessionId: 'other' });
  assert.notEqual(other.terminalSessionId, started.terminalSessionId);
  await manager.stop('s', started.terminalSessionId);
  const rerun = await manager.start(input); assert.notEqual(rerun.terminalSessionId, started.terminalSessionId);
  await manager.stop('s', rerun.terminalSessionId); await manager.stop('other', other.terminalSessionId);
});

test('human status reads do not consume output, start a model request, or control another session', { timeout: 15000 }, async t => {
  const root = temporary(t), registry = new ToolRegistry(); let rounds = 0, terminalId;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    rounds++;
    if (rounds === 1) yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'start', nameDelta: 'terminal_exec', argumentsDelta: JSON.stringify({
      command: command('console.log("kept-output");setInterval(()=>{},1000)'), cwd: root, shell, yield_time_ms: 1, notify_on_exit: false,
    }) };
    else { terminalId = JSON.parse(request.messages.find(m => m.role === 'tool').content.split('\n\n')[0]).terminalSessionId; yield { ...base, sequence: 0, kind: 'text_delta', delta: 'background submitted' }; }
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: rounds === 1 ? 'tool_calls' : 'stop' };
  } } });
  const control = (action, owner = 's') => host.sendCommand({ kind: 'runtime.terminal_control', payload: { sessionId: owner, terminalSessionId: terminalId, action } });
  t.after(async () => { if (terminalId) await control('stop').catch(() => {}); });
  const turn = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'all_free',
    messages: [{ role: 'user', content: 'start a background process' }], tools: registry.definitions(), metadata: { workspaceDir: root } });
  assert.equal(turn.payload.status, 'completed');
  await assert.rejects(control('stop', 'other'), { code: 'terminal_session_not_found' });
  let status; const deadline = Date.now() + 5000;
  do { status = await control('status'); if (status.lastOutputAt) break; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  assert.equal(status.state, 'running'); assert.ok(status.lastOutputAt); assert.ok(status.durationMs >= status.outputIdleMs);
  assert.equal(rounds, 2, 'UI observation must never request another model response');
  const stopped = await control('stop'); assert.equal(stopped.state, 'stopped'); assert.match(stopped.stdout, /kept-output/);
  assert.equal(rounds, 2);
});
