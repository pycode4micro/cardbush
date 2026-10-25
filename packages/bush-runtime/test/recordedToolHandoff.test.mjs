import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext, assembleContextProjection,
  FileSessionEventPersistence, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { findRecordedToolHandoff, validateToolHandoff } from '../dist/recordedToolHandoff.js';
import { validateConversation } from '../dist/sessionStore.js';
import { collectCheckpointSkillExcerpts } from '../dist/checkpointSkillEvidence.js';
import { readConversationHistory } from '../dist/conversationHistory.js';
import { preparedCompactionCases } from '../../../scripts/fixtures/prepared-compaction-cases.mjs';

const now = '2026-10-23T08:00:00Z', sessionId = 'recorded';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const call = (id, name, args = {}) => ({ role: 'assistant', content: 'Progress, not a final reply.', reasoningContent: 'hidden reasoning',
  toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }] });
const receipt = (id, value) => ({ role: 'tool', toolCallId: id, content: typeof value === 'string' ? value : JSON.stringify(value) });
const log = 'unchanged sample\n'.repeat(4000);
const final = 'Draft V-12 exists; R-12 is running. Listening review and approval remain outstanding.';
const facts = () => [user('Create a draft only. Never publish or repeat a submitted job.'),
  call('render', 'fixture_render', { reason: 'Prepare the draft', version: 'V-12' }),
  receipt('render', { status: 'ok', currentJob: { id: 'R-12', status: 'running' },
    previousJob: { id: 'R-11', status: 'failed', reason: 'missing codec' }, listening: false, log }), assistant(final)];
function turn(id = 'old', messages = facts(), sequence = 1, checkpoint) {
  return { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now, status: 'completed',
    reason: 'model_response_completed', usage: {}, ...(checkpoint ? { contextCheckpoint: checkpoint } : {}),
    messages: messages.map((message, messageIndex) => ({ messageId: `${id}-${messageIndex}`, turnId: id,
      turnSequence: sequence, messageIndex, createdAt: now, message })) };
}
function seed(store, value = turn()) { store.commitTurn(sessionId, value); return store.snapshot(sessionId).turns.at(-1); }
function apply(store, value) { return store.summarizeTurns({ sessionId, expectedRevision: store.snapshot(sessionId).revision,
  summaries: [{ turnId: value.turnId, toolHandoff: findRecordedToolHandoff(value) }] }); }
function projected(messages = facts()) {
  const store = new SessionStore(), value = seed(store, turn('old', messages)); apply(store, value);
  return assembleContext({ session: store.snapshot(sessionId) }).messages;
}
const entries = messages => messages.filter(m => m.content.startsWith('<recorded_tool_exchange>'))
  .flatMap(m => JSON.parse(m.content.split('\n')[1]).entries);
function temp(t) { const root = mkdtempSync(join(tmpdir(), 'cardbush-recorded-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); }); return root; }
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, sequence, createdAt: now, kind, ...payload });
const count = async request => ({ source: 'provider', inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4) });
const maintenance = request => request.messages.some(message => message.name === 'context_pressure');
function* done(request, content = final) {
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
  yield* invoke(request, id, 'checkpoint_context', { updates: rows.map(row => ({ source: row.source, summary: final })) });
}
const request = (turnId = 'next', overrides = {}) => ({ protocol: 'bush.session_turn_request.v1',
  requestId: turnId, sessionId, turnId, model: 'fixture', reasoningEffort: 'high', maxOutputTokens: 4000,
  prefixMessages: [{ role: 'system', content: 'Stable policy. Never fabricate verification.' }],
  inputMessages: [{ messageId: `${turnId}-user`, message: user('Inspect the existing job. Never resubmit it.') }],
  metadata: { contextWindowTokens: 20000 }, ...overrides });
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });

test('default path needs no summary call, preserves original facts, and replays at pressure', async t => {
  const journal = [], persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
  const store = new SessionStore({ persistence }), old = seed(store), original = structuredClone(old.messages);
  assert.ok(assembleContext({ session: store.snapshot(sessionId) }).messages.some(m => m.role === 'tool'));
  const seen = [], host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) { seen.push(structuredClone(input)); yield* done(input); } } });
  t.after(() => shutdown(host));
  assert.equal((await host.runSessionTurn(request())).payload.status, 'completed');
  assert.equal(seen.length, 1); assert.equal(maintenance(seen[0]), false);
  assert.equal(entries(seen[0].messages)[0].reason, 'Prepare the draft');
  const retained = entries(seen[0].messages)[0].receipt;
  assert.equal(retained.currentJob.id, 'R-12'); assert.equal(retained.currentJob.status, 'running');
  assert.equal(retained.previousJob.status, 'failed'); assert.equal(retained.listening, false);
  assert.ok(retained.log.omitted_chars > 50000);
  assert.ok(seen[0].messages.some(m => m.content === final));
  assert.equal(seen[0].messages.some(m => m.reasoningContent), false);
  assert.deepEqual(store.snapshot(sessionId).turns[0].messages, original);
  const restored = new SessionStore({ persistence }).snapshot(sessionId);
  assert.deepEqual(assembleContext({ session: restored, prefix: request().prefixMessages }).messages.slice(0, seen[0].messages.length), seen[0].messages);
  const completed = host.events(sessionId, 'next').find(e => e.kind === 'context_compaction_completed').payload;
  assert.equal(completed.method, 'recorded_tool_handoff');
  assert.ok(completed.inputTokensAfter < completed.inputTokensBefore / 5);
  assert.ok(completed.inputTokensAfter <= completed.targetInputTokens);
  const originalPage = readConversationHistory(restored, { locator: 'conversation-history://turns/old/old', offset: 0, maxChars: 50000 });
  assert.ok(originalPage.text.includes('unchanged sample')); assert.ok(originalPage.next_offset);
});

test('real tool work finishes directly; prefixes remain append-only except at pressure', async t => {
  const root = temp(t), registry = new ToolRegistry(), store = new SessionStore();
  let businessCalls = 0, rounds = 0;
  registry.register({ definition: { name: 'fixture_render', description: 'Offline only.', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: x => x, execute: () => { businessCalls++; return { job: 'R-12', status: 'running', log }; } });
  const seen = [], host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, dataRoot: root,
    durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    registerDefaultWorkspaceTools: false, provider: {
      countInputTokens: input => ({ source: 'provider', inputTokens:
        input.turnId === 'compact' && !entries(input.messages).length ? 13000 : 4000 }),
      async *stream(input) {
        seen.push(structuredClone(input)); assert.equal(maintenance(input), false);
        if (input.turnId === 'initial' && rounds++ === 0) yield* invoke(input, 'real-render', 'fixture_render', { reason: 'Prepare draft' });
        else yield* done(input);
      },
    } });
  t.after(() => shutdown(host));
  for (const id of ['initial', 'follow', 'compact', 'after']) {
    assert.equal((await host.runSessionTurn(request(id, { tools: registry.definitions(), permissionMode: 'all_free' }))).payload.status, 'completed');
    assert.equal(Boolean(store.snapshot(sessionId).turns[0].contextToolHandoff), ['compact', 'after'].includes(id));
  }
  assert.equal(businessCalls, 1); assert.equal(seen.length, 5, 'no final-display or summary round');
  assert.ok(seen.every(input => !input.tools.find(t => t.name === 'summary_for_user').inputSchema.properties.tool_summary));
  for (const id of ['follow', 'after']) assert.ok(host.events(sessionId, id).filter(e => e.kind === 'cache_chain_observed')
    .every(e => e.payload.prefixComparisonAvailable && !e.payload.frozenPrefixBreak && !e.payload.parametersChanged));
  assert.ok(host.events(sessionId, 'compact').some(e => e.kind === 'cache_chain_observed' && e.payload.frozenPrefixBreak));
});

test('keeps user corrections in order, exact final prose, and original action titles', () => {
  const messages = projected([user('Use V-1'), call('one', 'read_file', { _display_title: { zh: '检查配置', en: 'Inspect config' } }),
    receipt('one', { version: 'V-1', log }), assistant('Intermediate commentary'), user('Correction: V-2; do not publish'),
    call('two', 'inspect'), receipt('two', { version: 'V-2' }), assistant('  Exact final.\n')]);
  assert.equal(entries(messages)[0].reason, '检查配置');
  assert.equal(messages[2].content, 'Correction: V-2; do not publish');
  assert.equal(messages.at(-1).content, '  Exact final.\n');
  assert.equal(messages.some(m => m.content === 'Intermediate commentary'), false);
  validateConversation(messages);
});

test('keeps nested failures, denials, running jobs and nonzero terminal exits without treating dispatch as success', () => {
  const values = [
    { status: 'ok', results: [{ status: 'denied', reason: 'User refused publication' }, { status: 'running', taskId: 'job-4' }] },
    { content: [{ type: 'text', text: JSON.stringify({ isError: true, message: 'Missing permission' }) }], isError: false },
    { exitCode: 1, state: 'completed', stdout: log + 'Critical failure in the middle\n' + log, stderr: 'Build failed' },
    { isError: true, content: [{ type: 'text', text: log + 'Do not retry token-8' + log }] },
  ];
  for (const [index, value] of values.entries()) {
    const retained = entries(projected([user('Inspect only'), call('x', 'run_tools'), receipt('x', value), assistant(final)]))[0].receipt;
    if (index === 1) assert.equal(retained.content[0].text.encoded_json.isError, true);
    else assert.deepEqual(retained, value);
  }
});

test('retains every status in long result arrays and keeps unknown fields losslessly', () => {
  const results = Array.from({ length: 200 }, (_, index) => ({ id: `part-${index}`, status: index === 99 ? 'failed' : 'ok', output: 'small' }));
  const value = { results, opaqueFacts: log, log };
  const retained = entries(projected([user('Inspect'), call('x', 'batch'), receipt('x', value), assistant(final)]))[0].receipt;
  assert.deepEqual(retained.results, results); assert.equal(retained.opaqueFacts, log); assert.ok(retained.log.omitted_chars);
});

test('terminal text envelopes keep exit codes and stderr, and unknown plain output stays whole', () => {
  const diagnostic = 'Permission denied; partial output exists. ' + log;
  const text = JSON.stringify({ terminalSessionId: 'T-9', exitCode: 1, state: 'completed' }) + '\n\n[stdout]\n' + log + '\n\n[stderr]\n' + diagnostic;
  const retained = entries(projected([user('Test'), call('x', 'terminal'), receipt('x', text), assistant(final)]))[0].receipt;
  assert.equal(retained.metadata.exitCode, 1); assert.equal(retained.sections[0].value, log); assert.equal(retained.sections[1].value, diagnostic);
  const plain = 'Unknown receipt\n' + log;
  assert.equal(entries(projected([user('Test'), call('x', 'custom'), receipt('x', plain), assistant(final)]))[0].receipt, plain);
});

test('preserves whole parallel exchanges when a Skill or image must remain available', () => {
  const skill = '# Policy\nNever publish without approval.\n' + log;
  const messages = [user('Work'), { ...call('skill', 'read_file', { path: 'C:/fixture/SKILL.md' }),
    toolCalls: [...call('skill', 'read_file', { path: 'C:/fixture/SKILL.md' }).toolCalls, ...call('other', 'inspect').toolCalls] },
    receipt('other', { status: 'running' }), receipt('skill', { path: 'C:/fixture/SKILL.md', sha256: 'a'.repeat(64), content: skill }), assistant(final)];
  const value = projected(messages);
  assert.equal(value.filter(m => m.role === 'tool').length, 2); validateConversation(value);
  assert.equal(collectCheckpointSkillExcerpts(value)[0].text, skill);
  const image = { ...receipt('image', { path: '/reference.png' }), images: [{ url: 'data:image/png;base64,AA==' }] };
  assert.deepEqual(projected([user('Inspect'), call('image', 'view_image'), image, assistant(final)])[2], image);
  const instructions = receipt('rules', { path: 'C:/fixture/AGENTS.md', content: '# Rules\n' + log });
  assert.deepEqual(projected([user('Inspect'), call('rules', 'read_file', { path: 'C:/fixture/AGENTS.md' }), instructions, assistant(final)])[2], instructions);
});

for (const status of ['failed', 'stopped', 'awaiting_user_action']) test(`retains ${status} turns for model fallback`, () => {
  assert.equal(findRecordedToolHandoff({ ...turn(), status }), undefined);
});
test('rejects missing receipts, orphan results, late unanswered guidance and forged source digests', () => {
  for (const messages of [[user('x'), call('x', 'test'), assistant('not done')],
    [user('x'), receipt('x', '{}'), assistant('unknown')], [...facts(), user('Cancel the job')], [user('hi'), assistant('hello')]]) {
    assert.equal(findRecordedToolHandoff(turn('bad', messages)), undefined);
  }
  const value = turn(), handoff = findRecordedToolHandoff(value);
  value.messages[2].message.content = '{"status":"failed"}';
  assert.throws(() => validateToolHandoff(value, handoff), /unchanged/);
});

test('keeps an earlier checkpoint and never reintroduces covered tool exchanges', () => {
  const store = new SessionStore(); seed(store, turn('earlier', [user('Original request'), assistant('Old final')]));
  const messages = [user('Continue'), call('cp', 'checkpoint_context'), receipt('cp', 'No publication allowed.'), ...facts().slice(1)];
  const value = seed(store, turn('checkpoint', messages, 2, { projectionVersion: 'exchange_v1', inputMessageCount: 1,
    throughMessageId: 'checkpoint-2', exchangeMessageIds: ['checkpoint-1', 'checkpoint-2'], coveredTurnIds: ['earlier'] }));
  apply(store, value);
  const context = assembleContext({ session: store.snapshot(sessionId) }).messages;
  assert.ok(context.some(m => m.role === 'tool' && m.toolCallId === 'cp')); assert.equal(entries(context).length, 1);
  assert.equal(context.some(m => m.content === 'Old final'), false); validateConversation(context);
});

for (const kind of ['checkpoint', 'instructions', 'image', 'ordinary']) {
  test(`partial coverage survives recorded projection and restart without resurrecting ${kind} work`, () => {
    const journal = [], persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
    const store = new SessionStore({ persistence });
    const name = kind === 'checkpoint' ? 'checkpoint_context' : kind === 'instructions' ? 'read_file' : kind === 'image' ? 'view_image' : 'inspect';
    const oldCall = call('covered-work', name, { path: 'C:/fixture/AGENTS.md', reason: 'Old intent' });
    // Reverse parallel receipt order: matching must use IDs, not array position.
    if (kind === 'instructions') oldCall.toolCalls.push(...call('covered-parallel', 'inspect').toolCalls);
    const oldReceipt = receipt('covered-work', { content: 'Superseded requirement: use the remote renderer.' });
    if (kind === 'image') oldReceipt.images = [{ url: 'data:image/png;base64,AA==' }];
    const messages = [user('Old request'),
      ...(kind === 'checkpoint' ? [call('earlier-work', 'inspect'), receipt('earlier-work', 'Inspected before checkpoint.')] : []), oldCall,
      ...(kind === 'instructions' ? [receipt('covered-parallel', { status: 'failed', error: 'Remote unavailable' })] : []),
      oldReceipt, assistant('Original final remains available.')];
    const boundary = messages.length - 2;
    const old = seed(store, turn('old', messages, 1, kind === 'checkpoint' ? {
      projectionVersion: 'exchange_v1', inputMessageCount: 1, throughMessageId: `old-${boundary}`,
      exchangeMessageIds: [`old-${boundary - 1}`, `old-${boundary}`], coveredTurnIds: [],
    } : undefined));
    const correction = 'User now requires local rendering only; remote access is not authorized. Verification is still pending.';
    seed(store, turn('later', [user('Use the local renderer.'), call('new-checkpoint', 'checkpoint_context'),
      receipt('new-checkpoint', correction), assistant('Continue verification.')], 2, {
      projectionVersion: 'exchange_v1', inputMessageCount: 1, throughMessageId: 'later-2',
      exchangeMessageIds: ['later-1', 'later-2'], coveredTurnIds: [],
      coveredMessageIds: old.messages.slice(0, boundary + 1).map(item => item.messageId),
    }));
    const before = assembleContext({ session: store.snapshot(sessionId) }).messages;
    apply(store, old);
    const after = assembleContext({ session: store.snapshot(sessionId) }).messages;
    validateConversation(after);
    assert.deepEqual(after, before, 'covered calls, receipts and synthesized records must all remain absent');
    assert.equal(after.some(m => m.content.includes('Superseded requirement')), false);
    assert.equal(after.filter(m => m.content === correction).length, 1);
    const replay = new SessionStore({ persistence });
    assert.deepEqual(assembleContext({ session: replay.snapshot(sessionId) }).messages, after);
    assert.deepEqual(replay.snapshot(sessionId).turns[0].messages, old.messages, 'canonical history is untouched');
  });
}

test('recorded projection retains canonical IDs and provider replay for native messages', () => {
  const store = new SessionStore();
  const native = { ...call('rules', 'read_file', { path: 'C:/fixture/AGENTS.md' }),
    providerReplay: { format: 'opaque', model: 'fixture', messageHash: 'a'.repeat(64), data: { signed: 'UNCHANGED' } } };
  const value = seed(store, turn('native', [user('Keep local.'), native, receipt('rules', 'Local only.'), assistant(final)]));
  apply(store, value);
  const context = assembleContextProjection({ session: store.snapshot(sessionId) });
  assert.deepEqual(context.turns[0].messageIds, value.messages.map(item => item.messageId));
  assert.deepEqual(context.context.messages[1], native, 'a retained native call must keep its provider-required replay');
  assert.deepEqual(assembleContext({ session: store.snapshot(sessionId),
    coveredMessageIds: value.messages.map(item => item.messageId) }).messages, []);
});

test('recorded projection cannot conceal incomplete parallel coverage behind a synthetic receipt', () => {
  const store = new SessionStore();
  const parallel = { ...call('a', 'inspect'), toolCalls: [...call('a', 'inspect').toolCalls, ...call('b', 'inspect').toolCalls] };
  const value = seed(store, turn('parallel', [user('Inspect'), parallel, receipt('b', 'B'), receipt('a', 'A'), assistant(final)]));
  apply(store, value);
  for (const coveredMessageIds of [['parallel-1'], ['parallel-2'], ['parallel-1', 'parallel-2']]) {
    assert.throws(() => assembleContext({ session: store.snapshot(sessionId), coveredMessageIds }),
      /pending|Tool result/, 'invalid coverage must fail before calls are condensed');
  }
});

test('fork rebases archive references and digest; durable replay and supersession retain original history', async t => {
  const root = temp(t), store = new SessionStore({ persistence: new FileSessionEventPersistence({ root }) });
  const value = seed(store, turn('old', [user('Inspect'), call('x', 'inspect'),
    receipt('x', { locator: 'tool-result://recorded/old/x', log }), assistant(final)]));
  apply(store, value); store.ensureSession('forked'); const fork = store.fork(sessionId, 'forked');
  assert.deepEqual(fork.turns[0].contextToolHandoff, findRecordedToolHandoff(fork.turns[0]));
  assert.equal(entries(assembleContext({ session: fork }).messages)[0].receipt.locator, 'tool-result://forked/old/x');
  const replay = new SessionStore({ persistence: new FileSessionEventPersistence({ root }) });
  assert.deepEqual(assembleContext({ session: replay.snapshot('forked') }).messages, assembleContext({ session: fork }).messages);
  const page = await replay.historyPage({ sessionId: 'forked', limit: 5 });
  assert.deepEqual(assembleContext({ session: page.snapshot }).messages, assembleContext({ session: fork }).messages);
  store.supersedeMessages({ sessionId, messageIds: value.messages.map(m => m.messageId), reason: 'Replaced' });
  assert.equal(assembleContext({ session: store.snapshot(sessionId) }).messages.length, 0);
});

test('unstructured oversized output falls back to model compaction without applying an ineffective projection', async t => {
  const store = new SessionStore(); seed(store, turn('old', [user('Inspect'), call('x', 'unknown'), receipt('x', log), assistant(final)]));
  let maintenanceCalls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) {
      if (maintenance(input)) yield* compact(input, `fallback-${++maintenanceCalls}`); else yield* done(input);
    } } });
  t.after(() => shutdown(host));
  assert.equal((await host.runSessionTurn(request())).payload.status, 'completed');
  assert.ok(maintenanceCalls); assert.equal(store.snapshot(sessionId).turns[0].contextToolHandoff, undefined);
  assert.equal(host.events(sessionId, 'next').find(e => e.kind === 'context_compaction_completed').payload.method, 'checkpoint');
});

test('recovery after projection commit needs no summary request and never reruns business tools', async t => {
  const journal = [], store = new SessionStore({ persistence: { load: () => structuredClone(journal), append: e => journal.push(structuredClone(e)) } });
  seed(store); const checkpoints = new InMemoryRuntimeCheckpointStore(), events = new InMemoryRuntimeEventLog(); let saved;
  const append = events.append.bind(events);
  events.append = (identity, value) => {
    if (value.kind === 'context_compaction_completed' && value.payload.method === 'recorded_tool_handoff' && !saved) {
      saved = { journal: structuredClone(journal), events: structuredClone(events.replay(sessionId, 'next')), checkpoint: structuredClone(checkpoints.load(sessionId, 'next')) };
      throw new Error('Simulated crash');
    }
    return append(identity, value);
  };
  const first = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog: events,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream() { throw Error('Unexpected dispatch'); } } });
  t.after(() => shutdown(first)); await first.runSessionTurn(request()).catch(() => {}); assert.ok(saved?.checkpoint);
  const recovered = new InMemoryRuntimeCheckpointStore(); recovered.save(saved.checkpoint);
  let calls = 0;
  const host = new InMemoryRuntimeHost({ checkpointStore: recovered,
    sessionStore: new SessionStore({ persistence: { load: () => saved.journal, append: e => saved.journal.push(e) } }),
    eventLog: new InMemoryRuntimeEventLog({ persistence: { load: () => saved.events, append: e => saved.events.push(e) } }),
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(input) {
      calls++; assert.equal(maintenance(input), false); assert.equal(entries(input.messages).length, 1); yield* done(input);
    } } });
  t.after(() => shutdown(host)); assert.equal((await host.resumeModelTurn(sessionId, 'next')).payload.status, 'completed');
  assert.equal(calls, 1); assert.equal(host.events(sessionId, 'next').filter(e => e.kind === 'context_compaction_completed').length, 1);
});

for (const item of preparedCompactionCases) test(`offline ${item.id} corpus retains source constraints and result facts with no prepared summary`, () => {
  const store = new SessionStore();
  for (const [index, source] of item.turns.entries()) apply(store, seed(store, turn(source.id, [...source.messages, assistant(source.final)], index + 1)));
  const context = assembleContextProjection({ session: store.snapshot(sessionId) });
  validateConversation(context.context.messages);
  assert.ok(collectCheckpointSkillExcerpts(context.context.messages).length);
  assert.ok(JSON.stringify(context.context.messages).length < JSON.stringify(store.snapshot(sessionId).turns).length / 4);
  for (const source of item.turns) assert.ok(context.context.messages.some(m => m.content === source.final));
  if (item.id === 'video') {
    const data = entries(context.context.messages).at(-1).receipt;
    assert.equal(data.currentJob.status, 'running'); assert.equal(data.cue.startSeconds, 7.4); assert.equal(data.cue.gainDb, -18);
  }
});
