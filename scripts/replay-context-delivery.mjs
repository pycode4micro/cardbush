// Offline structural replay: reads historical facts, never runs recorded tools or model requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { modelMessageSchema } from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { activeTurnResumeMessage, projectActiveTurnContext, assembleContext, CacheChainTracker, projectMcpDiscoveryResult } from '@cardbush/bush-runtime';

globalThis.fetch = async () => { throw new Error('Network requests are forbidden in historical replay.'); };
const sessionId = process.argv[2];
if (!/^local-[a-f0-9-]{36}$/.test(sessionId ?? '')) throw new Error('Pass a local session ID.');
const output = resolve(process.argv[3] ?? 'tmp/context-delivery-replay.json');
const workspace = resolve('.');
if (!output.startsWith(workspace + '\\') && !output.startsWith(workspace + '/')) throw new Error('Replay report must stay in the workspace.');
const root = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'cardbush', 'runtime-state');
const digest = text => createHash('sha256').update(text).digest('hex');
const key = digest(sessionId);
const paths = ['sessions', 'tool-executions'].map(kind => join(root, kind, key + '.jsonl'));
const sources = await Promise.all(paths.map(path => readFile(path)));
const events = sources[0].toString('utf8').trim().split('\n').map(line => JSON.parse(line).event);
const turns = events.filter(event => event.kind === 'turn_committed').map(event => event.payload);
const records = sources[1].toString('utf8').trim().split('\n').map(line => JSON.parse(line).record);
const report = { sessionId, mode: 'offline_structural_replay', liveApiCalls: 0, recordedToolsExecuted: 0,
  turns: turns.length, toolRecords: records.length, attachments: [], discovery: [], checkpoints: [], sourcesUnchanged: false };
for (const turn of turns) {
  for (const item of turn.messages.filter(item => item.message.role === 'user' && item.message.images?.length)) {
    const sources = item.message.images.map(image => image.url);
    const request = createProductAgentTurnRequest({ requestId: 'replay', sessionId, turnId: turn.turnId,
      messageId: item.messageId, createdAt: item.createdAt, localDate: '2026-09-10', sessionEnvironmentLocalDate: '2026-09-10',
      userText: item.message.content, model: 'offline-fixture', tools: [], images: sources, permissionMode: 'task_free', planEnabled: true });
    const text = request.inputMessages.map(item => item.message.content).join('\n');
    const pathsVisible = sources.filter(source => !source.startsWith('data:')).every(source => text.includes(JSON.stringify(source)));
    assert.ok(pathsVisible);
    assert.equal(request.prefixMessages.some(message => sources.some(source => message.content.includes(source))), false);
    report.attachments.push({ turn: turn.turnSequence, images: sources.length, pathsVisible,
      uncImages: sources.filter(source => source.startsWith('\\\\')).length });
  }
  if (turn.contextCheckpoint) {
    const checkpoint = turn.contextCheckpoint;
    for (const projectionVersion of [undefined, 'stable_v1']) {
      const replay = { ...turn, contextCheckpoint: { ...checkpoint, ...(projectionVersion ? { projectionVersion } : {}) } };
      const active = projectActiveTurnContext({ turnId: turn.turnId,
        inputMessages: turn.messages.slice(0, checkpoint.inputMessageCount), generatedMessages: turn.messages.slice(checkpoint.inputMessageCount),
        checkpoint: replay.contextCheckpoint, includeResumeInstruction: true }).map(message => modelMessageSchema.parse(message));
      const session = { sessionId, revision: 1, turns: [replay], supersededMessageIds: [] };
      assert.deepEqual(assembleContext({ session }).messages, active);
      assert.deepEqual(assembleContext({ session: JSON.parse(JSON.stringify(session)) }).messages, active);
      const tracker = new CacheChainTracker(); const request = { model: 'fixture', tools: [], messages: active };
      tracker.observe(request);
      const next = tracker.observe({ ...request, messages: assembleContext({ session, current: [{ role: 'user', content: 'Next request' }] }).messages });
      assert.equal(next.frozenPrefixBreak, false);
      const legacyResumeDigest = digest(JSON.stringify(modelMessageSchema.parse(activeTurnResumeMessage())));
      report.checkpoints.push({ turn: turn.turnSequence, projection: projectionVersion ?? 'legacy',
        oldResumePosition: turn.cacheChainState?.messageDigests.indexOf(legacyResumeDigest),
        completedAndRecoveredIdentically: true, nextTurnPrefixBreak: next.frozenPrefixBreak });
    }
  }
}
for (const record of records.filter(record => record.toolCall.name === 'mcp_search' && record.outcome === 'returned')) {
  const raw = JSON.stringify(record.result);
  if (record.result?.protocol !== 'bush.mcp_discovery.v1') continue;
  const projected = projectMcpDiscoveryResult(raw);
  const view = JSON.parse(projected);
  assert.deepEqual(view.catalog.map(tool => tool.name), record.result.matches.map(tool => tool.name));
  for (const match of view.matches) assert.deepEqual(match, record.result.matches.find(tool => tool.name === match.name));
  const message = turns.flatMap(turn => turn.messages).find(item => item.message.role === 'tool' && item.message.toolCallId === record.toolCall.id)?.message;
  const seedreamMatches = record.result.matches.filter(match => /seedream/i.test(match.name));
  const hasSeedream = seedreamMatches.length > 0;
  for (const match of seedreamMatches) {
    const exactResult = { ...record.result, total: 1, more: false, matches: [match] };
    const exactView = JSON.parse(projectMcpDiscoveryResult(JSON.stringify(exactResult)));
    assert.deepEqual(exactView.matches, [match], 'An isolated historical Seedream definition must be delivered intact');
  }
  report.discovery.push({ inputChars: raw.length, previousVisibleChars: message?.content.length, projectedChars: projected.length,
    totalHits: view.catalog.length, completeDefinitions: view.matches.filter(match => match.inputSchema).length,
    ...(hasSeedream ? { previousSeedreamVisible: /seedream/i.test(message?.content ?? ''),
      seedreamVisible: /seedream/i.test(projected), exactSeedreamReloadComplete: true, seedreamSchemaLoaded: view.matches.some(match => /seedream/i.test(match.name) && match.inputSchema) } : {}) });
}
const after = await Promise.all(paths.map(path => readFile(path)));
report.sourcesUnchanged = sources.every((source, index) => source.equals(after[index]));
assert.ok(report.sourcesUnchanged);
report.sourceHashes = sources.map(source => digest(source));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, turns: report.turns, toolRecords: report.toolRecords,
  attachmentChecks: report.attachments.length, searchChecks: report.discovery.length, checkpointChecks: report.checkpoints.length,
  seedream: report.discovery.filter(result => result.seedreamVisible), sourcesUnchanged: report.sourcesUnchanged }, null, 2));
