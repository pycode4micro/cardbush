// Explicit, isolated replay. Reads credentials without printing them; never writes the source DB.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { normalizeIndividuation } from '@cardbush/bush-protocol';
import { createModelProvider } from '@cardbush/bush-provider-openai';
import { InMemoryRuntimeHost } from '../packages/bush-runtime/dist/inMemoryRuntimeHost.js';
import { IndividuationMemory } from '../packages/bush-runtime/dist/individuationMemory.js';

const { values } = parseArgs({ options: { source: { type: 'string' }, models: { type: 'string' }, model: { type: 'string' },
  at: { type: 'string' }, output: { type: 'string' }, baseline: { type: 'string' }, live: { type: 'boolean' } } });
if (!values.live || !values.source || !values.models || !values.model || !values.at || !values.output)
  throw Error('Use --live --source snapshot.sqlite --models models.json --model exact-model --at ISO-time --output new-directory [--baseline events.jsonl]');
const output = resolve(values.output), source = resolve(values.source), dbPath = join(output, 'personalization.sqlite');
if (source === dbPath || output === dirname(source)) throw Error('Replay must use a new directory separate from the source database.');
await mkdir(output); // Deliberately refuse to overwrite a previous replay.
const sourceDb = new DatabaseSync(source, { readOnly: true });
try { await backup(sourceDb, dbPath); } finally { sourceDb.close(); }
const frozenAt = Date.parse(values.at);
if (!Number.isFinite(frozenAt)) throw Error('Invalid snapshot timestamp.');
const db = new DatabaseSync(dbPath), shift = Date.now() - frozenAt;
// Preserve the failed snapshot's age/expiry relationships while the provider uses the real clock.
db.prepare('DELETE FROM memory_records WHERE created>?').run(frozenAt);
for (const column of ['created','updated','expires','confirmed','rejected'])
  db.prepare(`UPDATE memory_records SET ${column}=${column}+? WHERE ${column} IS NOT NULL`).run(shift);
db.exec('UPDATE memory_state SET lease=NULL,lease_until=0,retry_after=0; DELETE FROM memory_summary_attempts');
const active = () => db.prepare("SELECT id,kind,text,applies_when,hits,misses,origin,metadata FROM memory_records WHERE state='active' AND (expires IS NULL OR expires>?) ORDER BY seq").all(Date.now());
const before = active();
const config = JSON.parse(await readFile(values.models, 'utf8')).models.find(item => item.model === values.model || item.id === values.model);
if (!config || !config.apiKey) throw Error('The selected API model is not available in this configuration.');
const underlying = createModelProvider({ adapter: config.apiProtocol, apiKey: config.apiKey, baseURL: config.baseURL, defaultHeaders: config.defaultHeaders });
const attempts = [];
const provider = {
  ...(underlying.estimateInputTokens ? { estimateInputTokens: underlying.estimateInputTokens.bind(underlying) } : {}),
  ...(underlying.countInputTokens ? { countInputTokens: underlying.countInputTokens.bind(underlying) } : {}),
  async *stream(request, options) {
    const start = Date.now(), record = { stage: request.metadata.memoryStage, phase: request.metadata.memoryPhase, reasoningEffort: request.reasoningEffort,
      outputLimit: request.maxOutputTokens, input: JSON.parse(request.messages.at(-1).content), text: '', reasoningChars: 0 };
    const attempt=attempts.push(record);
    console.log(JSON.stringify({ event: 'request', attempt, stage: record.stage, phase:record.phase, records: record.input.length }));
    try {
      for await (const event of underlying.stream(request, options)) {
        if (event.kind === 'reasoning_delta') record.reasoningChars += event.delta.length;
        if (event.kind === 'text_delta') record.text += event.delta;
        if (event.kind === 'usage') record.usage = { ...record.usage, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cachedInputTokens: event.cachedInputTokens };
        if (event.kind === 'response_completed') record.finishReason = event.finishReason;
        if (event.kind === 'response_failed') record.failureCode = event.code;
        yield event;
      }
    } finally {
      record.elapsedMs = Date.now() - start;
      console.log(JSON.stringify({ event: 'request_finished', attempt, elapsedMs: record.elapsedMs, usage: record.usage,
        reasoningChars: record.reasoningChars, textChars: record.text.length, finish: record.finishReason, failureCode: record.failureCode }));
    }
  },
};
const host = new InMemoryRuntimeHost({ dataRoot: join(output, 'runtime'), provider, registerDefaultWorkspaceTools: false,
  durableRecovery: false, durableSessions: false, durableCoordination: false, durableSubagentTasks: false });
const memory = new IndividuationMemory(dbPath, host.runInternalTask.bind(host));
const settings = normalizeIndividuation({ habits: true, predictions: true });
const started = Date.now();
let status, failure;
try {
  status = await memory.compact(settings, { model: config.model, reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens, metadata: { contextWindowTokens: config.maxContextTokens } }, true);
} catch (error) { failure = String(error.message); status = await memory.status(settings); }
finally { await memory.close(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
let baseline;
if (values.baseline) {
  const events = (await readFile(values.baseline, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line).event);
  const started = events.find(event => event.kind === 'turn_started'), ended = events.findLast(event => event.kind === 'turn_terminal');
  const usage = events.findLast(event => event.kind === 'model_request_usage')?.payload;
  baseline = { elapsedMs: Date.parse(ended.createdAt) - Date.parse(started.createdAt), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    reasoningChars: events.filter(event => event.kind === 'reasoning_segment_completed').reduce((n, event) => n + event.payload.content.length, 0),
    textChars: events.filter(event => event.kind === 'assistant_segment_completed').reduce((n, event) => n + event.payload.content.length, 0), terminal: ended.payload.status };
}
const after = active();
const result = { model: config.model, baseline, elapsedMs: Date.now() - started, status, failure,
  attempts, before, after, reviews: db.prepare('SELECT outcome,COUNT(*) count FROM memory_reviews GROUP BY outcome').all() };
db.close();
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ event: 'finished', path: join(output, 'result.json'), elapsedMs: result.elapsedMs, status,
  requests: attempts.length, newHabits: after.filter(row => row.kind === 'habit' && !before.some(old => old.id === row.id)).length,
  originalHabitsRetained: before.filter(row => row.kind === 'habit' && after.some(next => next.id === row.id)).length, failure }));
if (failure) process.exitCode = 1;
