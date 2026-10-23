// Opt-in stress test of the shared all-summary fallback. No business tools run.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext } from '@cardbush/bush-runtime';
import { ROOT_AGENT_SYSTEM_PROMPT } from '@cardbush/bush-product-agent';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { executeModelRound } from '../packages/bush-runtime/dist/modelRound.js';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { readConversationHistory } from '../packages/bush-runtime/dist/conversationHistory.js';
import { stripToolDisplayTitle } from '../packages/bush-runtime/dist/toolDisplay.js';
import { longScenarioForLayout, longAuditQuestion, expectedLongDecisions } from './fixtures/prepared-compaction-long-cases.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, output: { type: 'string' }, summaries: { type: 'string' }, 'shrink-window': { type: 'boolean' } } });
assert.ok(values.output && values.summaries, 'Use --output <new-directory> --summaries <completed-long-report.json> [--live]');
const output = resolve(values.output); await mkdir(output);
const sourceReport = JSON.parse(await readFile(resolve(values.summaries), 'utf8'));
assert.ok(sourceReport.completedAt && !sourceReport.failures?.length);
const configuration = JSON.parse(await readFile(join(process.env.APPDATA, 'cardbush/product-host/config/models.json'), 'utf8'));
const model = configuration.models.find(m => m.id === configuration.defaultModelId);
assert.equal(model.model, sourceReport.config.model); assert.equal(model.reasoningEffort, sourceReport.config.reasoningEffort);
assert.equal(model.maxOutputTokens, sourceReport.config.maxOutputTokens);
const scenario = longScenarioForLayout('normal'), finalPhase = scenario.phases.at(-1);
const report = { startedAt: new Date().toISOString(), live: !!values.live, config: sourceReport.config,
  methodology: { test: 'shared oldest-two-thirds summary fallback and original-journal readback',
    initialSummaries: '12 model-generated prepared handoffs from the supplied report, plus each original user correction and fixed final reply',
    simulatedPressure: values['shrink-window']
      ? 'At each cycle usable input = 1.8 * the provider local wire-input estimate; the window narrows to exercise three merges.'
      : 'Fixed window: usable input = 1.8 * the initial provider local wire-input estimate. Before subsequent merges append synthetic no-change status summaries until the initial pressure level is reached again. These add no requirements, answers or new business facts.',
    inputEstimator: 'Provider local wire projection, excluding duplicate internal providerReplay envelopes. Not billed tokenization or a production window change.',
    originalOnlyCanary: 'A synthetic checksum is in t01 journal only, deliberately absent from initial summaries. Recovery audit must read it.',
    unchangedModelReasoningAndOutput: true, noBusinessTools: true, cycles: 3, auditAnswersFedBack: false }, requests: [], cycles: [], audits: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
const emit = data => console.log(JSON.stringify(data));
const now = () => new Date().toISOString(), user = content => ({ role: 'user', content });
const prefix = [{ role: 'system', content: ROOT_AGENT_SYSTEM_PROMPT }, { role: 'developer', content:
  'Synthetic recorded conversation. Do not execute business tasks. Follow Runtime maintenance only. Audit answers must use supplied evidence; do not invent missing values.' }];
const store = new SessionStore(), sessionId = 'merged-fixture', registry = new ToolRegistry();
for (const source of scenario.phases.flatMap(p => p.turns)) {
  const sequence = (store.snapshot(sessionId)?.turns.length ?? 0) + 1;
  const messages = structuredClone(source.messages);
  if (source.id === 't01') messages.splice(1, 0,
    { role: 'assistant', content: '', reasoningContent: 'Synthetic recorded verification.', toolCalls: [{ id: 'archive-proof', name: 'fixture_verification', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'archive-proof', content: '{"archive_id":"archive-check-742","checksum":"XQ-4197"}' });
  messages.push({ role: 'assistant', content: source.final, toolCalls: [] });
  store.commitTurn(sessionId, { turnId: source.id, turnSequence: sequence, createdAt: now(), completedAt: now(), status: 'completed', reason: 'fixture', usage: {},
    messages: messages.map((message, i) => ({ messageId: `${source.id}-${i}`, turnId: source.id, turnSequence: sequence, messageIndex: i, createdAt: now(), message })) });
}
store.summarizeTurns({ sessionId, expectedRevision: store.snapshot(sessionId).revision, summaries: scenario.phases.flatMap(p => p.turns).map(source => {
  const prepared = sourceReport.preparations.find(p => p.variant === 'prepared' && p.turn === source.id);
  assert.ok(prepared?.summary);
  return { turnId: source.id, summary: [...source.messages.filter(m => m.role === 'user').map(m => m.content), prepared.summary, source.final].join('\n') };
}) });
const originals = structuredClone(store.snapshot(sessionId).turns);
await save();
if (!values.live) { emit({ event: 'prepared', sendsRequest: false, output }); process.exit(0); }
const actual = createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey, baseURL: model.baseURL, defaultHeaders: model.defaultHeaders, timeoutMs: 300000 });
const signal = AbortSignal.timeout(1200000); let stage = 'initial', serial = 0;
const measure = input => actual.estimateInputTokens(modelRequestSchema.parse(input));
const provider = { countInputTokens: async input => ({ source: 'provider', inputTokens: await measure(input) }),
  async *stream(input, options) {
    assert.ok(++serial <= 40); assert.equal(input.reasoningEffort, model.reasoningEffort); assert.equal(input.maxOutputTokens, model.maxOutputTokens);
    const entry = { id: serial, stage, maintenance: input.messages.some(m => m.name === 'context_pressure'), started: Date.now() };
    report.requests.push(entry); emit({ event: 'request', id: serial, stage, maintenance: entry.maintenance });
    await writeFile(join(output, `${serial}-request.json`), JSON.stringify({ ...input, messages: input.messages.map(({ reasoningContent, providerReplay, ...m }) => m) }, null, 2));
    try { for await (const event of actual.stream(input, { ...options, signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]), onCompatibilityDiagnostic() {} })) {
      if (event.kind === 'usage') entry.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens };
      yield event;
    } } finally { entry.elapsedMs = Date.now() - entry.started; await save(); emit({ event: 'finished', ...entry }); }
  } };
const host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, dataRoot: join(output, 'runtime'),
  durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
  registerDefaultWorkspaceTools: false, provider, preferPreparedToolHandoffs: false });
const tools = registry.definitions().filter(t => ['checkpoint_context', 'summary_for_user'].includes(t.name));
const request = (messages, toolList = tools) => ({ protocol: 'bush.model_request.v1', requestId: stage, sessionId, turnId: stage,
  model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens, messages, tools: toolList,
  metadata: { contextWindowTokens: model.maxContextTokens } });
async function audit(label) {
  stage = label;
  const messages = assembleContext({ session: store.snapshot(sessionId), prefix }).messages;
  const result = await executeModelRound(provider, request([...messages, user(longAuditQuestion({ revision: 'v2' }))]), { signal });
  assert.equal(result.status, 'completed');
  const answer = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  const checks = [...Object.entries(finalPhase.expected).map(([key, expected]) => ({ key, expected, actual: answer.state?.[key] })),
    ...Object.entries(expectedLongDecisions(finalPhase.expected)).map(([key, expected]) => ({ key, expected, actual: answer.decisions?.[key] }))]
    .map(check => ({ ...check, passed: isDeepStrictEqual(check.actual, check.expected) }));
  const entry = { stage, usage: result.usage, answer: result.text, passed: checks.filter(c => c.passed).length, total: checks.length, checks };
  report.audits.push(entry); await save(); emit({ event: 'audit', stage, passed: entry.passed, total: entry.total });
}
try {
  await audit('initial-summary-control');
  const initialEstimate = await measure(request(assembleContext({ session: store.snapshot(sessionId), prefix }).messages));
  for (let cycle = 1; cycle <= 3; cycle++) {
    stage = `merge-${cycle}`;
    if (!values['shrink-window'] && cycle > 1) {
      for (let item = 0; await measure(request(assembleContext({ session: store.snapshot(sessionId), prefix }).messages)) < initialEstimate; item++) {
        assert.ok(item < 30, 'Growth fixture exceeded its bounded record count.');
        const id = `status-${cycle}-${item}`, sequence = store.snapshot(sessionId).turns.length + 1;
        store.commitTurn(sessionId, { turnId: id, turnSequence: sequence, createdAt: now(), completedAt: now(), status: 'completed', reason: 'fixture', usage: {},
          messages: [{ messageId: `${id}-user`, turnId: id, turnSequence: sequence, messageIndex: 0, createdAt: now(), message: user('Record status only. No new work.') },
            { messageId: `${id}-reply`, turnId: id, turnSequence: sequence, messageIndex: 1, createdAt: now(), message: { role: 'assistant', content: 'No new business facts.', toolCalls: [] } }] });
        store.summarizeTurns({ sessionId, expectedRevision: store.snapshot(sessionId).revision, summaries: [{ turnId: id,
          summary: `Status receipt ${id}. No business action occurred.\n` + Array.from({ length: 60 }, (_, i) => `heartbeat ${i}: no new results, approvals, reviews or user changes.`).join('\n') }] });
      }
    }
    const messages = assembleContext({ session: store.snapshot(sessionId), prefix }).messages;
    const inputTokens = await measure(request(messages)), usable = Math.ceil((values['shrink-window'] ? inputTokens : initialEstimate) * 1.8);
    const outcome = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: stage, sessionId, turnId: stage,
      model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens, prefixMessages: prefix, tools,
      inputMessages: [{ messageId: `${stage}-user`, message: user('记录收到后暂停，等待下一条指令。仅回复一句确认，不执行工作。') }],
      metadata: { contextWindowTokens: model.maxOutputTokens + usable } }, { signal });
    const events = host.events(sessionId, stage).filter(e => e.kind.startsWith('context_compaction_'));
    const after = assembleContext({ session: store.snapshot(sessionId), prefix }).messages;
    report.cycles.push({ cycle, simulatedUsableInput: usable, beforeEstimate: inputTokens, afterEstimate: await measure(request(after)),
      status: outcome.payload.status, reason: outcome.payload.reason, events: events.map(e => ({ kind: e.kind, payload: e.payload })) });
    await writeFile(join(output, `${stage}-after.json`), JSON.stringify(after.map(({ reasoningContent, providerReplay, ...m }) => m), null, 2));
    await save();
    if (outcome.payload.status !== 'completed') { report.pressureFailure = outcome.payload; break; }
    assert.ok(events.some(e => e.kind === 'context_compaction_started' && e.payload.summaryGroupTurnIds?.length), 'Must exercise all-summary grouping');
    assert.deepEqual(store.snapshot(sessionId).turns.slice(0, 12), originals);
    await audit(`after-${cycle}`);
  }
  stage = 'history-readback';
  const reader = registry.resolve('read_conversation_history');
  const input = request([...assembleContext({ session: store.snapshot(sessionId), prefix }).messages,
    user('请查回 t01 原始记录中 archive-check-742 的 checksum。摘要没有留下这个值，请使用历史回看标记读取记录，不能猜。仅回答 JSON {"checksum":"..."}。')], [reader.definition]);
  const reads = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await executeModelRound(provider, input, { signal });
    assert.equal(result.status, 'completed');
    (report.readbackAttempts ??= []).push({ attempt, text: result.text, toolCalls: result.toolCalls });
    await save();
    if (!result.toolCalls.length) { report.readback = { answer: result.text, reads, passed: JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()).checksum === 'XQ-4197' }; break; }
    input.messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls,
      ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) });
    for (const call of result.toolCalls) {
      assert.equal(call.name, 'read_conversation_history');
      const args = reader.decodeInput(stripToolDisplayTitle(JSON.parse(call.argumentsText), reader.definition));
      const value = readConversationHistory(store.snapshot(sessionId), args);
      reads.push({ locator: args.locator, offset: args.offset, returnedChars: value.text.length });
      input.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(value) });
    }
  }
  assert.ok(report.readback?.reads.length); assert.equal(report.readback.passed, true);
  report.finishedAt = now();
  if (report.pressureFailure) process.exitCode = 1; else report.completedAt = report.finishedAt;
} catch (error) { report.failure = { name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Probe stopped; inspect sanitized report.' }; process.exitCode = 1; }
finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await save(); }
emit({ event: 'report', output, complete: !!report.completedAt, requests: serial, readback: report.readback });
