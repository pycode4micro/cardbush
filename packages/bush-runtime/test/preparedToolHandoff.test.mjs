import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext, assembleContextProjection,
  FileSessionEventPersistence, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { findPreparedToolHandoff, preparedToolHandoffReceipt } from '../dist/preparedToolHandoff.js';
import { validateConversation } from '../dist/sessionStore.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { locateContextCompactionSources } from '../dist/contextCompaction.js';
import { checkpointSkillReceiptEvidence } from '../dist/checkpointSkillEvidence.js';
import { preparedCompactionCases } from '../../../scripts/fixtures/prepared-compaction-cases.mjs';
import { longScenarioForLayout } from '../../../scripts/fixtures/prepared-compaction-long-cases.mjs';

const now = '2026-10-23T08:00:00Z', sessionId = 'prepared';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const call = (id, name, args = {}) => ({ role: 'assistant', content: '',
  toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }] });
const receipt = (id, content) => ({ role: 'tool', toolCallId: id, content });
const summary = 'Downloaded asset A-17 once; render R-22 is pending, never resubmit it. No publication is authorized. Audio listening remains unverified.';
const final = 'Asset A-17 is ready. Render R-22 and listening review are still pending.';
const prepared = (id = 'summary', text = summary) => [call(id, 'summary_for_user', { tool_summary: text }),
  receipt(id, JSON.stringify({ status: 'ok', final_response: true, saved: false, writes: [], ...preparedToolHandoffReceipt(text) })), assistant(final)];
const facts = () => [user('Download only once; do not publish. Preserve unresolved listening review.'),
  call('download', 'fixture_download'), receipt('download', 'A-17 verified. ' + 'trace '.repeat(11000)), ...prepared()];
function turn(id = 'old', messages = facts(), sequence = 1, checkpoint) {
  return { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now, status: 'completed',
    reason: 'model_response_completed', usage: {}, ...(checkpoint ? { contextCheckpoint: checkpoint } : {}),
    messages: messages.map((message, messageIndex) => ({ messageId: `${id}-${messageIndex}`, turnId: id,
      turnSequence: sequence, messageIndex, createdAt: now, message })) };
}
function seed(store, value = turn()) { store.commitTurn(sessionId, value); return store.snapshot(sessionId).turns.at(-1); }
function apply(store, value) { return store.summarizeTurns({ sessionId, expectedRevision: store.snapshot(sessionId).revision,
  summaries: [{ turnId: value.turnId, toolHandoff: findPreparedToolHandoff(value) }] }); }
function temp(t) { const root = mkdtempSync(join(tmpdir(), 'cardbush-prepared-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }); return root; }
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, sequence, createdAt: now, kind, ...payload });
const count = async request => ({ source: 'provider', inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4) });
const maintenance = request => request.messages.some(message => message.name === 'context_pressure');
function* done(request, content = 'Continue checking R-22, without submitting another render.') {
  yield event(request, 0, 'text_delta', { delta: content });
  yield event(request, 1, 'response_completed', { finishReason: 'stop' });
}
function* invoke(request, id, name, args) {
  yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });
  yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
}
function* compact(request, id) {
  const rows = request.messages.findLast(message => message.name === 'context_pressure').content.split('\n')
    .filter(line => line.startsWith('{')).map(JSON.parse).filter(row => row.target !== 'not_requested');
  yield* invoke(request, id, 'checkpoint_context', { updates: rows.map(row => ({ source: row.source, summary })) });
}
const request = (turnId = 'next', overrides = {}) => ({ protocol: 'bush.session_turn_request.v1',
  requestId: turnId, sessionId, turnId, model: 'fixture', reasoningEffort: 'high', maxOutputTokens: 4000,
  prefixMessages: [{ role: 'system', content: 'Stable policy. Never fabricate verification.' }],
  inputMessages: [{ messageId: `${turnId}-user`, message: user('Check the existing render; do not resubmit it.') }],
  metadata: { contextWindowTokens: 20000 }, ...overrides });
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });

test('completed handoffs project only at pressure, preserve originals and replay without another summary request', async t => {
  const journal = [], persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
  const store = new SessionStore({ persistence }), old = seed(store), original = structuredClone(old.messages);
  assert.ok(assembleContext({ session: store.snapshot(sessionId) }).messages.some(m => m.role === 'tool' && m.toolCallId === 'download'));
  const seen = [], host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) { seen.push(structuredClone(input)); yield* done(input); } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(request());
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.equal(seen.length, 1); assert.equal(maintenance(seen[0]), false);
  const messages = seen[0].messages, projected = messages.find(m => m.content.includes('<tool_summary'));
  assert.equal(projected.role, 'assistant'); assert.ok(projected.content.endsWith(final));
  assert.ok(projected.content.includes(summary)); assert.deepEqual(projected.toolCalls, []);
  assert.equal(projected.providerReplay, undefined); assert.equal(projected.reasoningContent, undefined);
  assert.ok(messages.some(m => m.content === old.messages[0].message.content));
  assert.equal(messages.some(m => m.role === 'tool'), false);
  assert.deepEqual(store.snapshot(sessionId).turns[0].messages, original);
  const restored = new SessionStore({ persistence }).snapshot(sessionId);
  assert.deepEqual(assembleContext({ session: restored, prefix: request().prefixMessages }).messages.slice(0, messages.length), messages);
  const completed = host.events(sessionId, 'next').find(e => e.kind === 'context_compaction_completed').payload;
  assert.equal(completed.method, 'prepared_tool_handoff');
  assert.ok(completed.inputTokensAfter < completed.inputTokensBefore);
  assert.ok(completed.inputTokensAfter <= completed.targetInputTokens);
});

test('actual final-display tool prepares with memory off and does not compact a fitting turn immediately', async t => {
  const root = temp(t), path = join(root, 'personalization.sqlite'), registry = new ToolRegistry();
  let executed = 0, normal = 0;
  registry.register({ definition: { name: 'fixture_download', description: 'Offline fixture only.', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: x => x, execute: () => { executed++; return { asset: 'A-17', log: 'trace '.repeat(11000) }; } });
  const store = new SessionStore(), host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, dataRoot: root,
    durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: input => input.turnId === 'second' && !input.messages.some(m => m.content.includes('<tool_summary'))
      ? { source: 'provider', inputTokens: 13000 } : count(input), async *stream(input) {
      assert.equal(maintenance(input), false);
      if (normal++ === 0) yield* invoke(input, 'actual-download', 'fixture_download', {});
      else if (normal === 2) yield* invoke(input, 'actual-summary', 'summary_for_user', { tool_summary: summary });
      else yield* done(input, final);
    } } });
  t.after(() => shutdown(host));
  const first = await host.runSessionTurn(request('first', { tools: registry.definitions(), permissionMode: 'all_free', metadata: { contextWindowTokens: 150000 } }));
  assert.equal(first.payload.status, 'completed', JSON.stringify(first.payload));
  const old = store.snapshot(sessionId).turns[0];
  assert.ok(findPreparedToolHandoff(old)); assert.equal(old.contextToolHandoff, undefined);
  assert.equal(existsSync(path), false, 'tool recap must not initialize or write long-term memory');
  assert.equal(host.events(sessionId, 'first').some(e => e.kind === 'context_compaction_started'), false);
  const next = await host.runSessionTurn(request('second', { tools: registry.definitions() }));
  assert.equal(next.payload.status, 'completed', JSON.stringify(next.payload));
  assert.equal(executed, 1); assert.ok(store.snapshot(sessionId).turns[0].contextToolHandoff);
});

test('default handoff path preserves append-only cache prefixes except at the actual compaction boundary', async t => {
  const root = temp(t), registry = new ToolRegistry(), store = new SessionStore();
  let businessCalls = 0, initialRounds = 0;
  registry.register({ definition: { name: 'fixture_download', description: 'Offline fixture only.', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: x => x, execute: () => { businessCalls++; return { asset: 'A-17', log: 'trace '.repeat(11000) }; } });
  const seen = [], host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, dataRoot: root,
    durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    registerDefaultWorkspaceTools: false,
    provider: {
      countInputTokens: input => ({ source: 'provider', inputTokens:
        input.turnId === 'compact' && !input.messages.some(m => m.content.includes('<tool_summary')) ? 13000 : 4000 }),
      async *stream(input) {
        seen.push(structuredClone(input));
        assert.equal(maintenance(input), false, 'prepared history must not require another model summary');
        if (input.turnId === 'initial' && initialRounds++ === 0) yield* invoke(input, 'cache-download', 'fixture_download', {});
        else if (input.turnId === 'initial' && initialRounds === 2) yield* invoke(input, 'cache-summary', 'summary_for_user', { tool_summary: summary });
        else yield* done(input, final);
      },
    } });
  t.after(() => shutdown(host));
  const tools = registry.definitions();
  for (const id of ['initial', 'follow', 'compact', 'after']) {
    const result = await host.runSessionTurn(request(id, { tools, permissionMode: 'all_free',
      inputMessages: [{ messageId: `${id}-user`, message: user(`Request ${id}: do not publish or resubmit R-22.`) }] }));
    assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
    const applied = store.snapshot(sessionId).turns[0].contextToolHandoff;
    assert.equal(Boolean(applied), ['compact', 'after'].includes(id), 'do not replace history at every Turn boundary');
  }
  assert.equal(businessCalls, 1); assert.equal(seen.length, 6);
  for (const input of seen) {
    assert.deepEqual(input.tools, seen[0].tools);
    assert.equal(input.model, 'fixture'); assert.equal(input.reasoningEffort, 'high'); assert.equal(input.maxOutputTokens, 4000);
  }
  const observation = id => host.events(sessionId, id).filter(e => e.kind === 'cache_chain_observed').map(e => e.payload);
  assert.ok(observation('initial').slice(1).every(x => !x.frozenPrefixBreak && !x.parametersChanged));
  assert.ok(observation('follow').every(x => x.prefixComparisonAvailable && !x.frozenPrefixBreak && !x.parametersChanged));
  assert.ok(observation('compact').some(x => x.frozenPrefixBreak && !x.parametersChanged));
  assert.ok(observation('after').every(x => x.prefixComparisonAvailable && !x.frozenPrefixBreak && !x.parametersChanged));
  const after = seen.find(input => input.turnId === 'after');
  for (const id of ['initial', 'follow', 'compact', 'after']) assert.ok(after.messages.some(m => m.role === 'user' && m.content.startsWith(`Request ${id}:`)));
  assert.ok(store.snapshot(sessionId).turns[0].messages.some(m => m.message.role === 'tool' && m.message.toolCallId === 'cache-download'));
});

const invalid = {
  legacy: value => { value.messages[3].message.toolCalls[0].argumentsText = '{}'; },
  'failed receipt': value => { value.messages[4].message.content = '{"status":"error"}'; },
  'altered summary': value => { value.messages[3].message.toolCalls[0].argumentsText = JSON.stringify({ tool_summary: 'fabricated' }); },
  'later guidance': value => { value.messages.push({ message: user('Actually cancel R-22.') }); },
  'later tool': value => { value.messages.push({ message: call('later', 'read_file') }, { message: receipt('later', 'new result') }); },
  'no final prose': value => { value.messages[5].message.content = ''; },
  'failed turn': value => { value.status = 'failed'; },
  'parallel final call': value => { value.messages[3].message.toolCalls.push({ id: 'parallel', name: 'read_file', argumentsText: '{}' }); },
  'no tool work': value => { value.messages.splice(1, 2); },
};
for (const [label, mutate] of Object.entries(invalid)) test(`does not reuse ${label}`, () => {
  const value = turn(); mutate(value); assert.equal(findPreparedToolHandoff(value), undefined);
});
test('fresh preparation after guidance replaces the stale summary', () => {
  const value = turn('fresh', [...facts(), user('Cancel R-22; do not publish.'), ...prepared('fresh-summary', 'R-22 cancellation is pending, no publication.')]);
  assert.equal(findPreparedToolHandoff(value).summaryMessageId, 'fresh-7');
});

for (const preferPreparedToolHandoffs of [false, true]) test(`fallback still compacts unavailable handoffs (enabled=${preferPreparedToolHandoffs})`, async t => {
  const store = new SessionStore(); seed(store, turn('old', [...facts(), user('New correction after preparation.'), assistant('Acknowledged.') ]));
  let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, preferPreparedToolHandoffs, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) {
      if (maintenance(input)) yield* compact(input, `cp-${++calls}`); else yield* done(input);
    } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(request());
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.ok(calls > 0); assert.equal(store.snapshot(sessionId).turns[0].contextToolHandoff, undefined);
  assert.equal(host.events(sessionId, 'next').find(e => e.kind === 'context_compaction_completed').payload.method, 'checkpoint');
});

test('no-progress handoff is not persisted and falls back to ordinary bounded compression', async t => {
  const store = new SessionStore(); seed(store); let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: async () => ({ source: 'provider', inputTokens: 13000 }), async *stream(input) {
      assert.ok(maintenance(input)); yield* compact(input, `cp-${++calls}`);
    } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'context_compaction_no_progress');
  assert.equal(calls, 3); assert.equal(store.snapshot(sessionId).turns[0].contextToolHandoff, undefined);
});

test('keeps a checkpoint carrying earlier turns; superseding source facts invalidates the handoff', () => {
  const store = new SessionStore(); seed(store, turn('earlier', [user('Original requirement.'), assistant('Done earlier.') ]));
  const messages = [user('Continue.'), call('cp', 'checkpoint_context'), receipt('cp', 'Prior rule: do not publish.'),
    call('read', 'read_file'), receipt('read', 'A-17'), ...prepared()];
  const value = seed(store, turn('checkpoint', messages, 2, { projectionVersion: 'exchange_v1', inputMessageCount: 1,
    throughMessageId: 'checkpoint-2', exchangeMessageIds: ['checkpoint-1', 'checkpoint-2'], coveredTurnIds: ['earlier'] }));
  apply(store, value);
  const projected = assembleContext({ session: store.snapshot(sessionId) }).messages;
  assert.ok(projected.some(m => m.role === 'tool' && m.toolCallId === 'cp'));
  assert.equal(projected.some(m => m.role === 'tool' && m.toolCallId === 'read'), false);
  validateConversation(projected);
  store.supersedeMessages({ sessionId, messageIds: value.messages.map(m => m.messageId), reason: 'User replaced the turn.' });
  assert.equal(assembleContext({ session: store.snapshot(sessionId) }).messages.some(m => m.content.includes('<tool_summary')), false);
});

test('fork rebases archive references and receipt hash; indexed disk replay retains the same projection', async t => {
  const root = temp(t), persistence = new FileSessionEventPersistence({ root });
  const store = new SessionStore({ persistence });
  const text = summary + ' Read tool-result://prepared/old/read before retry.';
  const value = seed(store, turn('old', [...facts().slice(0, 3), ...prepared('summary', text)]));
  apply(store, value);
  store.ensureSession('forked');
  const fork = store.fork(sessionId, 'forked');
  assert.ok(findPreparedToolHandoff(fork.turns[0]));
  assert.ok(assembleContext({ session: fork }).messages.at(-1).content.includes('tool-result://forked/'));
  const restored = new SessionStore({ persistence: new FileSessionEventPersistence({ root }) });
  const page = await restored.historyPage({ sessionId, limit: 5 });
  assert.deepEqual(page.snapshot.turns[0].contextToolHandoff, findPreparedToolHandoff(value));
  assert.deepEqual(assembleContext({ session: page.snapshot }).messages, assembleContext({ session: store.snapshot(sessionId) }).messages);
});

test('recovery between session projection commit and completion receipt does not resurrect tools', async t => {
  const journal = [], persistence = { load: () => structuredClone(journal), append: e => journal.push(structuredClone(e)) };
  const store = new SessionStore({ persistence }); seed(store);
  const checkpoints = new InMemoryRuntimeCheckpointStore(), events = new InMemoryRuntimeEventLog();
  let saved;
  const append = events.append.bind(events);
  events.append = (identity, value) => {
    if (value.kind === 'context_compaction_completed' && value.payload.method === 'prepared_tool_handoff' && !saved) {
      saved = { journal: structuredClone(journal), events: structuredClone(events.replay(sessionId, 'next')),
        checkpoint: structuredClone(checkpoints.load(sessionId, 'next')) };
      throw new Error('Simulated crash before completion receipt.');
    }
    return append(identity, value);
  };
  const first = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog: events,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream() { throw Error('Must not dispatch before crash.'); } } });
  t.after(() => shutdown(first)); await first.runSessionTurn(request()).catch(() => {});
  assert.ok(saved?.checkpoint);
  const recovered = new InMemoryRuntimeCheckpointStore(); recovered.save(saved.checkpoint);
  const restoredStore = new SessionStore({ persistence: { load: () => saved.journal, append: e => saved.journal.push(e) } });
  const restoredEvents = new InMemoryRuntimeEventLog({ persistence: { load: () => saved.events, append: e => saved.events.push(e) } });
  let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: restoredStore, checkpointStore: recovered, eventLog: restoredEvents,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(input) {
      calls++; assert.equal(maintenance(input), false); assert.equal(input.messages.some(m => m.role === 'tool'), false); yield* done(input);
    } } });
  t.after(() => shutdown(host));
  const result = await host.resumeModelTurn(sessionId, 'next');
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload)); assert.equal(calls, 1);
  assert.equal(host.events(sessionId, 'next').filter(e => e.kind === 'context_compaction_completed').length, 1,
    JSON.stringify({ saved: saved.events.map(e => ({ kind: e.kind, payload: e.payload })), after: host.events(sessionId, 'next').map(e => ({ kind: e.kind, payload: e.payload })) }));
});

test('versioned references survive prepared projection and later checkpoint validation without source text', () => {
  const path = 'C:/fixture/SKILL.md', revision = 'a'.repeat(64);
  const skill = '# Rules\nNever publish without approval.\nRead reference images before designing.\n';
  const block = `<skill_constraints>\n- Before publication get approval: [Rules](<${path}?revision=${revision}#L2-L2>).\n- Before design view images: [References](<${path}?revision=${revision}#L3-L3>).\n</skill_constraints>`;
  const messages = [user('Prepare a draft, never publish.'), call('skill', 'read_file', { path }),
    receipt('skill', JSON.stringify({ path, sha256: revision, content: skill })), ...prepared('summary', summary + '\n' + block)];
  const store = new SessionStore(), value = seed(store, turn('with-skill', messages));
  assert.ok(findPreparedToolHandoff(value));
  for (const invalid of [block.replace(revision, 'b'.repeat(64)), block.replace('L3-L3', 'L9-L9'), 'Source read, no need to remember it.']) {
    assert.equal(findPreparedToolHandoff(turn('invalid', [...messages.slice(0, 3), ...prepared('invalid-summary', invalid)])), undefined);
  }
  apply(store, value);
  const projected = assembleContextProjection({ session: store.snapshot(sessionId), prefix: [{ role: 'system', content: 'Policy.' }] });
  assert.equal(projected.turns[0].handoffEvidence.excerpts.length, 1, 'contiguous source ranges can merge');
  assert.ok(projected.turns[0].handoffEvidence.excerpts.every(e => e.text === '' && e.revision === revision));
  assert.equal(projected.context.messages.some(m => m.role === 'tool'), false);
  const state = { revision: store.snapshot(sessionId).revision, totalTurns: 1, unsummarizedTurnIds: ['with-skill'] };
  const sources = locateContextCompactionSources({ messages: projected.context.messages, prefixMessageCount: 1,
    turns: projected.turns, activeTurnId: 'new', activeMessages: [], state, inputFormat: 'incremental' });
  const tx = new ContextCompactionTransaction({ messages: projected.context.messages, prefixMessageCount: 1, sources, state,
    pressure: { ratio: 0.96 }, inputFormat: 'incremental', outputTokens: 4000, maximumOutputTokens: 4000,
    handoffEvidence: new Map(projected.turns.map(turn => [turn.turnId, turn.handoffEvidence])) });
  assert.ok(tx.job().messages.at(-1).content.includes(`revision=${revision}`));
  const response = (id, text) => ({ status: 'completed', text: '', reasoning: '', usage: {}, finishReason: 'tool_calls',
    toolCalls: [{ id, name: 'checkpoint_context', argumentsText: JSON.stringify({ updates: [{ source: 0, summary: text }] }) }] });
  assert.equal(tx.accept(response('bad-reference', summary + '\n' + block.replaceAll(revision, 'b'.repeat(64)))), false);
  tx.job();
  assert.equal(tx.accept(response('good-reference', summary + '\n' + block)), true);
  const evidence = checkpointSkillReceiptEvidence(tx.incremental.history.at(-1));
  assert.ok(evidence[0].excerpts.every(e => e.revision === revision && e.text === ''));
});

test('the comparison switch uses the existing checkpoint path even with a valid prepared handoff', async t => {
  const store = new SessionStore(); seed(store); let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, preferPreparedToolHandoffs: false, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) {
      if (maintenance(input)) yield* compact(input, `baseline-${++calls}`); else yield* done(input);
    } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(request());
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.ok(calls > 0); assert.equal(store.snapshot(sessionId).turns[0].contextToolHandoff, undefined);
});

test('final tool reports reference errors immediately and packs only verified references on correction', () => {
  const path = 'C:/fixture/SKILL.md', revision = 'c'.repeat(64);
  const read = [call('skill', 'read_file', { path }), receipt('skill', JSON.stringify({ path, sha256: revision, content: '# Rules\nNo publication without approval.\n' }))];
  const bad = preparedToolHandoffReceipt('Prepared. All done.', read);
  assert.equal(bad.context_handoff.status, 'not_reusable');
  assert.ok(bad.context_handoff.source_index.includes(revision));
  assert.equal(bad.context_handoff.summary_sha256, undefined);
  const block = `<skill_constraints>\n- Obtain approval before publication [Rules](<${path}?revision=${revision}#L2-L2>).\n</skill_constraints>`;
  const good = preparedToolHandoffReceipt(block, read);
  assert.equal(good.context_handoff.status, 'prepared');
  const result = receipt('summary', JSON.stringify({ status: 'ok', final_response: true, ...good }));
  const evidence = checkpointSkillReceiptEvidence(result);
  assert.equal(evidence[0].excerpts[0].text, '');
  // This turn can cite a verified source read in an earlier turn. Its genuine
  // preparation receipt carries that source across later projections.
  const value = turn('inherited', [user('Continue.'), call('status', 'fixture'), receipt('status', 'pending'),
    call('summary', 'summary_for_user', { tool_summary: block }), result, assistant('Pending.')]);
  assert.ok(findPreparedToolHandoff(value));
  assert.deepEqual(preparedToolHandoffReceipt(), {});
});

test('bounded history index accepts known partial checkpoint IDs after a prepared turn', async t => {
  const root = temp(t), store = new SessionStore({ persistence: new FileSessionEventPersistence({ root }) });
  const old = seed(store); apply(store, old);
  seed(store, turn('raw', [user('New work.'), call('read', 'fixture'), receipt('read', 'Observed.'), assistant('Recent correction.')], 2));
  seed(store, turn('cp', [user('Continue.'), call('cp', 'checkpoint_context'), receipt('cp', '{}')], 3,
    { projectionVersion: 'exchange_v1', inputMessageCount: 1, throughMessageId: 'cp-2', exchangeMessageIds: ['cp-1', 'cp-2'],
      coveredTurnIds: ['old'], coveredMessageIds: ['raw-1', 'raw-2'] }));
  const restored = new SessionStore({ persistence: new FileSessionEventPersistence({ root }) });
  const page = await restored.historyPage({ sessionId, limit: 5 });
  assert.deepEqual(page.snapshot.turns.at(-1).contextCheckpoint.coveredMessageIds, ['raw-1', 'raw-2']);
  validateConversation(assembleContext({ session: page.snapshot }).messages);
});

const recorded = JSON.parse(readFileSync(new URL('./fixtures/prepared-compaction-live-20261023.json', import.meta.url)));
for (const scenario of preparedCompactionCases) test(`recorded live ${scenario.id} handoffs retain valid source versions and exact final prose offline`, () => {
  const store = new SessionStore();
  for (const [index, source] of scenario.turns.entries()) {
    const record = recorded.preparation.find(p => p.case === scenario.id && p.turn === source.id);
    const prior = store.snapshot(sessionId)?.turns.flatMap(t => t.messages.map(f => f.message)) ?? [];
    const native = preparedToolHandoffReceipt(record.summary, [...prior, ...source.messages]);
    assert.equal(native.context_handoff.status, 'prepared');
    const id = `recorded-${source.id}`;
    const value = seed(store, turn(source.id, [...source.messages, call(id, 'summary_for_user', { tool_summary: record.summary }),
      receipt(id, JSON.stringify({ status: 'ok', final_response: true, ...native })), assistant(source.final)], index + 1));
    assert.ok(findPreparedToolHandoff(value)); apply(store, value);
  }
  const projected = assembleContextProjection({ session: store.snapshot(sessionId) });
  assert.equal(projected.turns.length, 2);
  for (const [index, source] of projected.turns.entries()) {
    assert.ok(source.messages.at(-1).content.endsWith(scenario.turns[index].final));
    assert.ok(source.handoffEvidence.excerpts.length > 0);
    assert.ok(source.handoffEvidence.excerpts.every(e => e.revision && e.text === ''));
  }
});

const recordedLong = JSON.parse(readFileSync(new URL('./fixtures/prepared-compaction-long-live-20261023.json', import.meta.url)));
for (const layout of ['normal', 'overflow']) test(`recorded long ${layout} handoffs survive four pressure cycles and retain every original correction`, async t => {
  const scenario = longScenarioForLayout(layout), store = new SessionStore(), seen = [];
  store.ensureSession(sessionId);
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) {
      assert.equal(maintenance(input), false, 'Reusable recorded handoffs do not need another model compaction.');
      seen.push(structuredClone(input)); yield* done(input, 'Records received. Awaiting the next instruction.');
    } } });
  t.after(() => shutdown(host));
  const raw = recordedLong.rawRuns[layout === 'normal' ? 'progressive' : 'overflow'];
  const originals = [];
  for (const phase of scenario.phases) {
    for (const source of phase.turns) {
      const record = raw.preparations.find(p => p.variant === 'prepared' && p.turn === source.id);
      const history = assembleContext({ session: store.snapshot(sessionId) }).messages;
      const native = preparedToolHandoffReceipt(record.summary, [...history, ...source.messages]);
      assert.equal(native.context_handoff.status, 'prepared');
      const id = `long-${source.id}`, sequence = store.snapshot(sessionId).turns.length + 1;
      const value = turn(source.id, [...source.messages, call(id, 'summary_for_user', { tool_summary: record.summary }),
        receipt(id, JSON.stringify({ status: 'ok', final_response: true, ...native })), assistant(source.final)], sequence);
      assert.ok(findPreparedToolHandoff(value)); seed(store, value);
      originals.push(...source.messages.filter(m => m.role === 'user').map(m => m.content));
    }
    const turnId = `${layout}-${phase.id}`;
    const result = await host.runSessionTurn(request(turnId, { maxOutputTokens: 128000,
      metadata: { contextWindowTokens: 168000 } }));
    assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
    const events = host.events(sessionId, turnId).filter(e => e.kind === 'context_compaction_completed');
    assert.equal(events.length, 1); assert.equal(events[0].payload.method, 'prepared_tool_handoff');
    for (const content of originals) assert.ok(seen.at(-1).messages.some(m => m.role === 'user' && m.content === content));
    validateConversation(seen.at(-1).messages);
  }
  assert.equal(seen.length, 4);
  assert.equal(store.snapshot(sessionId).turns.filter(turn => turn.contextToolHandoff).length, 12);
  assert.equal(originals.length, 14);
});
