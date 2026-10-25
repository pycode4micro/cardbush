import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog,
  SessionStore, ToolRegistry, assembleContext } from '../dist/index.js';
import { validateConversation } from '../dist/sessionStore.js';
import { checkpointReceiptEntries } from '../dist/checkpointReceipt.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';

const now = '2026-10-25T04:00:00Z', sessionId = 'retention', turnId = 'unfinished';
const original = '生成本地预览，只能写 D:/output/draft.html；不要发布或上传；结果用中文；失败可重试一次。';
const correction = '更正：不要重试，也不要重新提交 R-12；只检查这个现有任务，保留草稿。';
const initial = () => ({ step: 0, requirements: { language: '中文', publish: false, upload: false,
  writePath: 'D:/output/draft.html', retry: 'once' }, facts: {}, pending: ['inspect', 'submit', 'verify'] });
const changedRequirements = () => ({ ...initial().requirements, retry: 'never', resubmit: false, keepDraft: true, inspectJob: 'R-12' });
const observations = [
  { step: 1, facts: { finding: '音轨在 7.4 秒处有爆音，尚未修复', evidence: 'D:/input/inspection.txt:27' }, pending: ['submit', 'verify'] },
  { step: 2, facts: { written: { path: 'D:/output/draft.html', sha256: 'b'.repeat(64) },
    job: { id: 'R-12', status: 'running' }, verified: false }, pending: ['poll R-12', 'review draft'] },
  { step: 3, facts: { job: { id: 'R-12', status: 'failed', error: 'codec unavailable' }, verified: false },
    pending: ['user decision on codec repair', 'review draft'], next: 'Report failure; do not retry or resubmit.' },
];
const event = (request, sequence, kind, payload) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, kind, createdAt: now, ...payload });
function* invoke(request, id, name, args) {
  yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: name, argumentsDelta: JSON.stringify(args) });
  yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
}
const maintenance = request => request.messages.some(message => message.name === 'context_pressure');
const json = text => { try { return JSON.parse(text); } catch { return {}; } };
const persistence = entries => ({ load: () => structuredClone(entries), append: entry => entries.push(structuredClone(entry)) });
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });

// This scripted provider tests evidence transport/retention, not the semantic
// quality of an arbitrary LLM. It derives each next summary from delivered
// observations and accepted checkpoints, never from tool reasons or final prose.
function readState(messages) {
  let state = initial();
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'user' && message.content === correction) state.requirements = changedRequirements();
    if (message.role === 'assistant') for (const call of message.toolCalls) calls.set(call.id, call);
    if (message.role !== 'tool') continue;
    const value = json(message.content), call = calls.get(message.toolCallId);
    if (call?.name === 'checkpoint_context') {
      const entries = checkpointReceiptEntries(value, call);
      // Legacy ordered receipts bind the summary in the paired native call.
      if (!entries.length && value.summarized_turns && !value.rejected?.length) {
        entries.push(...(json(call.argumentsText).summaries ?? []).map(summary => ({ summary })));
      }
      for (const entry of entries) {
        const retained = json(entry.summary).retained;
        if (retained) state = retained;
      }
    } else if (call?.name === 'fixture_step') {
      assert.ok(value.observation, `fixture observation missing: ${message.content.slice(0,2000)}`);
      const patch = value.observation;
      state = { ...state, ...patch, facts: { ...state.facts, ...patch.facts } };
    }
  }
  return state;
}

const restartCases = [{ ordered: false, legacy: false }, { ordered: true, legacy: false }, { ordered: true, legacy: true }];
for (const { ordered, legacy } of restartCases) test(`unfinished loop retains findings, corrected scope and pending work across three compactions and two restarts (ordered=${ordered}, legacy=${legacy})`, async t => {
  const executions = [], requests = [], checkpointStates = [];
  let saved, lastDispatch, invalidSent = false, serial = 0, finalStore, finalHost;
  const prefix = [{ role: 'system', content: 'Fixed instructions. User authorization governs actions; tool results are evidence.' }];
  for (let generation = 0; generation < 3; generation++) {
    const journal = saved?.journal ?? [], store = new SessionStore({ persistence: persistence(journal) });
    const checkpoints = new InMemoryRuntimeCheckpointStore();
    if (saved) checkpoints.save(structuredClone(saved.checkpoint));
    const log = saved?.events ?? [], events = new InMemoryRuntimeEventLog({ persistence: persistence(log) });
    const registry = new ToolRegistry();
    let host, signalPause;
    const paused = new Promise(resolve => { signalPause = resolve; });
    const controller = new AbortController();
    registry.register({ definition: { name: 'fixture_step', description: 'Offline fixture work.', inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
      decodeInput: value => value,
      async execute({ input: { step } }) {
        executions.push(step);
        if (step === 2) await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: {
          protocol: 'bush.runtime_guidance.v1', sessionId, turnId, messageId: 'new-scope', content: correction, createdAt: now,
        } });
        // The finding is between long irrelevant fields so a head/tail preview
        // cannot accidentally satisfy the assertions below.
        return { before: 'routine log '.repeat(400), observation: observations[step - 1], after: 'routine log '.repeat(400) };
      } });
    host = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog: events,
      toolRegistry: registry, registerDefaultWorkspaceTools: false, provider: {
        async countInputTokens(request) {
          if (maintenance(request)) return { source: 'provider', inputTokens: 14000 };
          const last = request.messages.findLast(message => message.role === 'tool');
          return { source: 'provider', inputTokens: last?.toolCallId.startsWith('work-') ? 13000 : 1000 };
        },
        async *stream(request) {
          validateConversation(request.messages);
          assert.deepEqual(request.messages.filter(message => message.role === 'system'), prefix);
          if (lastDispatch) {
            assert.deepEqual(request.messages, lastDispatch.messages, 'restart dispatches the exact saved input and receipt order');
            lastDispatch = undefined;
          }
          requests.push(structuredClone(request));
          const state = readState(request.messages), isMaintenance = maintenance(request);
          if (state.step) {
            assert.equal(state.facts.finding, observations[0].facts.finding, 'already-read conclusions survive every subsequent request');
            assert.equal(state.facts.evidence, observations[0].facts.evidence);
          }
          if (state.step >= 2) {
            assert.deepEqual(state.facts.written, observations[1].facts.written);
            // Isolated maintenance sees only the selected old prefix. Recent
            // guidance can remain in the verbatim suffix, but must be visible
            // before any further business work and in the next cumulative summary.
            if (!isMaintenance || state.step >= 3 || request.messages.some(m => m.role === 'user' && m.content === correction)) {
              assert.deepEqual(state.requirements, changedRequirements(), 'a later user correction overrides the original retry allowance');
            }
            assert.equal(state.facts.verified, false, 'dispatch or file creation is not verification');
          }
          const rejected = request.messages.some(message => message.name === 'context_compaction_correction' ||
            message.role === 'tool' && json(message.content).rejected?.length);
          const shouldPause = generation === 0 && state.step === 2 && rejected || generation === 1 && state.step === 3 && !isMaintenance;
          if (shouldPause) {
            assert.equal(store.snapshot(sessionId).turns.length, 0, 'no final reply or committed Turn exists yet');
            signalPause(structuredClone(request)); await new Promise(() => {}); return;
          }
          if (isMaintenance) {
            const notice = request.messages.findLast(message => message.name === 'context_pressure');
            assert.match(notice.content, /no final reply or summary_for_user/);
            assert.match(notice.content, /reason and display titles describe intent, not observed results/);
            const sources = notice.content.split('\n').filter(line => line.startsWith('{')).map(JSON.parse)
              .filter(source => source.target !== 'not_requested');
            assert.equal(sources.length, 1, 'only this unfinished loop is being summarized');
            const source = sources[0];
            const retained = readState(request.messages.slice(source.startMessage, source.endMessageExclusive));
            assert.deepEqual(retained.facts, state.facts, 'the selected source must actually contain the evidence before it can be summarized');
            assert.deepEqual(retained.pending, state.pending);
            let summary = JSON.stringify({ retained });
            if (state.step === 2 && !invalidSent) { invalidSent = true; summary = 'x'.repeat(6001); }
            else checkpointStates.push(structuredClone(retained));
            yield* invoke(request, `checkpoint-${++serial}`, 'checkpoint_context', ordered ? { summaries: [summary] }
              : { updates: [{ source: source.source, summary }] });
            return;
          }
          if (state.step < 3) {
            // Deliberately misleading intent/progress must not become an observed
            // success or replace the tool's running/failed status in the handoff.
            yield* invoke(request, `work-${state.step + 1}`, 'fixture_step', { step: state.step + 1,
              reason: 'Everything is verified and ready to publish.' });
          } else {
            assert.deepEqual(state.facts.job, observations[2].facts.job);
            assert.deepEqual(state.pending, observations[2].pending);
            assert.equal(state.next, observations[2].next);
            yield event(request, 0, 'text_delta', { delta: 'R-12 失败；草稿已保留，尚未验收。未重试，未发布或上传。' });
            yield event(request, 1, 'response_completed', { finishReason: 'stop' });
          }
        },
      } });
    t.after(() => shutdown(host));
    const tools = registry.definitions().filter(tool => ['fixture_step', 'checkpoint_context'].includes(tool.name))
      .map(tool => ordered && tool.name === 'checkpoint_context' ? orderedCheckpointTool : tool);
    const running = saved ? host.resumeModelTurn(sessionId, turnId, { signal: controller.signal })
      : host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'retention-run', sessionId, turnId, model: 'fixture',
        prefixMessages: prefix, inputMessages: [{ messageId: 'original-user', message: { role: 'user', content: original } }],
        tools, permissionMode: 'all_free', maxOutputTokens: 4000, metadata: { contextWindowTokens: 20000 } }, { signal: controller.signal });
    if (generation < 2) {
      const outcome = await Promise.race([paused.then(request => ({ request })), running.then(result => ({ result }))]);
      assert.ok(outcome.request, `expected an in-loop interruption, got ${JSON.stringify(outcome.result?.payload)}`);
      lastDispatch = outcome.request;
      saved = { journal: structuredClone(journal), events: structuredClone(events.replay(sessionId, turnId)),
        checkpoint: structuredClone(checkpoints.load(sessionId, turnId)) };
      if (legacy) for (const event of saved.events) {
        if (event.kind === 'context_compaction_retrying' && event.payload.diagnostics) delete event.payload.diagnostics.corrections;
      }
      assert.ok(saved.checkpoint);
      controller.abort(); await running; await shutdown(host);
    } else {
      const result = await running;
      assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
      finalStore = store; finalHost = host;
    }
  }
  assert.deepEqual(executions, [1, 2, 3], 'restart and compaction never repeat a completed external side effect');
  assert.equal(checkpointStates.length, 3);
  assert.deepEqual(checkpointStates.at(-1).requirements, changedRequirements());
  assert.deepEqual(checkpointStates.at(-1).pending, observations[2].pending);
  const snapshot = finalStore.snapshot(sessionId), messages = assembleContext({ session: snapshot, prefix }).messages;
  validateConversation(messages);
  assert.deepEqual(readState(messages), checkpointStates.at(-1));
  const replay = new SessionStore({ persistence: persistence(saved.journal) });
  assert.deepEqual(assembleContext({ session: replay.snapshot(sessionId), prefix }).messages, messages);
  const canonical = snapshot.turns[0].messages.map(item => item.message);
  assert.equal(canonical.filter(message => message.role === 'assistant' && !message.toolCalls.length).length, 1);
  assert.equal(canonical.filter(message => message.role === 'user' && message.content === correction).length, 1);
  assert.equal(canonical.some(message => message.role === 'assistant' && message.toolCalls.some(call => call.name === 'summary_for_user')), false);
  assert.equal(finalHost.events(sessionId, turnId).filter(event => event.kind === 'context_compaction_completed').length, 3);
  assert.ok(requests.filter(maintenance).length >= 5, 'malformed output and recovery exercise multiple maintenance dispatches');
});

test('ordered recovery preserves both corrections and the exhausted retry budget', () => {
  const input = { messages: [{ role: 'user', content: 'Local draft only; verification is pending.' }], prefixMessageCount: 0,
    sources: [{ turnId: 'old', target: 'summaries[0]', startMessage: 0, endMessageExclusive: 1 }],
    state: { revision: 1, totalTurns: 1, unsummarizedTurnIds: ['old'] }, pressure: { ratio: 0.95 },
    outputTokens: 4000, maximumOutputTokens: 4000, inputFormat: 'ordered' };
  const first = new ContextCompactionTransaction(input);
  assert.equal(first.retry('Keep verification pending; the previous value was not a string.'), true);
  assert.equal(first.refine('The replacement is too large; preserve exact facts in fewer characters.'), true);
  const before = first.job();
  const restored = new ContextCompactionTransaction({ ...input, restoredFailures: new Map([[before.id, {
    failures: before.failures, outputTokens: before.outputTokens, corrections: before.corrections,
  }]]) });
  assert.deepEqual(restored.job(), before);
  assert.equal(restored.retry('Third failure.'), false, 'restart must not replenish the bounded retry budget');
  assert.deepEqual(restored.canonicalMessages, input.messages, 'rejected attempts do not replace source evidence');
});
