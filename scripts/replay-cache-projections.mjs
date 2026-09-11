// Read-only history audit. No recorded tool or network request is executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { assembleContext, CacheChainTracker, projectSession } from '@cardbush/bush-runtime';
import { toResponsesCreateParams } from '@cardbush/bush-provider-openai';
import { estimateResponsesInputTokens } from '../packages/bush-provider-openai/dist/responsesInputEstimate.js';
import { responsesInputFingerprint } from '../packages/bush-provider-openai/dist/responsesInputFingerprint.js';

globalThis.fetch = async () => { throw new Error('Network access is forbidden in this replay.'); };
const sessionId = process.argv[2];
if (!/^local-[a-f0-9-]{36}$/.test(sessionId ?? '')) throw new Error('Pass a local Session ID.');
const output = resolve(process.argv[3] ?? 'tmp/cache-projection-replay.json');
if (!output.startsWith(resolve('.') + sep)) throw new Error('The report must remain in the workspace.');
const hash = value => createHash('sha256').update(value).digest('hex');
const root = join(process.env.APPDATA, 'cardbush', 'runtime-state');
const sourcePath = join(root, 'sessions', hash(sessionId) + '.jsonl');
const bytes = await readFile(sourcePath);
const events = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line).event);
const session = projectSession(sessionId, events);
const report = { sessionId, liveApiCalls: 0, recordedToolsExecuted: 0, turns: [], sourcesUnchanged: false };
const sourceBytes = new Map([[sourcePath, bytes]]);
for (const turn of session.turns) {
  const assistant = turn.messages.find(item => item.message.role === 'assistant' && item.message.providerReplay)?.message;
  const request = modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'offline', sessionId,
    turnId: turn.turnId, model: turn.usage.model ?? assistant?.providerReplay?.model ?? 'offline-fixture',
    providerBinding: assistant?.providerReplay?.providerBinding, messages: turn.messages.map(item => item.message), tools: [] });
  const wire = toResponsesCreateParams(request, { disableProviderState: true });
  const row = { turnId: turn.turnId, status: turn.status,
    messagePayloadOnly: { oldJournalEstimate: Math.ceil(JSON.stringify(request.messages).length / 4), wireEstimate: estimateResponsesInputTokens(wire),
      caveat: 'Messages only; excludes historical stable instructions and tool catalog. These are character estimates, not API token counts.' },
    checkpoint: turn.contextCheckpoint?.projectionVersion ?? (turn.contextCheckpoint ? 'legacy' : null),
    actualUsage: { requests: 0, input: 0, cached: 0 }, structuralBreaks: [], compactions: [], lastRequests: [] };
  const path = join(root, 'events', hash(JSON.stringify([sessionId, turn.turnId])) + '.jsonl');
  let runtimeEvents = [];
  try { const value = await readFile(path); sourceBytes.set(path, value); runtimeEvents = value.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const event of runtimeEvents) {
    if (event.kind === 'model_request_usage') {
      const p = event.payload;
      row.actualUsage.requests++; row.actualUsage.input += p.inputTokens ?? 0; row.actualUsage.cached += p.cachedInputTokens ?? 0;
      row.lastRequests.push({ round: p.round, input: p.inputTokens, cached: p.cachedInputTokens, preflight: p.preflightInputTokens,
        measurement: p.preflightMeasurement, usableInput: p.usableInputTokens });
    }
    if (event.kind === 'cache_chain_observed' && event.payload.frozenPrefixBreak) row.structuralBreaks.push({
      ordinal: event.payload.requestOrdinal, index: event.payload.breakIndex, scope: 'runtime_messages_only' });
    if (event.kind === 'context_compaction_started') row.compactions.push(event.payload);
  }
  row.lastRequests = row.lastRequests.slice(-4);
  row.actualUsage.ratio = row.actualUsage.input ? row.actualUsage.cached / row.actualUsage.input : null;
  // Compare the current historical projection with the same projection plus
  // a new user request. This does not reconstruct missing old native output.
  const messages = assembleContext({ session, throughTurnSequence: turn.turnSequence }).messages;
  const first = { ...request, messages };
  const next = { ...first, messages: [...messages, { role: 'user', content: 'Offline append-only probe.' }] };
  const tracker = new CacheChainTracker();
  const observe = req => { tracker.observe(req); const params = toResponsesCreateParams(req, { disableProviderState: true });
    return tracker.observeProviderInput(responsesInputFingerprint(params, params, req.providerBinding)); };
  observe(first); row.nextTurnProjectionBreak = observe(next).frozenPrefixBreak;
  assert.equal(row.nextTurnProjectionBreak, false);
  report.turns.push(row);
}
for (const [path, before] of sourceBytes) assert.equal(hash(await readFile(path)), hash(before), 'source journal changed during replay');
report.sourcesUnchanged = true;
report.sourceHashes = [...sourceBytes.values()].map(hash);
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sessionId, turns: report.turns.length, sourcesUnchanged: true, output }));
