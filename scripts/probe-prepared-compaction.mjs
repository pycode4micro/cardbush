// Explicitly opt-in live A/B using synthetic facts only. No real business tool,
// user session, installed Skill or settings file is changed. Model secrets and
// hidden reasoning/replay are never written to the report.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, ToolExecutionCoordinator, assembleContext } from '@cardbush/bush-runtime';
import { ROOT_AGENT_SYSTEM_PROMPT } from '@cardbush/bush-product-agent';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { executeModelRound } from '../packages/bush-runtime/dist/modelRound.js';
import { registerIndividuationTools } from '../packages/bush-runtime/dist/individuationTools.js';
import { findPreparedToolHandoff } from '../packages/bush-runtime/dist/preparedToolHandoff.js';
import { validateConversation } from '../packages/bush-runtime/dist/sessionStore.js';
import { preparedCompactionCases } from './fixtures/prepared-compaction-cases.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, output: { type: 'string' },
  profile: { type: 'string' }, model: { type: 'string' }, cases: { type: 'string', default: 'video,deployment' } } });
assert.ok(values.output, 'Use --output <new-directory> [--live] [--cases video,deployment]');
const output = resolve(values.output); await mkdir(output); // Never overwrite a run.
const config = JSON.parse(await readFile(join(resolve(values.profile ?? join(process.env.APPDATA, 'cardbush')), 'product-host/config/models.json')));
const model = config.models.find(m => values.model ? m.id === values.model || m.model === values.model : m.id === config.defaultModelId);
assert.ok(model?.apiKey && model.maxOutputTokens && model.reasoningEffort, 'Select an existing configured API model.');
const cases = values.cases.split(',').map(id => { const item = preparedCompactionCases.find(c => c.id === id); assert.ok(item); return item; });
const publicConfig = { model: model.model, adapter: model.apiProtocol, reasoningEffort: model.reasoningEffort,
  maxOutputTokens: model.maxOutputTokens, configuredContextWindow: model.maxContextTokens, simulatedContextWindow: model.maxOutputTokens + 40000 };
const report = { startedAt: new Date().toISOString(), live: !!values.live, config: publicConfig,
  methodology: { syntheticFacts: true, fixedFinalRepliesIdenticalInBothArms: true, rubricHiddenFromModel: true,
    sameReasoningAndOutput: true, pressureCounter: 'controlled JSON characters / 4 including tool definitions; not provider tokenizer',
    baseline: 'Legacy empty final-display receipt; on-demand production checkpoint transaction.',
    prepared: 'Real model writes each tool summary through summary_for_user; production runtime reuses it only at pressure.',
    preparationOverhead: 'Both arms make real final-display calls. Baseline uses a fixed legacy schema without tool_summary. Final reply text is fixed and identical, so final text generation is excluded in both arms.',
    businessToolsExecuted: 0, userSessionsModified: false, repetitions: 1 }, preparation: [], baselinePreparation: [], runs: [], requests: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
const emit = data => console.log(JSON.stringify(data));
const hash = text => createHash('sha256').update(text).digest('hex');
const clean = message => { const { reasoningContent, providerReplay, ...rest } = message; return rest; };
const now = () => new Date().toISOString();
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, reasoningContent: 'Synthetic fixed final response for the comparison.', toolCalls: [] });
const prefix = [{ role: 'system', content: ROOT_AGENT_SYSTEM_PROMPT }, { role: 'developer', content:
  'This is a synthetic offline-business transcript audit. Recorded business tools are fixtures and must never be executed. No external action is authorized. Respect context-maintenance requests from Runtime; otherwise answer only the latest user audit question.' }];
const registry = new ToolRegistry(); registerIndividuationTools(registry, join(output, 'unused-memory.sqlite'));
const prepareTools = registry.definitions().filter(t => t.name === 'summary_for_user');
const legacyTools = structuredClone(prepareTools);
delete legacyTools[0].inputSchema.properties.tool_summary;
legacyTools[0].description = 'Prepare the next final user-facing reply after tool work. Optional habit and prediction are separate memory categories, saved only when enabled. Memory is disabled in this audit; call with {}. Ordinary conversation without Tool work may reply directly. Success marks the next response final for display but does not end the loop.';
const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request() { throw Error('No permissions in this audit.'); } } });
await writeFile(join(output, 'fixtures.json'), JSON.stringify(cases, null, 2));
await save();
if (!values.live) { emit({ event: 'prepared', sendsRequest: false, output, config: publicConfig }); process.exit(0); }
const actual = createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey,
  baseURL: model.baseURL, defaultHeaders: model.defaultHeaders, timeoutMs: 300000 });
let requestCount = 0;
const observed = stage => ({
  countInputTokens: async request => ({ source: 'provider', inputTokens: Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4) }),
  async *stream(request, options) {
    assert.ok(++requestCount <= 30, 'Live request bound exceeded.');
    assert.equal(request.reasoningEffort, model.reasoningEffort); assert.equal(request.maxOutputTokens, model.maxOutputTokens);
    const id = `${String(requestCount).padStart(2, '0')}-${stage}`, started = Date.now();
    const record = { id, stage, maintenance: request.messages.some(m => m.name === 'context_pressure'),
      toolHash: hash(JSON.stringify(request.tools)), inputChars: JSON.stringify(request.messages).length, reasoningChars: 0, textChars: 0 };
    report.requests.push(record);
    await writeFile(join(output, `${id}-request.json`), JSON.stringify({ model: request.model, reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens, messages: request.messages.map(clean), tools: request.tools }, null, 2));
    emit({ event: 'request', id, maintenance: record.maintenance });
    const visibleEvents = [];
    const timer = setInterval(() => emit({ event: 'progress', id, elapsedMs: Date.now() - started,
      reasoningChars: record.reasoningChars, textChars: record.textChars }), 20000);
    try {
      const signal = options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
      for await (const event of actual.stream(request, { ...options, signal, onCompatibilityDiagnostic: () => {} })) {
        if (event.kind === 'reasoning_delta') record.reasoningChars += event.delta.length;
        else if (event.kind === 'text_delta') { record.textChars += event.delta.length; visibleEvents.push({ kind: event.kind, delta: event.delta }); }
        else if (event.kind === 'tool_call_delta') visibleEvents.push({ kind: event.kind, index: event.index, nameDelta: event.nameDelta, argumentsDelta: event.argumentsDelta });
        else if (event.kind === 'usage') record.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens };
        else if (event.kind === 'response_failed') record.failureCode = event.code;
        yield event;
      }
    } finally {
      clearInterval(timer); record.elapsedMs = Date.now() - started;
      await writeFile(join(output, `${id}-response.json`), JSON.stringify({ ...record, visibleEvents }, null, 2));
      await save(); emit({ event: 'finished', ...record });
    }
  },
});
function committed(id, messages, sequence) { return { turnId: id, turnSequence: sequence, createdAt: now(), completedAt: now(),
  status: 'completed', reason: 'synthetic_completed_fixture', usage: {}, messages: messages.map((message, index) => ({
    messageId: `${id}-${index}`, turnId: id, turnSequence: sequence, messageIndex: index, createdAt: now(), message })) }; }
async function prepare(item) {
  const prepared = [], sessionId = `probe-prep-${randomUUID()}`;
  for (const [index, source] of item.turns.entries()) {
    const started = Date.now(), stage = `${item.id}-prepare-${source.id}`;
    const request = { protocol: 'bush.model_request.v1', requestId: stage, sessionId, turnId: source.id,
      model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
      messages: [...prefix, ...prepared.flatMap(t => t.messages.map(f => f.message)), ...source.messages,
        { role: 'developer', content: `Current turn is ${source.id}. Its recorded work has ended. Prepare only this turn's tool handoff now via exactly one standalone summary_for_user call. Do not execute any other tool. The fixed final reply, appended after your receipt for this experiment, is: ${source.final}` }],
      tools: prepareTools, metadata: { contextWindowTokens: model.maxContextTokens } };
    const preparationMessages = [], attempts = [];
    let tool, callMessage;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executeModelRound(observed(stage), request);
      assert.equal(result.status, 'completed', result.error?.code);
      assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0].name, 'summary_for_user');
      tool = result.toolCalls[0];
      const executed = await coordinator.execute(tool, { requestId: stage, sessionId, turnId: source.id, round: attempt + 1, ordinal: 0 }, undefined,
        { request, contextMessages: request.messages });
      assert.equal(executed.kind, 'returned');
      callMessage = { role: 'assistant', content: result.text, toolCalls: result.toolCalls.map(({ id, name, argumentsText }) => ({ id, name, argumentsText })),
        ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) };
      const pair = [callMessage, { role: 'tool', toolCallId: tool.id, content: JSON.stringify(executed.result) }];
      preparationMessages.push(...pair); request.messages.push(...pair);
      attempts.push({ usage: result.usage, status: executed.result.context_handoff?.status, reason: executed.result.context_handoff?.reason });
      if (executed.result.context_handoff?.status === 'prepared') break;
      request.messages.push({ role: 'developer', content: 'Use the receipt to correct only the reference format/observed ranges once. Preserve factual uncertainty and existing requirements. Call summary_for_user again; do not perform work.' });
    }
    const messages = [...source.messages, ...preparationMessages, assistant(source.final)];
    const value = committed(source.id, messages, index + 1);
    prepared.push(value);
    report.preparation.push({ case: item.id, turn: source.id, elapsedMs: Date.now() - started,
      eligible: !!findPreparedToolHandoff(value), summary: JSON.parse(tool.argumentsText).tool_summary, attempts });
    await save();
  }
  return { prepared };
}
async function prepareBaseline(item) {
  const history = [], sessionId = `probe-legacy-${randomUUID()}`;
  for (const [index, source] of item.turns.entries()) {
    const stage = `${item.id}-legacy-prepare-${source.id}`, start = Date.now();
    const request = { protocol: 'bush.model_request.v1', requestId: stage, sessionId, turnId: source.id,
      model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
      messages: [...prefix, ...history.flatMap(t => t.messages.map(f => f.message)), ...source.messages,
        { role: 'developer', content: `Current turn is ${source.id}. Its recorded work has ended. Memory is disabled. Prepare the final display now via exactly one standalone summary_for_user({}) call. Do not execute any other tool. The fixed final reply is: ${source.final}` }],
      tools: legacyTools, metadata: { contextWindowTokens: model.maxContextTokens } };
    const result = await executeModelRound(observed(stage), request);
    assert.equal(result.status, 'completed', result.error?.code);
    assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0].name, 'summary_for_user');
    const tool = result.toolCalls[0]; assert.deepEqual(JSON.parse(tool.argumentsText), {});
    const executed = await coordinator.execute(tool, { requestId: stage, sessionId, turnId: source.id, round: 1, ordinal: 0 }, undefined,
      { request, contextMessages: request.messages });
    assert.equal(executed.kind, 'returned');
    history.push(committed(source.id, [...source.messages,
      { role: 'assistant', content: result.text, toolCalls: result.toolCalls.map(({ id, name, argumentsText }) => ({ id, name, argumentsText })),
        ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) },
      { role: 'tool', toolCallId: tool.id, content: JSON.stringify(executed.result) }, assistant(source.final)], index + 1));
    report.baselinePreparation.push({ case: item.id, turn: source.id, elapsedMs: Date.now() - start, usage: result.usage });
    await save();
  }
  return history;
}
async function run(item, variant, turns, stale = false) {
  const sessionId = `probe-${randomUUID()}`, turnId = 'audit', stage = `${item.id}-${stale ? 'stale-' : ''}${variant}`;
  const store = new SessionStore();
  for (const original of turns) { const value = structuredClone(original);
    if (stale && value.turnId === turns.at(-1).turnId) value.messages.push(...[user(item.staleCorrection), assistant('补充已记录。')].map((message, i) => ({
      messageId: `correction-${i}`, turnId: value.turnId, turnSequence: value.turnSequence, messageIndex: value.messages.length + i, createdAt: now(), message })));
    store.commitTurn(sessionId, value);
  }
  const toolRegistry = new ToolRegistry(), host = new InMemoryRuntimeHost({ sessionStore: store,
    toolRegistry, provider: observed(stage), preferPreparedToolHandoffs: variant === 'prepared', registerDefaultWorkspaceTools: false });
  const tools = toolRegistry.definitions().filter(t => ['checkpoint_context', 'summary_for_user'].includes(t.name));
  const start = Date.now(), run = { case: item.id, variant, stale, stage }; report.runs.push(run);
  try {
    const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: stage, sessionId, turnId,
      model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
      prefixMessages: prefix, tools, inputMessages: [{ messageId: 'audit-user', message: user(item.question) }],
      metadata: { contextWindowTokens: publicConfig.simulatedContextWindow } }, { signal: AbortSignal.timeout(600000) });
    run.elapsedMs = Date.now() - start; run.status = result.payload.status; run.reason = result.payload.reason;
    const events = host.events(sessionId, turnId);
    run.compactions = events.filter(e => e.kind.startsWith('context_compaction_')).map(e => ({ kind: e.kind, payload: e.payload }));
    run.pressureWaitMs = events.filter(e => e.kind === 'context_compaction_completed').reduce((sum, complete) => {
      const begin = events.find(e => e.kind === 'context_compaction_started' && e.payload.compactionId === complete.payload.compactionId);
      return sum + (begin ? Date.parse(complete.createdAt) - Date.parse(begin.createdAt) : 0);
    }, 0);
    const snapshot = store.snapshot(sessionId);
    run.answer = snapshot.turns.at(-1).messages.filter(f => f.message.role === 'assistant' && !f.message.toolCalls.length).map(f => f.message.content).join('\n');
    try { const answer = JSON.parse(run.answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      // A new draft need not inherit old cue settings. Only the explicit latest
      // correction is graded here; the other fields remain visible for review.
      const expected = stale ? item.staleExpected : item.expected;
      run.checks = Object.entries(expected).map(([key, value]) => ({ key, passed: isDeepStrictEqual(answer[key], value), expected: value, actual: answer[key] }));
      run.passed = run.checks.filter(c => c.passed).length; run.total = run.checks.length;
    } catch { run.parseFailure = true; }
    const projected = assembleContext({ session: snapshot, prefix }).messages;
    validateConversation(projected);
    await writeFile(join(output, `${stage}-projected.json`), JSON.stringify(projected.map(clean), null, 2));
    run.appliedHandoffs = snapshot.turns.filter(t => t.contextToolHandoff).map(t => t.turnId);
    run.maintenanceRequests = report.requests.filter(r => r.stage === stage && r.maintenance).length;
    emit({ event: 'run_completed', stage, status: run.status, pressureWaitMs: run.pressureWaitMs, elapsedMs: run.elapsedMs,
      passed: run.passed, total: run.total, methods: run.compactions.filter(e => e.kind === 'context_compaction_completed').map(e => e.payload.method) });
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await save(); }
}
try {
  for (const item of cases) {
    const legacy = await prepareBaseline(item);
    const histories = await prepare(item);
    await run(item, 'baseline', legacy);
    await run(item, 'prepared', histories.prepared);
    if (item.staleCorrection) await run(item, 'prepared', histories.prepared, true);
  }
  report.completedAt = now();
} catch (error) { report.failure = { name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Probe interrupted; inspect sanitized request results.' }; process.exitCode = 1; }
await save(); emit({ event: 'report', output, requests: requestCount, complete: !!report.completedAt });
