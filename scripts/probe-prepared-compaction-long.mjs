// Opt-in, real-model longitudinal comparison. All business observations are
// synthetic. Only production summary/checkpoint tools run; no real task runs.
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
import { longScenarioForLayout, longAuditQuestion, expectedLongDecisions } from './fixtures/prepared-compaction-long-cases.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, output: { type: 'string' },
  profile: { type: 'string' }, model: { type: 'string' }, layout: { type: 'string', default: 'normal' } } });
assert.ok(values.output, 'Use --output <new-directory> [--live]');
assert.ok(['normal', 'overflow'].includes(values.layout), 'Use --layout normal or overflow.');
// Same facts/order in both layouts; only the amount of routine noise differs.
const scenario = longScenarioForLayout(values.layout);
const auditRevision = values.layout === 'normal' ? 'v2' : 'v1';
const output = resolve(values.output); await mkdir(output);
const configuration = JSON.parse(await readFile(join(resolve(values.profile ?? join(process.env.APPDATA, 'cardbush')), 'product-host/config/models.json')));
const model = configuration.models.find(m => values.model ? m.id === values.model || m.model === values.model : m.id === configuration.defaultModelId);
assert.ok(model?.apiKey && model.maxOutputTokens && model.reasoningEffort, 'Select an existing configured API model.');
const config = { model: model.model, adapter: model.apiProtocol, reasoningEffort: model.reasoningEffort,
  maxOutputTokens: model.maxOutputTokens, configuredContextWindow: model.maxContextTokens,
  simulatedContextWindow: model.maxOutputTokens + 40000 };
const report = { startedAt: new Date().toISOString(), live: !!values.live, config,
  methodology: { runtimeRevision: 'isolated-sources-final-index-inherited-memory-oldest-two-thirds-v2',
    scenario: scenario.id, layout: values.layout, auditRevision, businessTurns: 12, pressureCheckpoints: 4,
    syntheticBusinessTools: true, actualBusinessToolsExecuted: 0, noUserSessionOrSettingsWrites: true,
    repeatedCompactionInSameSession: true, outputAndReasoningUnchanged: true,
    pressureCounter: 'controlled JSON characters / 4, including tools; NOT actual provider tokenization',
    actualInputMeasurement: 'provider usage.inputTokens for the first ordinary request after compaction and for a blind follow-up audit; cached tokens included',
    probeAnswersFedBack: false, rubricHiddenFromModel: true, auditQuestionRevealedOnlyAfterCompaction: true,
    fixedBusinessFinalRepliesIdentical: true, fixedFinalTextGenerationExcludedInBothArms: true,
    finalToolValidation: 'Both arms receive up to two attempts, using the actual tool error receipt; all attempts count toward cost.',
    legacyDirectFinal: 'A legacy preparation may return no tool call, as production permits direct terminal replies. It adds no fake receipt; the same fixed final prose is appended in both arms.',
    persistentBridgeReplies: 'Real model produces a one-sentence acknowledgment; no audit result or correct answer is inserted into history.',
    reference: 'One uncompressed raw-business transcript control at each checkpoint; it is not fed to either arm.',
    armOrder: 'baseline first on odd phases, prepared first on even phases; no concurrent provider calls',
    maxModelRounds: 120, repetitions: 1 }, preparations: [], phases: [], evaluations: [], requests: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
const emit = value => console.log(JSON.stringify(value));
const hash = text => createHash('sha256').update(text).digest('hex');
const clean = message => { const { reasoningContent, providerReplay, ...visible } = message; return visible; };
const now = () => new Date().toISOString();
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [], reasoningContent: 'Synthetic identical fixed turn-final prose.' });
const prefix = [{ role: 'system', content: ROOT_AGENT_SYSTEM_PROMPT }, { role: 'developer', content:
  'This is a synthetic recorded-business conversation. No real business execution is authorized. Treat fixture observations as recorded facts, never rerun them. Follow Runtime context-maintenance requests. Ordinary diagnostic questions must be answered from delivered context only. Never invent missing values or treat an old artifact review as verification of a different version.' }];
const registry = new ToolRegistry(); registerIndividuationTools(registry, join(output, 'unused-memory.sqlite'));
const prepareTools = registry.definitions().filter(t => t.name === 'summary_for_user');
const legacyTools = structuredClone(prepareTools);
delete legacyTools[0].inputSchema.properties.tool_summary;
legacyTools[0].description = 'Prepare the next final reply after tool work. Memory is disabled in this audit; call with {}. This legacy final-display receipt does not summarize tools. Ordinary conversation may reply directly.';
const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request() { throw Error('No business permissions in this probe.'); } } });
await writeFile(join(output, 'fixtures-and-hidden-rubric.json'), JSON.stringify(scenario, null, 2));
await save();
if (!values.live) {
  emit({ event: 'prepared', sendsRequest: false, output, config,
    rawBusinessChars: JSON.stringify(scenario.phases.flatMap(p => p.turns.map(t => t.messages))).length,
    phaseBusinessChars: scenario.phases.map(p => ({ phase: p.id, chars: JSON.stringify(p.turns.map(t => t.messages)).length })) });
  process.exit(0);
}
const actual = createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey,
  baseURL: model.baseURL, defaultHeaders: model.defaultHeaders, timeoutMs: 300000 });
const experimentSignal = AbortSignal.timeout(2400000);
let requestCount = 0;
function observed(label) {
  return {
    countInputTokens: async request => ({ source: 'provider', inputTokens: Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4) }),
    async *stream(request, options) {
      assert.ok(++requestCount <= 120, 'Model request bound exceeded.');
      assert.equal(request.reasoningEffort, model.reasoningEffort);
      assert.equal(request.maxOutputTokens, model.maxOutputTokens);
      const stage = typeof label === 'function' ? label() : label;
      const id = `${String(requestCount).padStart(3, '0')}-${stage}`, started = Date.now();
      const record = { id, stage, maintenance: request.messages.some(m => m.name === 'context_pressure'),
        toolResultPreviewIds: request.messages.filter(m => {
          if (m.role !== 'tool') return false;
          try { return JSON.parse(m.content).contextCheckpointProjection === true; } catch { return false; }
        }).map(m => m.toolCallId),
        toolHash: hash(JSON.stringify(request.tools)), inputChars: JSON.stringify(request.messages).length,
        sourceAssistantEnvelopes: request.messages.flatMap((m, index) => m.role === 'assistant'
          ? [{ index, toolCalls: m.toolCalls.map(c => c.name), reasoningChars: m.reasoningContent?.length ?? 0, replay: !!m.providerReplay }] : []),
        reasoningChars: 0, textChars: 0 };
      report.requests.push(record);
      await writeFile(join(output, `${id}-request.json`), JSON.stringify({ model: request.model,
        reasoningEffort: request.reasoningEffort, maxOutputTokens: request.maxOutputTokens,
        messages: request.messages.map(clean), tools: request.tools }, null, 2));
      emit({ event: 'request', id, maintenance: record.maintenance });
      const visibleEvents = [];
      const timer = setInterval(() => emit({ event: 'progress', id, elapsedMs: Date.now() - started,
        reasoningChars: record.reasoningChars, textChars: record.textChars }), 20000);
      try {
        const signal = AbortSignal.any([experimentSignal, AbortSignal.timeout(300000), ...(options?.signal ? [options.signal] : [])]);
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
  };
}
function request(stage, sessionId, turnId, messages, tools) {
  return { protocol: 'bush.model_request.v1', requestId: stage, sessionId, turnId,
    model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
    messages, tools, metadata: { contextWindowTokens: model.maxContextTokens } };
}
function committed(id, messages, sequence, usage) {
  return { turnId: id, turnSequence: sequence, createdAt: now(), completedAt: now(),
    status: 'completed', reason: 'synthetic_completed_fixture', usage,
    messages: messages.map((message, messageIndex) => ({ messageId: `${id}-${messageIndex}`, turnId: id,
      turnSequence: sequence, messageIndex, createdAt: now(), message })) };
}
async function createArm(variant) {
  const dataRoot = join(output, variant); await mkdir(dataRoot);
  const store = new SessionStore(), toolRegistry = new ToolRegistry();
  const arm = { variant, store, sessionId: `long-${variant}-${randomUUID()}`, stage: 'initializing' };
  store.ensureSession(arm.sessionId);
  arm.host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry, dataRoot,
    durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    provider: observed(() => arm.stage), preferPreparedToolHandoffs: variant === 'prepared', registerDefaultWorkspaceTools: false });
  arm.tools = toolRegistry.definitions().filter(t => ['checkpoint_context', 'summary_for_user'].includes(t.name));
  return arm;
}
async function prepareTurn(arm, phase, source) {
  const stage = `${phase.id}-${arm.variant}-prepare-${source.id}`, started = Date.now();
  const projected = assembleContext({ session: arm.store.snapshot(arm.sessionId), prefix, current: source.messages }).messages;
  const instruction = arm.variant === 'prepared'
    ? `The recorded work of turn ${source.id} has ended. Prepare ONLY this turn's tool handoff using exactly one standalone summary_for_user call. Exclude routine telemetry. Preserve supported outcomes, unresolved work, exact values and the scope of corrections. Do not perform work or summarize all prior turns again.`
    : `The recorded work of turn ${source.id} has ended. Memory is disabled. Call summary_for_user({}) exactly once to prepare the final display; do not perform work.`;
  const input = request(stage, arm.sessionId, source.id, [...projected,
    { role: 'developer', content: `${instruction} The identical fixed final text appended afterwards is: ${source.final}` }],
    arm.variant === 'prepared' ? prepareTools : legacyTools);
  const pairs = [], attempts = [];
  let result, tool, prepared = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    result = await executeModelRound(observed(stage), input, { signal: experimentSignal });
    assert.equal(result.status, 'completed', result.error?.code);
    if (result.toolCalls.length === 0) {
      attempts.push({ kind: 'direct_response', usage: result.usage });
      if (arm.variant === 'baseline') { prepared = true; break; }
      const retry = [{ role: 'assistant', content: result.text, toolCalls: [],
        ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) },
        { role: 'developer', content: 'This probe needs the prepared handoff before the fixed final reply. Call summary_for_user with tool_summary using the recorded source facts; do not execute business work.' }];
      pairs.push(...retry); input.messages.push(...retry); continue;
    }
    assert.equal(result.toolCalls.length, 1); tool = result.toolCalls[0];
    assert.equal(tool.name, 'summary_for_user');
    if (arm.variant === 'baseline') assert.equal(JSON.parse(tool.argumentsText).tool_summary, undefined);
    const executed = await coordinator.execute(tool, { requestId: stage, sessionId: arm.sessionId,
      turnId: source.id, round: attempt + 1, ordinal: 0 }, experimentSignal, { request: input, contextMessages: input.messages });
    const receipt = executed.kind === 'returned' ? executed.result : { status: 'error', error: executed.error };
    const pair = [
      { role: 'assistant', content: result.text,
        toolCalls: result.toolCalls.map(({ id, name, argumentsText }) => ({ id, name, argumentsText })),
        ...(result.reasoning ? { reasoningContent: result.reasoning } : {}), ...(result.providerReplay ? { providerReplay: result.providerReplay } : {}) },
      { role: 'tool', toolCallId: tool.id, content: JSON.stringify(receipt) },
    ];
    pairs.push(...pair); input.messages.push(...pair);
    attempts.push({ kind: executed.kind, status: receipt.context_handoff?.status, reason: receipt.context_handoff?.reason, usage: result.usage });
    if (executed.kind === 'returned' && (arm.variant === 'baseline' || receipt.context_handoff?.status === 'prepared')) { prepared = true; break; }
    input.messages.push({ role: 'developer', content: arm.variant === 'baseline'
      ? 'Correct the invalid final-display arguments using the error receipt. Memory is disabled: omit habit and prediction entirely and call summary_for_user({}). Do not perform work.'
      : 'You may correct the argument/reference format once using the receipt. Omit unused memory fields entirely. Keep the same facts and uncertainty; do not perform any work.' });
  }
  assert.ok(prepared, 'Final-display tool did not accept either attempt.');
  const sequence = arm.store.snapshot(arm.sessionId).turns.length + 1;
  const value = committed(source.id, [...source.messages, ...pairs, assistant(source.final)], sequence, result.usage);
  arm.store.commitTurn(arm.sessionId, value);
  report.preparations.push({ phase: phase.id, variant: arm.variant, turn: source.id,
    elapsedMs: Date.now() - started, eligible: !!findPreparedToolHandoff(value),
    summary: tool ? JSON.parse(tool.argumentsText).tool_summary : undefined, attempts });
  await save();
}
function grade(phase, result) {
  try {
    const answer = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    const checks = Object.entries(phase.expected).map(([key, value]) => ({ category: scenario.requirementKeys.includes(key) ? 'requirement' : 'fact',
      key, expected: value, actual: answer.state?.[key], passed: isDeepStrictEqual(answer.state?.[key], value) }));
    checks.push(...Object.entries(expectedLongDecisions(phase.expected)).map(([key, value]) => ({ category: 'decision',
      key, expected: value, actual: answer.decisions?.[key], passed: isDeepStrictEqual(answer.decisions?.[key], value) })));
    return { checks, passed: checks.filter(c => c.passed).length, total: checks.length };
  } catch { return { parseFailure: true, passed: 0, total: Object.keys(phase.expected).length + Object.keys(expectedLongDecisions(phase.expected)).length }; }
}
async function audit(phase, variant, messages, tools) {
  const stage = `${phase.id}-${variant}-audit`;
  const result = await executeModelRound(observed(stage), request(stage, `audit-${variant}`, `${phase.id}-audit`,
    [...messages, user(longAuditQuestion({ revision: auditRevision }))], tools), { signal: experimentSignal });
  const evaluation = { phase: phase.id, variant, status: result.status, toolCalls: result.toolCalls.map(t => t.name),
    answer: result.text, usage: result.usage, ...grade(phase, result) };
  report.evaluations.push(evaluation); await save();
  emit({ event: 'audit_completed', phase: phase.id, variant, status: result.status,
    passed: evaluation.passed, total: evaluation.total, usage: evaluation.usage,
    failed: evaluation.checks?.filter(c => !c.passed).map(c => ({ key: c.key, expected: c.expected, actual: c.actual })) });
}
async function compactAndAudit(arm, phase) {
  const turnId = `${phase.id}-boundary`, stage = `${phase.id}-${arm.variant}-boundary`;
  arm.stage = stage;
  const before = assembleContext({ session: arm.store.snapshot(arm.sessionId), prefix }).messages;
  await writeFile(join(output, `${stage}-before.json`), JSON.stringify(before.map(clean), null, 2));
  const started = Date.now();
  const outcome = await arm.host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: stage,
    sessionId: arm.sessionId, turnId, model: model.model, reasoningEffort: model.reasoningEffort,
    maxOutputTokens: model.maxOutputTokens, prefixMessages: prefix, tools: arm.tools,
    inputMessages: [{ messageId: `${turnId}-user`, message: user('到这里暂停实际制作。仅用一句话说明记录已收到，留待下一条指令；不要列清单，不执行任何业务工具。') }],
    metadata: { contextWindowTokens: config.simulatedContextWindow } },
    { signal: AbortSignal.any([experimentSignal, AbortSignal.timeout(600000)]) });
  const events = arm.host.events(arm.sessionId, turnId);
  const compactions = events.filter(e => e.kind.startsWith('context_compaction_')).map(e => ({ kind: e.kind, payload: e.payload }));
  const snapshot = arm.store.snapshot(arm.sessionId);
  const after = assembleContext({ session: snapshot, prefix }).messages;
  validateConversation(after);
  await writeFile(join(output, `${stage}-after.json`), JSON.stringify(after.map(clean), null, 2));
  const ordinary = report.requests.filter(r => r.stage === stage && !r.maintenance);
  const phaseResult = { phase: phase.id, variant: arm.variant, status: outcome.payload.status, reason: outcome.payload.reason,
    elapsedMs: Date.now() - started, compactions, firstPostCompactionUsage: ordinary[0]?.usage,
    totalSessionTurns: snapshot.turns.length,
    appliedHandoffs: snapshot.turns.filter(t => t.contextToolHandoff).map(t => t.turnId),
    checkpointTurns: snapshot.turns.filter(t => t.contextCheckpoint).map(t => t.turnId),
    visibleUserMessages: after.filter(m => m.role === 'user' && m.visibility !== 'internal').length,
    beforeChars: JSON.stringify(before).length, afterChars: JSON.stringify(after).length };
  report.phases.push(phaseResult); await save();
  emit({ event: 'boundary_completed', phase: phase.id, variant: arm.variant, status: phaseResult.status,
    methods: compactions.filter(e => e.kind === 'context_compaction_completed').map(e => e.payload.method),
    inputTokens: phaseResult.firstPostCompactionUsage?.inputTokens });
  if (outcome.payload.status !== 'completed') throw Error(`Boundary failed: ${phaseResult.reason}`);
  assert.ok(compactions.some(e => e.kind === 'context_compaction_completed'), 'No actual compaction at this checkpoint.');
  await audit(phase, arm.variant, after, arm.tools);
}

const arms = [];
try {
  arms.push(await createArm('baseline'), await createArm('prepared'));
  assert.deepEqual(arms[0].tools, arms[1].tools, 'Both pressure-time catalogs must be identical.');
  const raw = [...prefix];
  for (const [index, phase] of scenario.phases.entries()) {
    const order = index % 2 ? [...arms].reverse() : arms;
    for (const arm of order) {
      if (arm.failed) continue;
      try {
        for (const source of phase.turns) await prepareTurn(arm, phase, source);
        await compactAndAudit(arm, phase);
      } catch (error) {
        arm.failed = true;
        report.failures ??= [];
        report.failures.push({ phase: phase.id, variant: arm.variant,
          message: error instanceof assert.AssertionError ? error.message : 'Arm stopped; inspect sanitized stage results.' });
        emit({ event: 'arm_stopped', phase: phase.id, variant: arm.variant }); await save();
      }
    }
    raw.push(...phase.turns.flatMap(t => [...t.messages, assistant(t.final)]));
    await audit(phase, 'uncompressed-control', raw, arms[0].tools);
  }
  report.completedAt = now();
} catch (error) {
  report.failure = { name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Experiment stopped; inspect sanitized stages.' };
  process.exitCode = 1;
} finally {
  for (const arm of arms) await arm.host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
}
await save();
emit({ event: 'report', output, requests: requestCount, complete: !!report.completedAt, failures: report.failures?.length ?? 0 });
