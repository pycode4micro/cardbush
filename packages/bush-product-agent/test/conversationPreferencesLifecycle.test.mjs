import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest } from '../dist/index.js';
import { orderedCheckpointTool } from '../../bush-runtime/test/helpers/orderedCheckpoint.mjs';

const now = '2026-09-18T08:00:00Z';
const preferences = messages => messages.filter(message => message.name === 'conversation_preferences');
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, createdAt: now, sequence, kind, ...payload });
const request = (id, options = {}) => createProductAgentTurnRequest({
  requestId: id, sessionId: 'preferences', turnId: id, messageId: `user_${id}`,
  createdAt: now,
  userText: `Continue ${id}.`, uiLanguage: 'zh', model: 'fixture', tools: [orderedCheckpointTool],
  permissionMode: 'task_free', planEnabled: false, maxOutputTokens: 1000, maxContextTokens: 100000,
  conversationStyle: { mode: 'natural', customTone: '' }, ...options,
});

function fixture(t) {
  const facts = [], observed = [];
  // Serialize the journal across host restarts: deduplication cannot depend on
  // an in-memory "already sent" flag or on summaries mentioning the style.
  const persistence = { load: () => JSON.parse(JSON.stringify(facts)),
    append: fact => facts.push(JSON.parse(JSON.stringify(fact))) };
  let compact = false, compactions = 0;
  const provider = {
    async countInputTokens() { return { inputTokens: compact ? 96000 : 1000, source: 'provider' }; },
    async *stream(input) {
      observed.push(structuredClone(input));
      if (input.messages.some(message => message.name === 'context_pressure')) {
        compactions++;
        compact = false;
        const incremental = input.tools.find(tool => tool.name === 'checkpoint_context')?.inputSchema.required?.includes('updates');
        yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: `cp_${compactions}`,
          nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify(incremental
            ? { updates: [{ source: 0, summary: 'Previous task completed.' }] }
            : { summaries: ['Previous task completed.'] }) });
        yield event(input, 1, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(input, 0, 'text_delta', { delta: `${input.turnId} done.` });
        yield event(input, 1, 'response_completed', { finishReason: 'stop' });
      }
    },
  };
  const open = () => {
    const store = new SessionStore({ persistence });
    const host = new InMemoryRuntimeHost({ provider, sessionStore: store, registerDefaultWorkspaceTools: false });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    return { host, store };
  };
  return { open, observed, compact: () => { compact = true; } };
}

test('only first, changed and restored preferences append; attachments and user requests remain per-turn', async t => {
  const { open, observed } = fixture(t);
  let { host, store } = open();
  const modes = ['natural', 'natural', 'concise', 'natural', 'natural'];
  for (const [index, mode] of modes.entries()) {
    if (index === 4) {
      await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
      ({ host, store } = open());
    }
    const before = structuredClone(store.snapshot('preferences')?.turns ?? []);
    const candidate = request(`turn_${index}`, { files: [`C:/fixture/file_${index}.txt`],
      conversationStyle: { mode, customTone: `Inactive draft ${index}` } });
    assert.equal((await host.runSessionTurn(candidate)).payload.status, 'completed');
    assert.deepEqual(store.snapshot('preferences').turns.slice(0, before.length), before);
    const messages = observed.at(-1).messages;
    assert.equal(preferences(messages).length, [1, 1, 2, 3, 3][index]);
    const inputs = store.snapshot('preferences').turns.at(-1).messages.map(item => item.message);
    assert.equal(preferences(inputs).length, [1, 0, 1, 1, 0][index]);
    const attachments = inputs.find(message => message.name === 'turn_runtime_context');
    assert.match(attachments.content, new RegExp(`file_${index}\\.txt`));
    assert.doesNotMatch(attachments.content, /Mode:|ui_language_fallback|Inactive draft/);
    assert.ok(inputs.some(message => message.role === 'user' && message.content === candidate.inputMessages.at(-1).message.content));
    if (index > 0) assert.deepEqual(messages.slice(0, observed[index - 1].messages.length), observed[index - 1].messages);
  }
  assert.equal((await host.runSessionTurn(request('language_change', { uiLanguage: 'en' }))).payload.status, 'completed');
  assert.equal(preferences(observed.at(-1).messages).length, 4);
  assert.match(preferences(observed.at(-1).messages).at(-1).content, /ui_language_fallback: en/);
  const changes = host.events('preferences', 'turn_4').filter(item => item.kind === 'cache_chain_observed');
  assert.ok(changes.every(item => !item.payload.frozenPrefixBreak));
});

test('resuming legacy date history preserves recorded times without appending clock updates', async t => {
  const { open, observed } = fixture(t);
  let { host, store } = open();
  const recordedAt = '2026-09-17T15:59:59Z';
  const legacy = request('legacy_date', { createdAt: recordedAt });
  const clockFact = { role: 'user', name: 'session_environment', visibility: 'internal',
    content: JSON.stringify({ protocol: 'bush.session_environment.v1', kind: 'snapshot', localDate: '2026-09-17', effectiveAt: recordedAt }) };
  legacy.inputMessages.unshift({ messageId: 'legacy_date_fact', createdAt: recordedAt, message: clockFact });
  assert.equal((await host.runSessionTurn(legacy)).payload.status, 'completed');
  const original = structuredClone(store.snapshot('preferences').turns[0]);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store } = open());

  const next = request('after_midnight', { createdAt: '2026-09-17T16:00:01Z', userText: '昨晚的任务是什么时候完成的？' });
  assert.equal((await host.runSessionTurn(next)).payload.status, 'completed');
  const snapshot = store.snapshot('preferences');
  assert.deepEqual(snapshot.turns[0], original);
  assert.equal(snapshot.turns[0].messages.find(item => item.messageId === 'legacy_date_fact').createdAt, recordedAt);
  assert.equal(snapshot.turns.at(-1).messages.find(item => item.messageId === 'user_after_midnight').createdAt, '2026-09-17T16:00:01Z');
  assert.deepEqual(observed.at(-1).messages.filter(message => message.name?.startsWith('session_environment')), [clockFact]);
  assert.deepEqual(observed.at(-1).messages.slice(0, observed[0].messages.length), observed[0].messages);
  assert.equal(snapshot.turns.at(-1).messages.some(item => item.message.name?.startsWith('session_environment')), false);
});

for (const format of ['ordered', 'incremental']) for (const changed of [false, true]) test(`${format} compaction restores the current preference only when absent (${changed ? 'changed' : 'unchanged'} style), with stable restart replay`, async t => {
  const { open, observed, compact } = fixture(t);
  let { host, store } = open();
  assert.equal((await host.runSessionTurn(request('first'))).payload.status, 'completed');
  const original = structuredClone(store.snapshot('preferences').turns[0]);
  const settings = { conversationStyle: { mode: changed ? 'concise' : 'natural', customTone: '' },
    ...(format === 'incremental' ? { tools: [] } : {}) };
  for (const id of ['second', 'third']) {
    compact();
    assert.equal((await host.runSessionTurn(request(id, settings))).payload.status, 'completed');
    const visible = preferences(observed.at(-1).messages);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].role, 'user');
    assert.equal(visible[0].visibility, 'internal');
    assert.match(visible[0].content, new RegExp(`Mode: ${settings.conversationStyle.mode}`));
    assert.equal(host.events('preferences', id).filter(item => item.kind === 'context_compaction_completed').length, 1);
    assert.deepEqual(store.snapshot('preferences').turns[0], original);
  }
  const beforeRestart = structuredClone(observed.at(-1).messages);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store } = open());
  assert.equal((await host.runSessionTurn(request('fourth', settings))).payload.status, 'completed');
  assert.deepEqual(observed.at(-1).messages.slice(0, beforeRestart.length), beforeRestart);
  assert.equal(preferences(observed.at(-1).messages).length, 1);
  assert.equal(preferences(store.snapshot('preferences').turns.at(-1).messages.map(item => item.message)).length, 0);
});
