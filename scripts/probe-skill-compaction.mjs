// Live semantic probe through the existing production compaction transaction.
// Business progress is a labelled fixture; Skill bytes and model replies are
// real. No business tool is executed and no user session/config is modified.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { registerContextCompactionTool } from '../packages/bush-runtime/dist/contextCompaction.js';
import { ContextCompactionTransaction } from '../packages/bush-runtime/dist/contextCompactionTransaction.js';
import { executeModelRound } from '../packages/bush-runtime/dist/modelRound.js';
import { validateConversation } from '../packages/bush-runtime/dist/sessionStore.js';
import { skillCompactionCases } from './fixtures/skill-compaction-cases.mjs';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, output: { type: 'string' }, profile: { type: 'string' },
  cases: { type: 'string', default: 'garment,video' }, model: { type: 'string' },
  repeats: { type: 'string', default: '1' }, passes: { type: 'string', default: '5' },
} });
assert.ok(values.output, 'Use --output <new-directory> [--live] [--cases garment,video] [--repeats 1]');
const output = resolve(values.output);
await mkdir(output); // Never overwrite a previous run.
const profile = resolve(values.profile ?? join(process.env.APPDATA, 'cardbush'));
const configPath = join(profile, 'product-host/config/models.json');
const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes);
const model = config.models.find(item => values.model ? item.id === values.model || item.model === values.model : item.id === config.defaultModelId);
assert.ok(model?.model && model.apiKey, 'The selected configured API model is unavailable.');
const repeatCount = Number(values.repeats), passes = Number(values.passes);
assert.ok(Number.isInteger(repeatCount) && repeatCount >= 1 && repeatCount <= 3);
assert.ok(Number.isInteger(passes) && passes >= 1 && passes <= 5);
const cases = values.cases.split(',').map(id => {
  const item = skillCompactionCases.find(candidate => candidate.id === id);
  assert.ok(item, `Unknown scenario ${id}`); return item;
});
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.replace(/\s+/g, ' ').trim();
const registry = new ToolRegistry();
registerContextCompactionTool(registry, () => { throw Error('No business tool execution in the semantic probe.'); });
const tools = registry.definitions();
const systemHashes = new Set(), toolHashes = new Set();
const publicConfig = { model: model.model, adapter: model.apiProtocol, reasoningEffort: model.reasoningEffort,
  maxOutputTokens: model.maxOutputTokens, maxContextTokens: model.maxContextTokens };
const provider = values.live ? createModelProvider({ adapter: model.apiProtocol, apiKey: model.apiKey,
  baseURL: model.baseURL, defaultHeaders: model.defaultHeaders, timeoutMs: 600000 }) : undefined;
const cleanMessage = message => {
  const { reasoningContent, providerReplay, ...visible } = message;
  return visible;
};
const user = content => ({ role: 'user', content });
const exchange = (name, id, args, result) => [
  { role: 'assistant', content: '', toolCalls: [{ id, name, argumentsText: JSON.stringify(args) }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify(result) },
];
const emit = value => console.log(JSON.stringify(value));
const report = { startedAt: new Date().toISOString(), live: Boolean(values.live), config: publicConfig,
  methodology: { productionTransaction: true, realSkillBytes: true, fixtureBusinessProgress: true,
    controlledCompactionTrigger: true, originalSkillOnlyInFirstPass: true, rubricHiddenFromModel: true,
    noHiddenReasoningOrReplayCarried: true, userSessionsModified: false, businessToolsExecuted: 0 },
  sources: [], runs: [] };
for (const file of ['checkpointSkillConstraints', 'contextCompaction', 'contextCompactionTransaction', 'incrementalCheckpoint']) {
  report.runtimeHashes ??= {};
  report.runtimeHashes[file] = hash(await readFile(new URL(`../packages/bush-runtime/dist/${file}.js`, import.meta.url)));
}
await mkdir(join(output, 'sources'));
const snapshots = new Map();
for (const item of cases) {
  const path = join(profile, item.skill), bytes = await readFile(path), content = bytes.toString('utf8');
  const sha256 = hash(bytes);
  for (const row of item.requirements) assert.ok(normalized(content).includes(normalized(row.quote)), `${row.id}: expected quotation absent from real Skill`);
  const snapshot = { path, sha256, content };
  snapshots.set(item.id, snapshot);
  await writeFile(join(output, 'sources', `${item.id}-SKILL.md`), bytes);
  await writeFile(join(output, 'sources', `${item.id}-rubric.json`), JSON.stringify(item.requirements, null, 2));
  report.sources.push({ case: item.id, path, sha256, chars: content.length, requirements: item.requirements.length });
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
if (!provider) { emit({ event: 'prepared', output, ...publicConfig, sources: report.sources, sendsRequest: false }); process.exit(0); }

for (const item of cases) for (let repeat = 1; repeat <= repeatCount; repeat++) {
  const runId = `${item.id}-${repeat}`, directory = join(output, runId);
  await mkdir(directory);
  const sessionId = `skill-audit-${randomUUID()}`, turnId = `turn_${randomUUID()}`, createdAt = new Date().toISOString();
  const seed = createProductAgentTurnRequest({ requestId: runId, sessionId, turnId, messageId: 'fixture-user', createdAt,
    localDate: createdAt.slice(0, 10), userText: item.request, model: model.model, permissionMode: 'task_free',
    tools, maxOutputTokens: model.maxOutputTokens, maxContextTokens: model.maxContextTokens, reasoningEffort: model.reasoningEffort });
  const prefix = seed.prefixMessages;
  const snapshot = snapshots.get(item.id);
  const initialRead = exchange('read_file', `${runId}-skill`, { path: snapshot.path }, { ...snapshot, lineCount: snapshot.content.split(/\r?\n/).length });
  const run = { id: runId, case: item.id, repeat, passes: [] };
  report.runs.push(run);
  let previous = [];
  for (let pass = 1; pass <= passes; pass++) {
    const stage = item.stages[pass - 1];
    const messages = [...prefix, user(item.request), ...(pass === 1 ? initialRead : previous),
      ...(stage.user ? [user(stage.user)] : []),
      ...exchange('fixture_progress', `${runId}-progress-${pass}`, {}, { fixture: true, note: stage.note,
        routineChecks: Array.from({ length: 32 }, (_, i) => ({ check: i + 1, status: 'ok', details: '常规状态检查，无新的用户授权、交付决定或约束变更。' })) })];
    validateConversation(messages);
    const sources = [{ turnId, target: 'source 0', startMessage: prefix.length, endMessageExclusive: messages.length }];
    const state = { revision: pass, totalTurns: 0, unsummarizedTurnIds: [], activeTurn: { turnId, throughMessageId: `${runId}-boundary-${pass}` } };
    let tx = new ContextCompactionTransaction({ messages, prefixMessageCount: prefix.length, sources, state,
      pressure: { ratio: 0.96 }, inputFormat: 'incremental', outputTokens: model.maxOutputTokens, maximumOutputTokens: model.maxOutputTokens });
    const record = { pass, stage, attempts: [], startedAt: new Date().toISOString() };
    run.passes.push(record);
    const started = Date.now();
    let complete = false;
    for (let attempt = 1; attempt <= 3 && !complete; attempt++) {
      const job = tx.job();
      const request = { protocol: 'bush.model_request.v1', requestId: `${runId}-${pass}-${attempt}-${randomUUID()}`,
        sessionId, turnId, model: model.model, messages: job.messages, tools,
        maxOutputTokens: job.outputTokens, reasoningEffort: model.reasoningEffort,
        requestCapabilities: { interactiveRequests: false }, metadata: { contextWindowTokens: model.maxContextTokens } };
      assert.deepEqual(request.messages.slice(0, prefix.length), prefix);
      systemHashes.add(hash(JSON.stringify(prefix))); toolHashes.add(hash(JSON.stringify(tools)));
      await writeFile(join(directory, `pass-${pass}-attempt-${attempt}-request.json`), JSON.stringify({ ...request, messages: request.messages.map(cleanMessage) }, null, 2));
      emit({ event: 'request', run: runId, pass, attempt, ...publicConfig, inputChars: JSON.stringify(request.messages).length });
      const began = Date.now(); let lastTick = began, reasoningChars = 0, textChars = 0;
      const result = await executeModelRound(provider, request, { signal: AbortSignal.timeout(600000), onEvent(event) {
        if (event.kind === 'reasoning_delta') reasoningChars += event.delta.length;
        if (event.kind === 'text_delta') textChars += event.delta.length;
        if (Date.now() - lastTick > 20000) { emit({ event: 'progress', run: runId, pass, elapsedMs: Date.now() - began, reasoningChars, textChars }); lastTick = Date.now(); }
      } });
      const outcome = { attempt, elapsedMs: Date.now() - began, status: result.status, finishReason: result.finishReason,
        usage: result.usage, reasoningChars: result.reasoning.length, textChars: result.text.length };
      record.attempts.push(outcome);
      if (result.status !== 'completed') {
        outcome.failureCode = result.error?.code;
        record.failure = 'provider_failed';
        emit({ event: 'failed', run: runId, pass, ...outcome }); break;
      }
      try { complete = tx.accept(result); }
      catch (error) {
        outcome.rejection = error.message;
        if (!tx.retry('Submit exactly one complete checkpoint_context call with the requested source summaries.')) break;
      }
      outcome.complete = complete;
      const receipt = tx.incremental.history.findLast(message => message.role === 'tool');
      if (receipt) outcome.receipt = JSON.parse(receipt.content);
      emit({ event: 'attempt_finished', run: runId, pass, attempt, elapsedMs: outcome.elapsedMs, usage: outcome.usage,
        reasoningChars: outcome.reasoningChars, complete, rejected: outcome.receipt?.rejected });
      if (!complete && pass === 3) {
        // Exercise persisted maintenance continuation through the existing
        // constructor, without rereading Skill content or synthesizing results.
        const continuation = JSON.parse(JSON.stringify(tx.incremental.history.map(cleanMessage)));
        tx = new ContextCompactionTransaction({ messages, prefixMessageCount: prefix.length, sources, state,
          pressure: { ratio: 0.96 }, inputFormat: 'incremental', outputTokens: model.maxOutputTokens,
          maximumOutputTokens: model.maxOutputTokens, continuation });
        record.maintenanceRestored = true;
      }
    }
    record.elapsedMs = Date.now() - started;
    if (complete) {
      record.summary = tx.incremental.value.summaries[0];
      record.summaryChars = record.summary.length;
      previous = tx.incremental.history.slice(-2).map(cleanMessage);
      const statePath = join(directory, `pass-${pass}-checkpoint.json`);
      await writeFile(statePath, JSON.stringify(previous, null, 2));
      previous = JSON.parse(await readFile(statePath, 'utf8'));
      validateConversation(previous);
      await writeFile(join(directory, `pass-${pass}-summary.txt`), record.summary);
    } else { record.failure ??= 'checkpoint_not_completed'; }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    emit({ event: 'pass_finished', run: runId, pass, complete, elapsedMs: record.elapsedMs, summaryChars: record.summaryChars });
    if (!complete) break;
  }
}
for (const item of cases) assert.equal(hash(await readFile(snapshots.get(item.id).path)), snapshots.get(item.id).sha256, 'Never modify the installed Skill');
assert.deepEqual(await readFile(configPath), configBytes, 'Never modify provider settings');
report.finishedAt = new Date().toISOString();
report.toolSchemasStable = toolHashes.size === 1;
report.prefixVariants = systemHashes.size; // Per-scenario context may differ; every request is checked against its frozen seed.
report.completedPasses = report.runs.reduce((count, run) => count + run.passes.filter(pass => pass.summary).length, 0);
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
emit({ event: 'finished', output, completedPasses: report.completedPasses, toolSchemasStable: report.toolSchemasStable });
