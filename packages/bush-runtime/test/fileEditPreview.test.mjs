import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSH_MODEL_EVENT_PROTOCOL, runtimeEventSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeEventLog, RuntimeEventProjector, InMemoryRuntimeHost, ToolRegistry } from '../dist/index.js';

const identity = { requestId: 'r', sessionId: 's', turnId: 't' };
function setup() {
  const log = new InMemoryRuntimeEventLog(), projector = new RuntimeEventProjector(log, identity);
  let sequence = 0;
  return { projector, events: () => log.replay('s', 't').filter(event => event.kind === 'file_edit_preview'),
    delta: (input) => projector.accept({ protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: 'r', createdAt: new Date().toISOString(), sequence: sequence++, kind: 'tool_call_delta', index: 0, ...input }) };
}
test('streams real structured file input before completion, coalesces tokens and records only deltas', async () => {
  const { projector, events, delta } = setup();
  delta({ toolCallId: 'write', nameDelta: 'write_', argumentsDelta: '{"path":"a.md",' });
  assert.equal(events().length, 0);
  delta({ nameDelta: 'file', argumentsDelta: '"content":"' });
  for (const argumentsDelta of '正在写入') delta({ argumentsDelta });
  assert.equal(events().length, 1);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(events().length, 2);
  delta({ argumentsDelta: '"}' });
  projector.finishFileEdits([{ id: 'write', name: 'write_file', argumentsText: '{}' }]);
  let offset = 0;
  for (const event of events()) { runtimeEventSchema.parse(event); assert.equal(event.payload.offset, offset); offset += event.payload.delta.length; }
  assert.equal(events().map(event => event.payload.delta).join(''), '{"path":"a.md","content":"正在写入"}');
  assert.equal(events().at(-1).payload.state, 'ready');
  assert.equal(logicalToolEvents(events()).length, 0, 'preview is never a tool execution or completion');
});
const logicalToolEvents = events => events.filter(event => /tool_(running|returned)/.test(event.kind));
test('interruption discards pending edits and cancels delayed flush', async () => {
  const { projector, events, delta } = setup();
  delta({ toolCallId: 'edit', nameDelta: 'edit_file', argumentsDelta: '{"path":"a.md","new_text":"' });
  delta({ argumentsDelta: 'unfinished' }); projector.interrupt();
  const count = events().length;
  assert.equal(events().at(-1).payload.state, 'discarded');
  await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(events().length, count);
});
test('invalid/unaccepted calls never become ready; unrelated tools do not publish input', () => {
  const { projector, events, delta } = setup();
  delta({ index: 0, toolCallId: 'shell', nameDelta: 'terminal_exec', argumentsDelta: '{"command":"private"}' });
  delta({ index: 1, toolCallId: 'patch', nameDelta: 'apply_patch', argumentsDelta: '{"patch":"*** Begin Patch' });
  projector.finishFileEdits([]);
  assert.equal(events().length, 2); assert.equal(events().at(-1).payload.state, 'discarded');
  assert.ok(events().every(event => event.payload.toolName === 'apply_patch'));
});
test('large input stops at bounded preview size and never continues displaying a truncated draft', () => {
  const { projector, events, delta } = setup();
  delta({ toolCallId: 'large', nameDelta: 'write_file', argumentsDelta: '{' });
  delta({ argumentsDelta: 'x'.repeat(2 * 1024 * 1024) });
  delta({ argumentsDelta: 'more' }); projector.finishFileEdits([{ id: 'large', name: 'write_file' }]);
  assert.equal(events().length, 2); assert.equal(events().at(-1).payload.state, 'discarded');
  assert.equal(events().at(-1).payload.delta, '');
});

for (const outcome of ['success', 'failure', 'truncated', 'exception']) test(`model loop preserves preview/execution boundaries: ${outcome}`, async () => {
  let host, executed = 0, round = 0;
  const registry = new ToolRegistry().register({
    definition: { name: 'write_file', description: 'Test write', inputSchema: { type: 'object' } },
    manifest: { owner: 'runtime', operation: 'write', effect_kind: 'filesystem_change', risk: 'low', dispatch_scope: 'session', mutating: true },
    decodeInput: input => input,
    execute: () => { executed++; if (outcome === 'failure') throw Error('Expected write failure'); return { saved: true }; },
  });
  host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    const event = (sequence, kind, rest = {}) => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: request.requestId, sequence, kind, createdAt: new Date().toISOString(), ...rest });
    if (round++ > 0) { yield event(0, 'text_delta', { delta: 'Finished' }); yield event(1, 'response_completed'); return; }
    yield event(0, 'tool_call_delta', { index: 0, nameDelta: 'write_file', toolCallId: 'file', argumentsDelta: '{"path":"a.md","content":"first' });
    assert.equal(executed, 0);
    assert.ok(host.events('s', 't').some(event => event.kind === 'file_edit_preview' && event.payload.delta.includes('first')));
    if (outcome === 'exception') throw Error('Disconnected fixture');
    yield event(1, 'tool_call_delta', { index: 0, argumentsDelta: ' second"}' });
    yield event(2, 'response_completed', { finishReason: outcome === 'truncated' ? 'length' : 'tool_calls' });
  } } });
  await host.runModelTurn({ protocol: 'bush.model_request.v1', ...identity, model: 'fixture', tools: registry.definitions(), messages: [{ role: 'user', content: 'Write a.md' }], permissionMode: 'all_free' });
  const events = host.events('s', 't'), preview = events.filter(event => event.kind === 'file_edit_preview');
  assert.equal(preview.at(-1).payload.state, ['truncated', 'exception'].includes(outcome) ? 'discarded' : 'ready');
  assert.equal(executed, ['truncated', 'exception'].includes(outcome) ? 0 : 1);
  if (executed) {
    const write = events.find(event => event.kind === (outcome === 'failure' ? 'tool_failed' : 'tool_returned'));
    assert.ok(write && write.sequence > preview.at(-1).sequence);
  }
});
