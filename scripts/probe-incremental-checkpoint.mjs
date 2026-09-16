// Read-only replay of the reported conversation. Default: offline fault
// injection. --send: checkpoint generation with the configured model only.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SessionStore, assembleContextProjection, ToolRegistry, estimateContextPressure } from '@cardbush/bush-runtime';
import { registerContextCompactionTool, locateContextCompactionSources } from '../packages/bush-runtime/dist/contextCompaction.js';
import { ContextCompactionTransaction } from '../packages/bush-runtime/dist/contextCompactionTransaction.js';
import { executeModelRound } from '../packages/bush-runtime/dist/modelRound.js';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { OpenAIResponsesProvider, toResponsesCreateParams } from '@cardbush/bush-provider-openai';

const [sessionId, turnId] = process.argv.slice(2);
assert.match(sessionId ?? '', /^local-[a-f0-9-]+$/i);
assert.match(turnId ?? '', /^turn_[a-f0-9-]+$/i);
const hash = value => createHash('sha256').update(value).digest('hex');
const root = join(process.env.APPDATA, 'cardbush');
const sessionPath = join(root, 'runtime-state', 'sessions', hash(sessionId) + '.jsonl');
const original = await readFile(sessionPath, 'utf8');
const records = original.trim().split(/\r?\n/).map(JSON.parse);
records.forEach(record => assert.equal(record.checksum, hash(JSON.stringify(record.event))));
const currentIndex = records.findIndex(record => record.event.kind === 'turn_committed' && record.event.payload.turnId === turnId);
assert.ok(currentIndex >= 0);
const current = records[currentIndex].event.payload;
const store = new SessionStore({ persistence: { load: () => records.slice(0, currentIndex).map(record => record.event),
  append() { throw new Error('Read-only diagnostic'); } } });
const session = store.snapshot(sessionId);
const eventPath = join(root, 'runtime-state', 'events', hash(JSON.stringify([sessionId, turnId])) + '.jsonl');
const originalEvents = await readFile(eventPath, 'utf8');
const events = originalEvents.trim().split(/\r?\n/).map(JSON.parse).map(record => record.event);
const started = events.find(event => event.kind === 'context_compaction_started');
const boundary = current.messages.findIndex(message => message.messageId === started?.payload.activeThroughMessageId);
assert.ok(boundary >= 0);
const active = current.messages.slice(0, boundary + 1).map(item => item.message);
const configs = JSON.parse(await readFile(join(root, 'product-host', 'config', 'models.json'), 'utf8'));
const model = configs.models.find(item => item.id === configs.defaultModelId);
assert.ok(model?.model);
const registry = new ToolRegistry();
registerContextCompactionTool(registry, () => { throw new Error('Business execution is disabled in the probe.'); });
const requestId = 'incremental-probe-' + randomUUID();
const seed = createProductAgentTurnRequest({ requestId, sessionId, turnId, messageId: 'probe',
  createdAt: current.createdAt, localDate: current.createdAt.slice(0, 10), userText: active[0].content,
  model: model.model, permissionMode: 'task_free', planEnabled: true, visionEnabled: true,
  tools: registry.definitions(), maxOutputTokens: 128000, maxContextTokens: 400000, reasoningEffort: 'high' });
const prefix = seed.prefixMessages;
const projection = assembleContextProjection({ session, prefix });
const messages = [...projection.context.messages, ...active];
const state = { revision: session.revision, totalTurns: session.turns.length, unsummarizedTurnIds: projection.turns.map(s => s.turnId),
  activeTurn: { turnId, throughMessageId: started.payload.activeThroughMessageId } };
const sources = locateContextCompactionSources({ messages, prefixMessageCount: prefix.length, turns: projection.turns,
  activeTurnId: turnId, activeMessages: active, state, inputFormat: 'incremental' });
const base = { protocol: 'bush.model_request.v1', requestId, sessionId, turnId, model: model.model,
  messages, tools: registry.definitions(), maxOutputTokens: 128000, reasoningEffort: 'high',
  requestCapabilities: { vision: true, interactiveRequests: false }, metadata: { contextWindowTokens: 400000 } };
const outputDirectory = resolve('tmp/incremental-compaction-audit');
await mkdir(outputDirectory, { recursive: true });

async function run(live) {
  const repeatedCallProbe = live && process.argv.includes('--one-per-call');
  const provider = live ? new OpenAIResponsesProvider({ apiKey: model.apiKey, baseURL: model.baseURL, timeoutMs: 120000 }) : undefined;
  const transaction = new ContextCompactionTransaction({ messages, prefixMessageCount: prefix.length, sources, state,
    pressure: estimateContextPressure(base, messages, 260000), inputFormat: 'incremental', outputTokens: 16384, maximumOutputTokens: 128000 });
  if (repeatedCallProbe) transaction.incremental.history[0].content += '\nFor this diagnostic only, exercise repeated Tool calls: choose exactly ONE pending source per call, in any order you prefer, until complete. This tests receipt-driven continuation; the production Tool supports larger batches too.';
  const calls = [];
  let previous, complete = false;
  const began = Date.now();
  for (let round = 0; round < sources.length * 3 && !complete; round++) {
    const job = transaction.job();
    assert.ok(job.failures < 3, 'No-progress budget exhausted.');
    const request = { ...base, requestId: `${requestId}:${live ? 'live' : 'offline'}:${round}`, messages: job.messages, maxOutputTokens: job.outputTokens };
    assert.deepEqual(request.messages.slice(0, messages.length), messages);
    const wire = toResponsesCreateParams(request);
    if (previous) assert.deepEqual(wire.input.slice(0, previous.length), previous, 'The complete previous request must remain an unchanged prefix.');
    previous = wire.input;
    const receipt = transaction.incremental.history.at(-1);
    const remaining = receipt.role === 'tool' ? JSON.parse(receipt.content).remaining.map(item => item.source) : sources.map((_, index) => index);
    const fixture = { async *stream(candidate) {
      const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: candidate.requestId,
        sequence, createdAt: new Date().toISOString(), kind, ...fields });
      // Exercise the old count mismatch and mixed valid/invalid entries, then
      // choose the remaining sources in reverse order, one per call.
      const args = round === 0 ? '{"summaries":["old array shape"]}' : JSON.stringify({ updates: [
        { source: remaining.at(-1), summary: `Offline fixture for source ${remaining.at(-1)}; not a semantic model quality claim.` },
        ...(round === 1 ? [{ source: -1, summary: '' }] : []),
      ] });
      yield event(0, 'tool_call_delta', { index: 0, toolCallId: `probe_${round}`, nameDelta: 'checkpoint_context', argumentsDelta: args });
      yield event(1, 'response_completed', { finishReason: 'tool_calls' });
    } };
    const response = await executeModelRound(provider ?? fixture, request, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 'completed', response.error?.message);
    assert.notEqual(response.finishReason, 'length');
    complete = transaction.accept(response);
    const outcome = JSON.parse(transaction.incremental.history.at(-1).content);
    calls.push({ round: round + 1, usage: response.usage, accepted: outcome.accepted, rejected: outcome.rejected, remaining: outcome.remaining });
    console.log(JSON.stringify({ mode: live ? 'live' : 'offline', ...calls.at(-1) }));
  }
  assert.equal(complete, true);
  const summaries = transaction.incremental.value.summaries;
  const report = { mode: repeatedCallProbe ? 'live-repeated' : live ? 'live' : 'offline', sessionId, turnId, model: model.model,
    sourceCount: sources.length, sourceMessages: messages.length - prefix.length,
    prefix: 'reconstructed current product prefix and checkpoint catalog; original conversation sources preserved',
    elapsedMs: Date.now() - began, calls, unchangedNativeAndWirePrefixes: true, businessToolsExecuted: 0,
    summaries: summaries.map((text, index) => ({ source: index, turnId: sources[index].turnId, text,
      taskIdsOutsideOwnSourceForReview: [...new Set(text.match(/cgt-\d{14}-[a-z0-9]+/g) ?? [])]
        .filter(id => !JSON.stringify(messages.slice(sources[index].startMessage, sources[index].endMessageExclusive)).includes(id)) })) };
  assert.equal(await readFile(sessionPath, 'utf8'), original);
  assert.equal(await readFile(eventPath, 'utf8'), originalEvents);
  await writeFile(join(outputDirectory, report.mode + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: report.mode, passed: true, calls: calls.length, elapsedMs: report.elapsedMs }));
}
await run(false);
if (process.argv.includes('--send')) await run(true);
