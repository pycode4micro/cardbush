import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry } from '../dist/index.js';

test('background child and parent keep independent usage and full per-request output limits', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-usage-isolation-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  const sessions = new SessionStore(), tasks = new SubagentTaskStore();
  const rounds = new Map(), requests = [], signals = [];
  const childGate = Promise.withResolvers();
  const registry = new ToolRegistry().register({
    definition: { name: 'usage_probe', description: 'Fixture observation', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: value => value, execute: () => ({ ok: true }),
  });
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions, subagentTaskStore: tasks,
    toolRegistry: registry, provider: { async *stream(request, options) {
      const child = request.metadata.agentRole === 'child';
      const round = (rounds.get(request.sessionId) ?? 0) + 1;
      rounds.set(request.sessionId, round);
      requests.push({ sessionId: request.sessionId, child, round, maxOutputTokens: request.maxOutputTokens });
      signals.push(options.signal);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      let call;
      if (child && round < 3) call = { name: 'usage_probe', input: {} };
      else if (child) await childGate.promise;
      else if (round === 1) call = { name: 'subagent', input: { prompt: 'Check three steps', run_in_background: true } };
      else if (round === 2) {
        childGate.resolve();
        call = { name: 'manage_plugin_agents', input: { action: 'wait' } };
      }
      if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0,
        toolCallId: `${request.sessionId}_${round}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
      else yield { ...base, sequence: 1, kind: 'text_delta', delta: child ? 'Child result' : 'Parent result' };
      // Every request stays below 100; both loops and their combined usage exceed it.
      yield { ...base, sequence: 2, kind: 'usage', inputTokens: child ? 2000 : 1000,
        outputTokens: child ? 80 : 90 - round * 10, cachedInputTokens: child ? 200 : 100 };
      yield { ...base, sequence: 3, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
    } },
  });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1',
    requestId: 'usage-parent-request', sessionId: 'usage-parent', turnId: 'usage-parent-turn', model: 'fixture',
    inputMessages: [{ messageId: 'usage-user', message: { role: 'user', content: 'Delegate and wait' } }],
    tools, maxOutputTokens: 100, metadata: { contextWindowTokens: 400000 },
  });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  const [child] = tasks.list('usage-parent');
  assert.equal(child.status, 'completed');
  const parentTurn = sessions.snapshot('usage-parent').turns[0];
  const childTurn = sessions.snapshot(child.childSessionId).turns[0];
  assert.equal(parentTurn.usage.outputTokens, 210);
  assert.equal(childTurn.usage.outputTokens, 240);
  assert.equal(child.usage.outputTokens, 240);
  assert.equal(parentTurn.usage.inputTokens, 3000);
  assert.equal(childTurn.usage.inputTokens, 6000);
  assert.equal(parentTurn.usage.lastRequestOutputTokens, 60);
  assert.equal(childTurn.usage.lastRequestOutputTokens, 80);
  assert.equal(requests.length, 6);
  assert.ok(requests.every(request => request.maxOutputTokens === 100));
  assert.ok(signals.every(signal => !signal.aborted));
  const parentUsage = host.events('usage-parent', 'usage-parent-turn').filter(event => event.kind === 'model_request_usage');
  const childUsage = host.events(child.childSessionId, child.childTurnId).filter(event => event.kind === 'model_request_usage');
  assert.deepEqual(parentUsage.map(event => event.payload.outputTokens), [80, 70, 60]);
  assert.deepEqual(childUsage.map(event => event.payload.outputTokens), [80, 80, 80]);
});
