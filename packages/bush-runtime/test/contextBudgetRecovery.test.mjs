import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext,
  resolveContextBudget, estimateContextPressure, requiresContextCompactionBeforeRound,
  contextToolIngressTokenBudget, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { completeContextUnits, isContextLengthFailure } from '../dist/contextCompactionTransaction.js';
import { validateConversation } from '../dist/sessionStore.js';

const now = '2026-09-11T12:00:00Z';
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, sequence, createdAt: now, kind, ...payload });
function seed(store, id, sequence, messages) {
  store.commitTurn('budget', { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now,
    status: 'completed', reason: 'model_response_completed', usage: {},
    messages: messages.map((message, index) => ({ messageId: `${id}_${index}`, turnId: id,
      turnSequence: sequence, messageIndex: index, createdAt: now, message })) });
}
const preceding = () => [{ role: 'user', content: 'FACT_A: the task scope.' },
  { role: 'assistant', content: 'FACT_B: a write completed; verify next.', reasoningContent: 'Verified the result.', toolCalls: [] }];
const request = (overrides = {}) => ({ protocol: 'bush.session_turn_request.v1', requestId: 'budget',
  sessionId: 'budget', turnId: 'current', model: 'fixture', maxOutputTokens: 128000,
  prefixMessages: [{ role: 'system', content: 'Stable rules. A checkpoint is intermediate; continue the user task.' }],
  inputMessages: [{ messageId: 'current_user', message: { role: 'user', content: 'Finish verification.' } }],
  metadata: { contextWindowTokens: 400000 }, ...overrides, tools: [orderedCheckpointTool, ...(overrides.tools ?? [])] });
const isMaintenance = request => request.messages.some(message => message.name === 'context_pressure');
const hasCommittedCheckpoint = request => request.messages.some(message => message.role === 'tool' && message.content.includes('summarized_turns'));
function sourceRows(request) {
  return request.messages.findLast(message => message.name === 'context_pressure').content.split('\n')
    .filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}
function *checkpoint(request, id) {
  const sources = sourceRows(request);
  const summarize = source => {
    const text = JSON.stringify(request.messages.slice(source.startMessage, source.endMessageExclusive));
    return ['FACT_A', 'FACT_B', 'FACT_C'].filter(fact => text.includes(fact)).join(' ') || 'Keep the verified source facts.';
  };
  yield event(request, 0, 'reasoning_delta', { delta: 'Preserve verified facts and pending work.' });
  yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'checkpoint_context',
    argumentsDelta: JSON.stringify({ summaries: sources.filter(source => source.target.startsWith('summaries[')).map(summarize) }) });
  yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
}
function *finished(request) {
  yield event(request, 0, 'text_delta', { delta: 'Verification complete.' });
  yield event(request, 1, 'response_completed', { finishReason: 'stop' });
}
function harness(t, stream, options = {}) {
  const store = new SessionStore();
  for (const [index, messages] of (options.history ?? [preceding()]).entries()) seed(store, `old_${index}`, index + 1, messages);
  const original = structuredClone(store.snapshot('budget')?.turns ?? []);
  const observed = [];
  const provider = { countInputTokens: options.count ?? (async request => ({
    inputTokens: hasCommittedCheckpoint(request) ? 500 : 260000, source: 'provider' })),
    async *stream(request) {
      for (const message of request.messages.filter(m => ['context_pressure', 'context_compaction_correction'].includes(m.name))) {
        assert.equal(message.role, 'developer', 'New maintenance instructions must not masquerade as user turns.');
      }
      observed.push(structuredClone(request)); yield *stream(request, observed.length, store);
    } };
  const host = new InMemoryRuntimeHost({ provider, sessionStore: store, registerDefaultWorkspaceTools: false,
    ...(options.toolRegistry ? { toolRegistry: options.toolRegistry } : {}) });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  return { host, store, original, observed };
}

test('400k/128k uses an independent maintenance budget and a transparent trigger', () => {
  const budget = resolveContextBudget(400000, 128000);
  assert.deepEqual(budget, { contextWindowTokens: 400000, normalOutputTokens: 128000,
    compactionOutputTokens: 16384, safetyTokens: 2048, normalInputLimit: 272000,
    compactionInputLimit: 381568, compactionTriggerTokens: 253568 });
  const input = { model: 'fixture', tools: [], maxOutputTokens: 128000, metadata: { contextWindowTokens: 400000 } };
  for (const [tokens, expected] of [[142000, false], [253567, false], [253568, true], [258400, true]]) {
    const pressure = estimateContextPressure(input, [], tokens, { projectedInputTokens: tokens });
    assert.equal(requiresContextCompactionBeforeRound(pressure), expected);
  }
  const pressure = estimateContextPressure(input, [], 250000, { projectedInputTokens: 250000 });
  assert.equal(contextToolIngressTokenBudget({ pressure, actualInputTokens: 250000, actualOutputTokens: 128000 }), 3568,
    'Tool ingress reserves maintenance space, not another normal response');
  assert.equal(contextToolIngressTokenBudget({ pressure, actualInputTokens: 200000, actualOutputTokens: 128000 }), 53568,
    'actual usage supersedes an obsolete preflight estimate when admitting Tool results');
});

test('a truncated checkpoint retries its immutable source with a separate output budget', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) {
      yield event(input, 0, 'reasoning_delta', { delta: 'PARTIAL_PRIVATE_REASONING'.repeat(10000) });
      yield event(input, 1, 'tool_call_delta', { index: 0, toolCallId: 'partial', nameDelta: 'checkpoint_context', argumentsDelta: '{"summaries":[' });
      yield event(input, 2, 'response_completed', { finishReason: 'length' });
    } else if (isMaintenance(input)) yield *checkpoint(input, 'complete');
    else yield *finished(input);
  });
  const result = await fixture.host.runSessionTurn(request());
  assert.equal(result.payload.status, 'completed');
  assert.deepEqual(fixture.observed.map(input => input.maxOutputTokens), [16384, 32768, 128000]);
  assert.deepEqual(fixture.observed[1].messages.slice(0, -2), fixture.observed[0].messages.slice(0, -1));
  assert.doesNotMatch(JSON.stringify(fixture.observed.slice(1)), /PARTIAL_PRIVATE_REASONING|output_limit_continuation/);
  assert.equal(fixture.observed[1].messages.filter(message => message.name === 'context_pressure').length, 1);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
  const events = fixture.host.events('budget', 'current');
  assert.equal(events.filter(event => event.kind === 'context_compaction_completed').length, 1);
  assert.equal(events.filter(event => event.kind === 'model_maintenance_response').length, 2);
  assert.match(JSON.stringify(events.filter(event => event.kind === 'model_maintenance_response')), /PARTIAL_PRIVATE_REASONING/);
  const active = fixture.observed.at(-1).messages;
  assert.deepEqual(assembleContext({ session: fixture.store.snapshot('budget'), prefix: request().prefixMessages }).messages.slice(0, active.length), active);
});

test('three truncated checkpoints fail without applying partial prose, reasoning or arguments', async t => {
  const fixture = harness(t, function *(input) {
    yield event(input, 0, 'text_delta', { delta: 'INCOMPLETE_CHECKPOINT' });
    yield event(input, 1, 'response_completed', { finishReason: 'length' });
  });
  const result = await fixture.host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'context_compaction_output_limit');
  assert.equal(fixture.observed.length, 3);
  assert.ok(fixture.observed.every(input => input.messages.filter(message => message.name === 'context_pressure').length === 1));
  assert.ok(fixture.observed.every(input => input.messages.filter(message => message.name === 'context_compaction_correction').length <= 2));
  const current = fixture.store.snapshot('budget').turns.at(-1);
  assert.equal(current.contextCheckpoint, undefined);
  assert.doesNotMatch(JSON.stringify(current.messages), /INCOMPLETE_CHECKPOINT|context_pressure|output_limit_continuation/);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
});

test('length, malformed JSON and missing checkpoint share one bounded maintenance retry budget', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) yield event(input, 0, 'response_completed', { finishReason: 'length' });
    else if (ordinal === 2) {
      yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: 'broken', nameDelta: 'checkpoint_context', argumentsDelta: '{' });
      yield event(input, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else yield *finished(input);
  });
  const result = await fixture.host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'context_compaction_required');
  assert.equal(fixture.observed.length, 3);
  assert.equal(fixture.store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
});

test('a structured provider context rejection starts maintenance even below the local trigger', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) yield event(input, 0, 'response_failed', { code: 'context_length_exceeded',
      message: 'Input exceeds the context limit.', status: 400, retryable: false });
    else if (isMaintenance(input)) yield *checkpoint(input, 'recovered');
    else yield *finished(input);
  }, { count: async () => ({ inputTokens: 10000, source: 'provider' }) });
  assert.equal((await fixture.host.runSessionTurn(request())).payload.status, 'completed');
  assert.deepEqual(fixture.observed.map(input => [isMaintenance(input), input.maxOutputTokens]),
    [[false, 128000], [true, 16384], [false, 128000]]);
  assert.equal(fixture.host.events('budget', 'current').find(event => event.kind === 'context_compaction_started').payload.trigger, 'provider_context_limit');
  assert.equal(fixture.host.events('budget', 'current').find(event => event.kind === 'provider_retry').payload.causeCode, 'context_length_exceeded');
});

test('a context refusal cannot fall through to unbounded transport retries after recovery is exhausted', async t => {
  const store = new SessionStore();
  seed(store, 'old_0', 1, preceding());
  const original = structuredClone(store.snapshot('budget').turns);
  let calls = 0;
  const waits = [];
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    maxAttempts: null,
    wait: async delay => { waits.push(delay); throw new Error('A known context refusal must not be retried as a transport error.'); },
    provider: {
      countInputTokens: async () => ({ inputTokens: 10000, source: 'provider' }),
      async *stream(input) {
        calls += 1;
        yield event(input, 0, 'response_failed', { code: 'context_length_exceeded', status: 400,
          message: 'Rejected input still does not fit.', retryable: true });
      },
    },
  });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'context_length_exceeded');
  assert.equal(calls, 3, 'normal refusal and two changed maintenance requests exhaust context recovery');
  assert.deepEqual(waits, []);
  assert.deepEqual(store.snapshot('budget').turns.slice(0, -1), original);
  assert.equal(store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
});

for (const [code, status] of [['invalid_request_error', 400], ['context_length_exceeded', 401], ['insufficient_quota', 429]]) {
  test(`${code}/${status} is not reclassified from error prose`, async t => {
    const fixture = harness(t, function *(input) {
      yield event(input, 0, 'response_failed', { code, status, message: 'context length exceeded', retryable: false });
    }, { count: async () => ({ inputTokens: 10000, source: 'provider' }) });
    assert.equal((await fixture.host.runSessionTurn(request())).payload.reason, code);
    assert.equal(fixture.observed.length, 1);
    assert.equal(fixture.host.events('budget', 'current').some(event => event.kind === 'context_compaction_started'), false);
  });
}

const largeHistory = () => [
  [{ role: 'user', content: 'FACT_A ' + 'a'.repeat(40000) }, { role: 'assistant', content: 'Checked A.', reasoningContent: 'Done.', toolCalls: [] }],
  [{ role: 'user', content: 'FACT_B ' + 'b'.repeat(40000) }, { role: 'assistant', content: 'Checked B.', reasoningContent: 'Done.', toolCalls: [] }],
];
const smallerRequest = () => request({ maxOutputTokens: 4000, metadata: { contextWindowTokens: 20000 } });
const counted = async input => ({ inputTokens: Math.ceil(JSON.stringify(input.messages).length / 4) + 300, source: 'provider' });

test('oversized history stages complete sources and atomically commits only the consolidated checkpoint', async t => {
  const fixture = harness(t, function *(input, ordinal, store) {
    validateConversation(input.messages);
    if (isMaintenance(input)) {
      assert.equal(store.snapshot('budget').turns.length, 2, 'no fragment may overwrite or commit source history');
      yield *checkpoint(input, `part_${ordinal}`);
    } else yield *finished(input);
  }, { history: largeHistory(), count: counted });
  const result = await fixture.host.runSessionTurn(smallerRequest());
  assert.equal(result.payload.status, 'completed');
  assert.equal(fixture.observed.length, 4, 'two fragments, one consolidation, one normal answer');
  assert.ok(fixture.observed.every(input => Math.ceil(JSON.stringify(input.messages).length / 4) + 300 + input.maxOutputTokens <= 20000));
  assert.match(JSON.stringify(fixture.observed.at(-1).messages), /FACT_A FACT_B|FACT_A.*FACT_B/);
  const current = fixture.store.snapshot('budget').turns.at(-1);
  assert.deepEqual(current.contextCheckpoint.coveredTurnIds, ['old_0', 'old_1']);
  assert.equal(current.messages.filter(item => item.message.role === 'assistant' && item.message.toolCalls.length).length, 1);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
  assert.equal(fixture.host.events('budget', 'current').filter(event => event.kind === 'context_compaction_completed').length, 1);
});

test('later fragment failure leaves all source history and checkpoint pointers intact', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) yield *checkpoint(input, 'first_stage');
    else yield event(input, 0, 'response_failed', { code: 'invalid_api_key', status: 401, message: 'Authentication failed.', retryable: false });
  }, { history: largeHistory(), count: counted });
  const result = await fixture.host.runSessionTurn(smallerRequest());
  assert.equal(result.payload.reason, 'invalid_api_key');
  assert.equal(fixture.store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
  assert.doesNotMatch(JSON.stringify(fixture.store.snapshot('budget').turns.at(-1).messages), /first_stage/);
  assert.match(JSON.stringify(fixture.host.events('budget', 'current').filter(event => event.kind === 'model_maintenance_response')), /first_stage/);
});

test('duplicate checkpoint identities across fragments fail within the transaction instead of breaking the loop', async t => {
  const fixture = harness(t, function *(input) { yield *checkpoint(input, 'duplicate_checkpoint'); },
    { history: largeHistory(), count: counted });
  const result = await fixture.host.runSessionTurn(smallerRequest());
  assert.equal(result.payload.reason, 'context_compaction_failed');
  assert.equal(result.payload.details.checkpointDiagnostics.field, 'tool_call_id');
  assert.equal(fixture.observed.length, 4);
  assert.equal(fixture.store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
});

test('an indivisible oversized source fails without slicing text or dispatching an impossible request', async t => {
  const fixture = harness(t, function *() { assert.fail('No provider request should be sent'); }, {
    history: [[{ role: 'user', content: 'UNBROKEN ' + 'x'.repeat(100000) }]], count: counted,
  });
  const result = await fixture.host.runSessionTurn(smallerRequest());
  assert.equal(result.payload.reason, 'context_compaction_request_limit_exceeded');
  assert.equal(fixture.observed.length, 0);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
});

test('partition units keep parallel tool calls, reasoning and all receipts together', () => {
  const messages = [{ role: 'user', content: 'Inspect.' },
    { role: 'assistant', content: '', reasoningContent: 'Real reasoning',
      toolCalls: ['a', 'b'].map(id => ({ id, name: 'read', argumentsText: '{}' })) },
    { role: 'tool', toolCallId: 'b', content: 'FACT_B' }, { role: 'tool', toolCallId: 'a', content: 'FACT_A' },
    { role: 'assistant', content: 'Done', toolCalls: [] }];
  const original = structuredClone(messages);
  assert.deepEqual(completeContextUnits(messages).map(unit => unit.length), [1, 3, 1]);
  assert.deepEqual(completeContextUnits(messages).flat(), original);
  assert.throws(() => completeContextUnits(messages.slice(0, 3)), /pending tool results/);
  assert.equal(isContextLengthFailure({ code: 'context_length_exceeded', status: 400 }), true);
  assert.equal(isContextLengthFailure({ code: 'context_length_exceeded', status: 403 }), false);
});

test('zero-progress output truncation stops before another maintenance or model request', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    assert.equal(ordinal, 1, 'no-progress truncation cannot trigger another maintenance round');
    if (isMaintenance(input)) yield *checkpoint(input, `checkpoint_${ordinal}`);
    else {
      yield event(input, 0, 'reasoning_delta', { delta: 'Partial work to preserve.' });
      yield event(input, 1, 'response_completed', { finishReason: 'length' });
    }
  }, { history: [], count: async input => ({ inputTokens: input.messages.some(message =>
    message.name === 'output_limit_continuation') ? 260000 : 500, source: 'provider' }) });
  const result = await fixture.host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'model_output_limit_exceeded');
  assert.equal(fixture.observed.length, 1);
  assert.equal(result.payload.details.continuationAttempts, 0);
});

test('output truncation followed by compaction never repeats a completed tool side effect', async t => {
  let writes = 0;
  const registry = new ToolRegistry().register({ definition: { name: 'write_once', description: 'Fixture write', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: () => ({ fact: 'FACT_C', writes: ++writes }) });
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) {
      yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: 'written', nameDelta: 'write_once', argumentsDelta: '{}' });
      yield event(input, 1, 'response_completed', { finishReason: 'length', completedToolCallIndices: [0] });
    } else if (isMaintenance(input)) yield *checkpoint(input, 'post_write_checkpoint');
    else yield *finished(input);
  }, { history: [], toolRegistry: registry, count: async input => ({ inputTokens: input.messages.some(message =>
    message.name === 'output_limit_continuation') ? 260000 : 500, source: 'provider' }) });
  assert.equal((await fixture.host.runSessionTurn(request({ permissionMode: 'all_free', tools: registry.definitions() }))).payload.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(fixture.observed.length, 3);
  assert.match(JSON.stringify(fixture.observed.at(-1).messages), /FACT_C/);
  assert.equal(fixture.host.events('budget', 'current').filter(event => event.kind === 'tool_running').length, 1);
});

test('guidance arriving during staged compaction is appended after the atomic checkpoint', async t => {
  let unblock, started;
  const ready = new Promise(resolve => { started = resolve; });
  const release = new Promise(resolve => { unblock = resolve; });
  const fixture = harness(t, async function *(input, ordinal) {
    if (ordinal === 1) { started(); await release; }
    if (isMaintenance(input)) yield *checkpoint(input, `stage_${ordinal}`);
    else yield *finished(input);
  }, { history: largeHistory(), count: counted });
  const running = fixture.host.runSessionTurn(smallerRequest());
  await ready;
  const receipt = await fixture.host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: {
    protocol: 'bush.runtime_guidance.v1', sessionId: 'budget', turnId: 'current', messageId: 'new_scope',
    content: 'Use the NEW_SCOPE for verification.', createdAt: now } });
  assert.equal(receipt.queueDepth, 1);
  unblock();
  assert.equal((await running).payload.status, 'completed');
  assert.ok(fixture.observed.filter(isMaintenance).every(input => !JSON.stringify(input.messages).includes('NEW_SCOPE')));
  assert.match(fixture.observed.at(-1).messages.at(-1).content, /NEW_SCOPE/);
  assert.match(JSON.stringify(fixture.store.snapshot('budget').turns.at(-1).messages), /NEW_SCOPE/);
});

test('cancellation during staged compaction preserves the original journal and starts no more calls', async t => {
  const controller = new AbortController();
  const fixture = harness(t, function *(input, ordinal) {
    if (ordinal === 1) yield *checkpoint(input, 'first_fragment');
    else {
      yield event(input, 0, 'reasoning_delta', { delta: 'Partially read the second fragment.' });
      controller.abort();
    }
  }, { history: largeHistory(), count: counted });
  const result = await fixture.host.runSessionTurn(smallerRequest(), { signal: controller.signal });
  assert.equal(result.payload.status, 'stopped');
  assert.equal(fixture.observed.length, 2);
  assert.equal(fixture.store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
  assert.equal(fixture.host.events('budget', 'current').filter(event => event.kind === 'context_compaction_cancelled').length, 1);
});

test('a structured context refusal from token counting also partitions without dispatching rejected input', async t => {
  let refusals = 0;
  const fixture = harness(t, function *(input, ordinal) {
    if (isMaintenance(input)) yield *checkpoint(input, `count_recovery_${ordinal}`);
    else yield *finished(input);
  }, { history: largeHistory(), count: async input => {
    if (JSON.stringify(input.messages).length > 70000) {
      refusals++;
      throw Object.assign(new Error('This input exceeds the context length.'), { code: 'context_length_exceeded', status: 400 });
    }
    return counted(input);
  } });
  assert.equal((await fixture.host.runSessionTurn(smallerRequest())).payload.status, 'completed');
  assert.ok(refusals >= 2);
  assert.equal(fixture.observed.length, 4);
  const start = fixture.host.events('budget', 'current').find(event => event.kind === 'context_compaction_started');
  assert.equal(start.payload.countFailure.code, 'context_length_exceeded');
  assert.equal(start.payload.trigger, 'provider_context_limit');
});

test('an oversized active source partitions without separating parallel tool receipts or reasoning', async t => {
  const history = [[{ role: 'user', content: 'FACT_A ' + 'a'.repeat(48000) },
    { role: 'assistant', content: '', reasoningContent: 'FACT_B ' + 'r'.repeat(48000),
      toolCalls: ['parallel_a', 'parallel_b'].map(id => ({ id, name: 'observe', argumentsText: '{}' })) },
    { role: 'tool', toolCallId: 'parallel_b', content: 'Observation B.' },
    { role: 'tool', toolCallId: 'parallel_a', content: 'Observation A.' }]];
  const fixture = harness(t, function *(input, ordinal) {
    validateConversation(input.messages);
    const originalAssistant = input.messages.find(message => message.role === 'assistant' && message.toolCalls.some(call => call.id === 'parallel_a'));
    if (originalAssistant) {
      assert.equal(originalAssistant.reasoningContent, history[0][1].reasoningContent);
      assert.equal(input.messages.filter(message => message.role === 'tool' && message.toolCallId.startsWith('parallel_')).length, 2);
    }
    if (isMaintenance(input)) yield *checkpoint(input, `complete_exchange_${ordinal}`);
    else yield *finished(input);
  }, { history, count: counted });
  assert.equal((await fixture.host.runSessionTurn(smallerRequest())).payload.status, 'completed');
  assert.equal(fixture.observed.length, 4);
  assert.equal(fixture.host.events('budget', 'current').filter(event => event.kind === 'tool_running').length, 0);
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, -1), fixture.original);
});

test('restart retains the maintenance retry limit without restoring partial output into the conversation', async t => {
  const sessionJournal = [];
  const sessionStore = new SessionStore({ persistence: { load: () => structuredClone(sessionJournal), append: event => sessionJournal.push(structuredClone(event)) } });
  seed(sessionStore, 'old_0', 1, preceding());
  const eventLog = new InMemoryRuntimeEventLog();
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const controller = new AbortController();
  let ready;
  const secondAttempt = new Promise(resolve => { ready = resolve; });
  let firstCalls = 0;
  const count = async () => ({ inputTokens: 260000, source: 'provider' });
  const first = new InMemoryRuntimeHost({ sessionStore, eventLog, checkpointStore: checkpoints,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(input) {
      if (++firstCalls === 1) {
        yield event(input, 0, 'reasoning_delta', { delta: 'FAILED_DRAFT' });
        yield event(input, 1, 'response_completed', { finishReason: 'length' });
      } else { ready(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = first.runSessionTurn(request(), { signal: controller.signal });
  await secondAttempt;
  const saved = JSON.parse(JSON.stringify(checkpoints.load('budget', 'current')));
  const savedEvents = JSON.parse(JSON.stringify(eventLog.replay('budget', 'current')));
  const savedSessions = JSON.parse(JSON.stringify(sessionJournal));
  assert.doesNotMatch(JSON.stringify(saved.request.messages), /FAILED_DRAFT|context_pressure/);
  assert.equal(saved.sessionCommit.outputLimitContinuations, 0);
  controller.abort(); await running;
  const restoredCheckpoints = new InMemoryRuntimeCheckpointStore(); restoredCheckpoints.save(saved);
  const restoredSessions = new SessionStore({ persistence: { load: () => structuredClone(savedSessions), append: event => savedSessions.push(structuredClone(event)) } });
  const restoredLog = new InMemoryRuntimeEventLog({ persistence: { load: () => structuredClone(savedEvents), append: event => savedEvents.push(structuredClone(event)) } });
  const observed = [];
  const second = new InMemoryRuntimeHost({ sessionStore: restoredSessions, eventLog: restoredLog,
    checkpointStore: restoredCheckpoints, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(input) {
      observed.push(structuredClone(input));
      yield event(input, 0, 'response_completed', { finishReason: 'length' });
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await second.sendCommand({ kind: 'runtime.resume_model_turn', payload: { sessionId: 'budget', turnId: 'current' } });
  assert.equal(result.payload.reason, 'context_compaction_output_limit');
  assert.deepEqual(observed.map(input => input.maxOutputTokens), [32768, 65536]);
  assert.ok(observed.every(input => !JSON.stringify(input.messages).includes('FAILED_DRAFT')));
  assert.equal(restoredSessions.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
});

// Incident regression: nine historical sources plus a current Tool receipt.
// The fixture model fills the supplied blanks, without reconstructing identity
// fields or deciding whether the current source belongs in another array.
const currentProgress = 'User authorized the update. Skill updated; image saved; preview completed. Paid creation is NOT submitted. Next submit once.';
function filledTemplate(input) {
  const notice = input.messages.findLast(message => message.name === 'context_pressure').content;
  const line = notice.split('\n').find(line => line.startsWith('Fill this exact template;'));
  const value = JSON.parse(line.slice(line.indexOf('{')));
  const rows = sourceRows(input).filter(source => source.target !== 'not_requested');
  for (const source of rows) {
    const text = source.turnId === 'current' ? currentProgress : `Verified historical facts for ${source.turnId}.`;
    const index = source.target.match(/^summaries\[(\d+)\]/)?.[1];
    if (index !== undefined) {
      if (source.target.endsWith('.summary')) value.summaries[Number(index)].summary = text;
      else value.summaries[Number(index)] = text;
    } else if (source.target === 'active_summary') value.active_summary = text;
    else value.active_turn.summary = text;
  }
  return value;
}
function *replyCheckpoint(input, id, value = filledTemplate(input)) {
  yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: id,
    nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify(value) });
  yield event(input, 1, 'response_completed', { finishReason: 'tool_calls' });
}
function committedCheckpoint(turn) {
  const message = turn.messages.find(item => item.messageId === turn.contextCheckpoint.exchangeMessageIds[0]).message;
  return JSON.parse(message.toolCalls[0].argumentsText);
}
function observationRegistry(onExecute) {
  return new ToolRegistry().register({ definition: { name: 'observe_once', description: 'Record completed work.', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: value => value, execute: () => { onExecute(); return { completed: 'Skill updated and preview ready; paid creation not submitted.' }; } });
}
function *observe(input) {
  yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: 'completed_once', nameDelta: 'observe_once', argumentsDelta: '{}' });
  yield event(input, 1, 'response_completed', { finishReason: 'tool_calls' });
}
const nineSources = () => Array.from({ length: 9 }, (_, i) => [
  { role: 'user', content: `Historical request ${i}` },
  { role: 'assistant', content: `Verified historical facts for old_${i}.`, toolCalls: [] },
]);
const activeCount = async input => ({ inputTokens: hasCommittedCheckpoint(input) ? 500
  : input.messages.some(message => message.role === 'tool') ? 260000 : 500, source: 'provider' });

for (const mode of ['first attempt', 'partitioned correction', 'last allowed request']) test(`nine-plus-one fills slots and resumes once (${mode})`, async t => {
  const fallback = mode !== 'first attempt';
  let executions = 0, maintenance = 0;
  const sizes = [];
  const registry = observationRegistry(() => executions++);
  const fixture = harness(t, function *(input, ordinal, store) {
    if (isMaintenance(input)) {
      maintenance++;
      sizes.push(sourceRows(input).filter(source => source.target !== 'not_requested').length);
      assert.equal(store.snapshot('budget').turns.length, 9);
      const value = filledTemplate(input);
      assert.deepEqual(Object.keys(value), ['summaries']);
      if (fallback && maintenance > 2 && sizes.at(-1) === 10) {
        const rows = sourceRows(input);
        assert.equal(input.messages.filter(message => message.role === 'assistant' && message.toolCalls.length).length, 2,
          'each genuine staged exchange appears once, even when it owns nine sources');
        for (const [index, row] of rows.entries()) {
          const locator = row.checkpointSummaries[0];
          const args = JSON.parse(input.messages[locator.message].toolCalls[0].argumentsText);
          const slot = Number(locator.target.match(/\[(\d+)\]/)[1]);
          assert.equal(args.summaries[slot], value.summaries[index], 'source locator must select only this slot\'s facts');
        }
      }
      if (fallback && (maintenance <= 2 || mode === 'last allowed request' && [3, 4, 6, 7].includes(maintenance))) {
        value.summaries.push('EXTRA_REJECTED_DRAFT');
      }
      yield *replyCheckpoint(input, `slot_${maintenance}`, value);
    } else if (!hasCommittedCheckpoint(input)) yield *observe(input);
    else {
      assert.match(JSON.stringify(input.messages), /Paid creation is NOT submitted/);
      assert.doesNotMatch(JSON.stringify(input.messages), /EXTRA_REJECTED_DRAFT/);
      yield *finished(input);
    }
  }, { toolRegistry: registry, history: nineSources(), count: activeCount });
  const original = structuredClone(fixture.original);
  const result = await fixture.host.runSessionTurn(request({ tools: registry.definitions().filter(tool => tool.name === 'observe_once') }));
  assert.equal(result.payload.status, 'completed');
  assert.equal(executions, 1);
  assert.deepEqual(sizes, mode === 'last allowed request' ? [10, 10, 9, 9, 9, 1, 1, 1, 10]
    : fallback ? [10, 10, 9, 1, 10] : [10]);
  const snapshot = fixture.store.snapshot('budget');
  assert.deepEqual(snapshot.turns.slice(0, 9), original);
  assert.equal(committedCheckpoint(snapshot.turns.at(-1)).summaries[9], currentProgress);
  assert.deepEqual(snapshot.turns.at(-1).contextCheckpoint.coveredTurnIds, original.map(turn => turn.turnId));
  assert.equal(fixture.host.events('budget', 'current').filter(event => event.kind === 'context_compaction_completed').length, 1);
  if (fallback) {
    const retry = fixture.host.events('budget', 'current').filter(event => event.kind === 'context_compaction_retrying');
    assert.match(retry[0].payload.message, /summaries\[9\]/);
    assert.match(retry[0].payload.message, /exactly 10/);
    assert.equal(retry[1].payload.diagnostics.correctionPartition, true);
    assert.doesNotMatch(JSON.stringify(retry), /EXTRA_REJECTED_DRAFT/);
  }
  for (const input of fixture.observed) assert.deepEqual(input.tools, fixture.observed[0].tools);
});

test('invalid slots exhaust the small-job budget without committing a partial checkpoint', async t => {
  const fixture = harness(t, function *(input, ordinal) {
    yield *replyCheckpoint(input, `invalid_${ordinal}`, { summaries: [] });
  }, { history: nineSources() });
  const result = await fixture.host.runSessionTurn(request());
  assert.equal(result.payload.reason, 'context_compaction_failed');
  assert.equal(fixture.observed.length, 5, 'two root attempts and three attempts on the first smaller job');
  assert.deepEqual(fixture.store.snapshot('budget').turns.slice(0, 9), fixture.original);
  assert.equal(fixture.store.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
});

for (const format of ['ordered-partition', 'ordered-exhausted', 'separate', 'identified']) test(`restart preserves filled-slot ownership and saved ${format} contract`, async t => {
  const ordered = format.startsWith('ordered');
  const journal = [];
  const store = new SessionStore({ persistence: { load: () => structuredClone(journal), append: value => journal.push(structuredClone(value)) } });
  nineSources().forEach((messages, index) => seed(store, `old_${index}`, index + 1, messages));
  const original = structuredClone(store.snapshot('budget').turns);
  const eventLog = new InMemoryRuntimeEventLog(), checkpoints = new InMemoryRuntimeCheckpointStore();
  let executions = 0, maintenance = 0, ready;
  const paused = new Promise(resolve => { ready = resolve; });
  const controller = new AbortController();
  const registry = observationRegistry(() => executions++);
  const first = new InMemoryRuntimeHost({ sessionStore: store, eventLog, checkpointStore: checkpoints,
    toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: activeCount, async *stream(input) {
      if (!isMaintenance(input)) { yield *observe(input); return; }
      maintenance++;
      if (ordered && (maintenance <= 2 || format === 'ordered-exhausted' && [3, 4, 6, 7].includes(maintenance))) {
        yield *replyCheckpoint(input, `rejected_${maintenance}`, { summaries: [] });
      } else if (format === 'ordered-exhausted' && [5, 8].includes(maintenance)) {
        yield *replyCheckpoint(input, `completed_${maintenance}`);
      } else { ready(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const start = request({ tools: registry.definitions().filter(tool => tool.name === 'observe_once') });
  if (!ordered) start.tools = [...start.tools.filter(tool => tool.name !== 'checkpoint_context'),
    { name: 'checkpoint_context', description: 'Saved checkpoint catalog.', inputSchema: { type: 'object',
      required: format === 'separate' ? ['summaries', 'active_summary'] : ['session_revision', 'summaries'],
      properties: format === 'separate' ? { summaries: { type: 'array', items: { type: 'string' } }, active_summary: { type: 'string' } }
        : { session_revision: { type: 'integer' }, summaries: { type: 'array', items: { type: 'object' } }, active_turn: { type: 'object' } } } }];
  const running = first.runSessionTurn(start, { signal: controller.signal });
  await paused;
  const saved = structuredClone(checkpoints.load('budget', 'current'));
  const events = structuredClone(eventLog.replay('budget', 'current'));
  const sessions = structuredClone(journal);
  controller.abort(); await running;
  const restored = new InMemoryRuntimeCheckpointStore(); restored.save(saved);
  const restoredStore = new SessionStore({ persistence: { load: () => structuredClone(sessions), append: value => sessions.push(structuredClone(value)) } });
  const restoredLog = new InMemoryRuntimeEventLog({ persistence: { load: () => structuredClone(events), append: value => events.push(structuredClone(value)) } });
  const observed = [];
  const second = new InMemoryRuntimeHost({ sessionStore: restoredStore, eventLog: restoredLog, checkpointStore: restored,
    toolRegistry: observationRegistry(() => executions++), registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: activeCount, async *stream(input) {
      observed.push(structuredClone(input));
      if (isMaintenance(input)) yield *replyCheckpoint(input, `resumed_${observed.length}`);
      else yield *finished(input);
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await second.sendCommand({ kind: 'runtime.resume_model_turn', payload: { sessionId: 'budget', turnId: 'current' } });
  if (format === 'ordered-exhausted') {
    assert.equal(result.payload.reason, 'context_compaction_failed');
    assert.match(result.payload.details.message, /correction budget was exhausted/);
    assert.equal(observed.length, 0, 'restart must count the interrupted ninth dispatch and cannot grant fresh requests');
    assert.deepEqual(restoredStore.snapshot('budget').turns.slice(0, 9), original);
    assert.equal(restoredStore.snapshot('budget').turns.at(-1).contextCheckpoint, undefined);
    assert.equal(executions, 1);
    return;
  }
  assert.equal(result.payload.status, 'completed');
  assert.equal(executions, 1, 'completed Tool receipts survive restart');
  const sizes = observed.filter(isMaintenance).map(input => sourceRows(input).filter(row => row.target !== 'not_requested').length);
  assert.deepEqual(sizes, format === 'ordered-partition' ? [9, 1, 10] : [10]);
  for (const input of observed) assert.deepEqual(input.tools, saved.request.tools);
  assert.deepEqual(restoredStore.snapshot('budget').turns.slice(0, 9), original);
  const committed = committedCheckpoint(restoredStore.snapshot('budget').turns.at(-1));
  assert.equal(format === 'ordered-partition' ? committed.summaries[9]
    : format === 'separate' ? committed.active_summary : committed.active_turn.summary, currentProgress);
});
