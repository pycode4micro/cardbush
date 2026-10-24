// Opt-in real provider replay. Business history is a fixed synthetic fixture;
// no production conversation, business Tool, memory or model setting is changed.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext } from '@cardbush/bush-runtime';
import { ROOT_AGENT_SYSTEM_PROMPT } from '@cardbush/bush-product-agent';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { validateConversation } from '../packages/bush-runtime/dist/sessionStore.js';
import { preparedCompactionCases } from './fixtures/prepared-compaction-cases.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'loop-only': { type: 'boolean' }, output: { type: 'string' },
  profile: { type: 'string' }, model: { type: 'string' }, cases: { type: 'string', default: 'video,deployment' } } });
assert.ok(values.output, 'Use --output <new-directory> [--live]');
const output = resolve(values.output); await mkdir(output); // Never overwrite a run.
const config = JSON.parse(await readFile(join(resolve(values.profile ?? join(process.env.APPDATA, 'cardbush')), 'product-host/config/models.json')));
const model = config.models.find(m => values.model ? m.id === values.model || m.model === values.model : m.id === config.defaultModelId);
assert.ok(model?.apiKey && model.maxOutputTokens, 'Select an existing configured API model.');
const cases = values.cases.split(',').map(id => { const item = preparedCompactionCases.find(c => c.id === id); assert.ok(item); return item; });
const now = () => new Date().toISOString();
const publicConfig = { model: model.model, adapter: model.apiProtocol, reasoningEffort: model.reasoningEffort ?? 'provider default',
  maxOutputTokens: model.maxOutputTokens, configuredContextWindow: model.maxContextTokens, simulatedContextWindow: model.maxOutputTokens + 40000 };
const report = { startedAt: now(), live: !!values.live, config: publicConfig, methodology: {
  syntheticFacts: true, fixedFinalRepliesIdenticalInAllArms: true, rubricHiddenFromModel: true,
  sameModelSettingsAndTools: true, pressureCounter: 'Controlled JSON characters / 4, including tool definitions; not provider tokenization.',
  actualTokenMetrics: 'Provider usage on each real call; raw control and compacted continuation use identical questions and tools.',
  arms: ['raw: same history without pressure', 'checkpoint: production on-demand model compaction', 'recorded: default deterministic tool record projection'],
  preparationCalls: 0, businessToolsExecuted: 0, userSessionsModified: false, repetitions: 1,
}, runs: [], requests: [] };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
const emit = value => console.log(JSON.stringify(value));
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const prefix = [{ role: 'system', content: ROOT_AGENT_SYSTEM_PROMPT }, { role: 'developer', content:
  'This is a synthetic transcript audit. Recorded business tools are fixtures and must never be executed. No external action is authorized. Respect context-maintenance requests from Runtime; otherwise answer only the latest user audit question.' }];
await writeFile(join(output, 'fixtures.json'), JSON.stringify(cases, null, 2)); await save();
if (!values.live) { emit({ event: 'prepared', sendsRequest: false, output, config: publicConfig }); process.exit(0); }
const actual = createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey,
  baseURL: model.baseURL, defaultHeaders: model.defaultHeaders, timeoutMs: 180000 });
let requestCount = 0;
const observed = stage => ({
  countInputTokens: async request => ({ source: 'provider', inputTokens: Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4) }),
  async *stream(request, options) {
    assert.ok(++requestCount <= 30, 'Live request bound exceeded.');
    assert.equal(request.reasoningEffort, model.reasoningEffort); assert.equal(request.maxOutputTokens, model.maxOutputTokens);
    const id = `${String(requestCount).padStart(2, '0')}-${stage}`, started = Date.now();
    const record = { id, stage, maintenance: request.messages.some(m => m.name === 'context_pressure'),
      toolHash: createHash('sha256').update(JSON.stringify(request.tools)).digest('hex'), inputChars: JSON.stringify(request.messages).length,
      reasoningChars: 0, textChars: 0 };
    report.requests.push(record);
    const visible = request.messages.map(({ reasoningContent, providerReplay, ...rest }) => rest);
    await writeFile(join(output, `${id}-request.json`), JSON.stringify({ model: request.model, reasoningEffort: request.reasoningEffort,
      maxOutputTokens: request.maxOutputTokens, messages: visible, tools: request.tools }, null, 2));
    emit({ event: 'request', id, maintenance: record.maintenance });
    const visibleEvents = [], timer = setInterval(() => emit({ event: 'progress', id, elapsedMs: Date.now() - started }), 20000);
    try {
      const timeout = AbortSignal.timeout(180000), signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
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
function committed(source, sequence, stale, opaque) {
  const messages = structuredClone(source.messages);
  for (const message of messages) {
    if (message.role === 'assistant') {
      delete message.reasoningContent;
      for (const call of message.toolCalls) call.argumentsText = JSON.stringify({ ...JSON.parse(call.argumentsText), reason: `Record ${call.id}` });
    }
    if (opaque && message.role === 'tool' && message.content.includes('routine_log')) message.content = 'Unstructured observation (keep uncertainty):\n' + message.content;
  }
  messages.push(assistant(source.final));
  if (stale) messages.push(user(stale), assistant('补充已记录。'));
  return { turnId: source.id, turnSequence: sequence, createdAt: now(), completedAt: now(), status: 'completed', reason: 'synthetic_fixture', usage: {},
    messages: messages.map((message, index) => ({ messageId: `${source.id}-${index}`, turnId: source.id, turnSequence: sequence, messageIndex: index, createdAt: now(), message })) };
}
async function run(item, variant, { stale = false, opaque = false } = {}) {
  const sessionId = `recorded-probe-${randomUUID()}`, turnId = 'audit', stage = `${item.id}-${stale ? 'stale-' : ''}${opaque ? 'fallback-' : ''}${variant}`;
  const store = new SessionStore();
  item.turns.forEach((source, index) => store.commitTurn(sessionId, committed(source, index + 1,
    stale && index === item.turns.length - 1 ? item.staleCorrection : undefined, opaque)));
  const registry = new ToolRegistry(), host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry,
    dataRoot: join(output, `runtime-${stage}`), durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
    provider: observed(stage), preferRecordedToolHandoffs: variant === 'recorded', preferPreparedToolHandoffs: false, registerDefaultWorkspaceTools: false });
  const tools = registry.definitions().filter(t => ['checkpoint_context', 'summary_for_user'].includes(t.name));
  const started = Date.now(), result = { case: item.id, variant, stale, opaque, stage }; report.runs.push(result);
  try {
    const response = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: stage, sessionId, turnId,
      model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
      prefixMessages: prefix, tools, inputMessages: [{ messageId: 'audit-user', message: user(item.question) }],
      metadata: { contextWindowTokens: variant === 'raw' ? model.maxContextTokens : publicConfig.simulatedContextWindow } },
      { signal: AbortSignal.timeout(360000) });
    result.elapsedMs = Date.now() - started; result.status = response.payload.status; result.reason = response.payload.reason;
    const events = host.events(sessionId, turnId), snapshot = store.snapshot(sessionId);
    result.compactions = events.filter(e => e.kind.startsWith('context_compaction_')).map(e => ({ kind: e.kind, payload: e.payload }));
    result.pressureWaitMs = events.filter(e => e.kind === 'context_compaction_completed').reduce((sum, complete) => {
      const begin = events.find(e => e.kind === 'context_compaction_started' && e.payload.compactionId === complete.payload.compactionId);
      return sum + (begin ? Date.parse(complete.createdAt) - Date.parse(begin.createdAt) : 0);
    }, 0);
    result.answer = snapshot.turns.at(-1).messages.filter(f => f.message.role === 'assistant' && !f.message.toolCalls.length).map(f => f.message.content).join('\n');
    try {
      const answer = JSON.parse(result.answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      result.checks = Object.entries(stale ? item.staleExpected : item.expected).map(([key, value]) => ({ key, passed: isDeepStrictEqual(answer[key], value), expected: value, actual: answer[key] }));
      result.passed = result.checks.filter(c => c.passed).length; result.total = result.checks.length;
    } catch { result.parseFailure = true; }
    const projected = assembleContext({ session: snapshot, prefix }).messages; validateConversation(projected);
    await writeFile(join(output, `${stage}-projected.json`), JSON.stringify(projected, null, 2));
    const requests = report.requests.filter(r => r.stage === stage);
    result.modelCalls = requests.length; result.maintenanceRequests = requests.filter(r => r.maintenance).length;
    result.totalInputTokens = requests.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0);
    result.totalOutputTokens = requests.reduce((sum, r) => sum + (r.usage?.outputTokens ?? 0), 0);
    result.continuationInputTokens = requests.findLast(r => !r.maintenance)?.usage?.inputTokens;
    result.appliedHandoffs = snapshot.turns.filter(t => t.contextToolHandoff).map(t => t.turnId);
    emit({ event: 'run_completed', stage, status: result.status, calls: result.modelCalls, maintenance: result.maintenanceRequests,
      passed: result.passed, total: result.total, elapsedMs: result.elapsedMs, continuationInputTokens: result.continuationInputTokens,
      methods: result.compactions.filter(e => e.kind === 'context_compaction_completed').map(e => e.payload.method) });
  } finally { await shutdown(host); await save(); }
}
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
async function exerciseLoop() {
  report.methodology.modelAuthoredHistory = true;
  report.methodology.pressureCounter = 'Continuation-only controlled pressure for recorded arm; actual provider usage recorded separately.';
  const job = { job_id: 'render-602', status: 'running', version: 'draft-17', may_publish: false,
    failed_command: { name: 'audio-check', exitCode: 2, reason: 'Device unavailable; do not claim listening passed' } };
  const fixtureCalls = [], context = [{ role: 'system', content: ROOT_AGENT_SYSTEM_PROMPT }, { role: 'developer', content:
    'This is an isolated fixture workspace. Only fixture_inspect and fixture_status are business tools. Use them when requested. Memory and prediction are disabled. Do not create or resubmit any render job.' }];
  const startStore = new SessionStore(); let history;
  for (const variant of ['initial', 'raw', 'recorded']) {
    const sessionId = `live-loop-${variant}`, store = variant === 'initial' ? startStore : new SessionStore();
    if (history) for (const turn of history.turns) store.commitTurn(sessionId, turn);
    const registry = new ToolRegistry();
    for (const name of ['fixture_inspect', 'fixture_status']) registry.register({
      definition: { name, description: name === 'fixture_inspect' ? 'Inspect the workspace and its already submitted render job.' : 'Read status of an existing job by exact job_id.',
        inputSchema: { type: 'object', properties: { reason: { type: 'string' }, ...(name === 'fixture_status' ? { job_id: { type: 'string' } } : {}) },
          required: name === 'fixture_status' ? ['job_id', 'reason'] : ['reason'] } },
      manifest: { effect_kind: 'observation', operation: name, owner: 'fixture', risk: 'low', mutating: false, dispatch_scope: 'turn' },
      decodeInput: x => x, execute: input => {
        if (name === 'fixture_status') assert.equal(input.input.job_id, job.job_id, 'Must reuse the observed job ID.');
        fixtureCalls.push({ variant, tool: name, arguments: input.input });
        return name === 'fixture_inspect' ? { ...job, log: 'Routine trace, no new completion.\n'.repeat(5000) }
          : { ...job, status: 'completed', artifact: 'C:/fixture/draft-17.mp4', listening_passed: false };
      },
    });
    const stage = `loop-${variant}`, provider = observed(stage);
    if (variant === 'recorded') {
      const counter = provider.countInputTokens;
      provider.countInputTokens = request => request.messages.some(m => m.content.includes('<recorded_tool_exchange>'))
        ? counter(request) : Promise.resolve({ source: 'provider', inputTokens: 38000 });
    }
    const host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, provider, dataRoot: join(output, stage),
      durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false,
      registerDefaultWorkspaceTools: false, preferRecordedToolHandoffs: variant === 'recorded', preferPreparedToolHandoffs: false });
    const tools = registry.definitions().filter(t => ['fixture_inspect', 'fixture_status', 'summary_for_user', 'checkpoint_context'].includes(t.name));
    const text = variant === 'initial' ? '调用 fixture_inspect 检查一次工作区。简单报告已有渲染任务与未完成检查，然后结束本轮。不要等待或再次提交任务。'
      : '请查询之前已经提交的那个渲染任务，不能新建或重复提交。然后只返回 JSON：job_id、status、artifact、failed_command（之前失败的命令名）、listening_passed（布尔）、may_publish（布尔）。';
    const turnId = variant === 'initial' ? 'inspect' : 'continue', started = Date.now();
    try {
      const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: stage, sessionId, turnId,
        model: model.model, reasoningEffort: model.reasoningEffort, maxOutputTokens: model.maxOutputTokens,
        prefixMessages: context, tools, permissionMode: 'all_free',
        inputMessages: [{ messageId: `${stage}-user`, message: user(text) }],
        metadata: { contextWindowTokens: variant === 'recorded' ? publicConfig.simulatedContextWindow : model.maxContextTokens } },
        { signal: AbortSignal.timeout(180000) });
      const events = host.events(sessionId, turnId), snapshot = store.snapshot(sessionId);
      const answer = snapshot.turns.at(-1).messages.filter(f => f.message.role === 'assistant' && !f.message.toolCalls.length).map(f => f.message.content).join('\n');
      const requests = report.requests.filter(r => r.stage === stage);
      const run = { stage, variant, status: result.payload.status, reason: result.payload.reason, elapsedMs: Date.now() - started,
        modelCalls: requests.length, maintenanceRequests: requests.filter(r => r.maintenance).length,
        summaryCalls: events.filter(e => e.kind === 'tool_returned' && e.payload.toolName === 'summary_for_user').length,
        totalInputTokens: requests.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0),
        continuationInputTokens: requests[0]?.usage?.inputTokens, fixtureCalls: fixtureCalls.filter(c => c.variant === variant), answer,
        compactions: events.filter(e => e.kind.startsWith('context_compaction_')).map(e => ({ kind: e.kind, payload: e.payload })) };
      if (variant === 'initial') history = structuredClone(snapshot);
      else {
        try { const actual = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
          const expected = { job_id: job.job_id, status: 'completed', artifact: 'C:/fixture/draft-17.mp4', failed_command: 'audio-check', listening_passed: false, may_publish: false };
          run.checks = Object.entries(expected).map(([key, value]) => ({ key, passed: isDeepStrictEqual(actual[key], value), expected: value, actual: actual[key] }));
          run.passed = run.checks.filter(c => c.passed).length; run.total = run.checks.length;
        } catch { run.parseFailure = true; }
      }
      report.runs.push(run); await save(); emit({ event: 'loop_completed', ...run, answer: undefined, compactions: undefined });
    } finally { await shutdown(host); }
  }
  report.methodology.fixtureToolsExecuted = fixtureCalls.length;
}
try {
  if (values['loop-only']) await exerciseLoop();
  else {
    for (const item of cases) {
    // Counterbalance raw/checkpoint order across cases; recorded uses the same source facts.
    for (const variant of item.id === 'video' ? ['raw', 'checkpoint', 'recorded'] : ['recorded', 'checkpoint', 'raw']) await run(item, variant);
    if (item.staleCorrection) await run(item, 'recorded', { stale: true });
    }
    await run(cases[0], 'recorded', { opaque: true });
  }
  report.completedAt = now();
} catch (error) {
  report.failure = { name: error.name, message: error instanceof assert.AssertionError ? error.message : 'Probe interrupted; inspect sanitized response records.' };
  process.exitCode = 1;
}
await save(); emit({ event: 'report', output, requests: requestCount, complete: !!report.completedAt });
