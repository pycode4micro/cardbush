// Offline regression against a read-only copy of an existing failed Turn.
// No provider/network request, no original project Tool execution, no profile writes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import {
  assembleContext, CacheChainTracker, InMemoryRuntimeHost, InMemoryRuntimeEventLog,
  InMemoryRuntimeCheckpointStore, RuntimeRecoveryCoordinator, SessionStore, ToolRegistry,
} from '@cardbush/bush-runtime';

const sessionId = process.argv[2];
assert.match(sessionId ?? '', /^local-[a-f0-9-]+$/i, 'Usage: node scripts/probe-context-checkpoint.mjs <local-session-id>');
const hash = value => createHash('sha256').update(value).digest('hex');
const journalPath = join(process.env.APPDATA, 'cardbush', 'runtime-state', 'sessions', hash(sessionId) + '.jsonl');
const original = await readFile(journalPath, 'utf8');
const records = original.trim().split(/\r?\n/).map(JSON.parse);
for (const record of records) assert.equal(record.checksum, hash(JSON.stringify(record.event)));
const last = records.at(-1).event;
assert.equal(last.kind, 'turn_committed', 'The latest durable fact must be the failed Turn.');
assert.equal(last.payload.reason, 'context_compaction_failed', 'Probe only the reported checkpoint failure.');
const failed = last.payload;
const memoryEvents = records.slice(0, -1).map(record => record.event);
const sessionStore = new SessionStore({ persistence: {
  load: () => structuredClone(memoryEvents),
  append: event => memoryEvents.push(structuredClone(event)),
} });
const prior = sessionStore.snapshot(sessionId);
const originalBoundary = failed.messages.at(-1).messageId;
const temporaryRoot = await mkdtemp(join(tmpdir(), 'cardbush-checkpoint-probe-'));
let host;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('This diagnostic must remain offline.'); };
try {
  let maintenanceCalls = 0, probeToolExecutions = 0;
  const requests = [];
  const registry = new ToolRegistry().register({
    definition: { name: 'offline_probe_only', description: 'Pure in-memory probe; no project access.', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'observation', operation: 'probe.memory', risk: 'low', owner: 'runtime', dispatch_scope: 'turn', mutating: false },
    decodeInput: value => value,
    execute: () => { probeToolExecutions += 1; return { offline_probe: true }; },
  });
  const eventLog = new InMemoryRuntimeEventLog();
  const checkpointStore = new InMemoryRuntimeCheckpointStore();
  const modelEvent = (request, sequence, kind, values = {}) => ({
    protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, kind,
    createdAt: new Date().toISOString(), ...values,
  });
  host = new InMemoryRuntimeHost({
    dataRoot: temporaryRoot, registerDefaultWorkspaceTools: false, sessionStore,
    toolRegistry: registry, eventLog, checkpointStore,
    provider: {
      async countInputTokens(request) {
        return {
          inputTokens: request.messages.some(m => m.name === 'context_checkpoint_resume') ? 1000 : 229230,
          source: 'provider',
        };
      },
      async *stream(request) {
        requests.push(structuredClone(request));
        yield modelEvent(request, 0, 'response_started');
        if (request.messages.some(m => m.name === 'context_pressure')) {
          maintenanceCalls += 1;
          yield modelEvent(request, 1, 'tool_call_delta', {
            index: 0, toolCallId: 'offline_checkpoint', nameDelta: 'checkpoint_context',
            argumentsDelta: JSON.stringify({
              summaries: prior.turns.filter(t => !t.contextSummary).map(() => 'Offline fixture summary, not a model-generated summary. Prior facts remain in the copied journal.'),
              active_summary: 'Offline fixture summary, not a model-generated summary. Original Tool results remain in history. Execute only offline_probe_only next, never repeat original Tools.',
            }),
          });
          yield modelEvent(request, 2, 'response_completed', { finishReason: 'tool_calls' });
        } else if (!probeToolExecutions) {
          assert.equal(request.messages.some(m => m.name === 'context_checkpoint_resume' && m.role === 'developer'), true);
          assert.equal(request.messages.some(m => m.role === 'tool'), false);
          yield modelEvent(request, 1, 'tool_call_delta', {
            index: 0, toolCallId: 'offline_after_checkpoint', nameDelta: 'offline_probe_only', argumentsDelta: '{}',
          });
          yield modelEvent(request, 2, 'response_completed', { finishReason: 'tool_calls' });
        } else {
          yield modelEvent(request, 1, 'text_delta', { delta: 'Offline continuation probe completed.' });
          yield modelEvent(request, 2, 'response_completed', { finishReason: 'stop' });
        }
      },
    },
  });
  const identity = { requestId: 'offline-probe-' + randomUUID(), sessionId, turnId: failed.turnId };
  eventLog.append(identity, { kind: 'turn_accepted', payload: { status: 'accepted' } });
  eventLog.append(identity, { kind: 'turn_started', payload: { status: 'running' } });
  // Prefix/catalog are intentionally reconstructed, not presented as an exact API replay.
  const prefix = [{ role: 'system', content: 'Offline deterministic checkpoint protocol test.' }];
  const messages = assembleContext({ session: prior, prefix, current: failed.messages.map(item => item.message) }).messages;
  const request = {
    protocol: 'bush.model_request.v1', ...identity, model: 'offline-fixture',
    messages, tools: registry.definitions().filter(tool => ['checkpoint_context', 'offline_probe_only'].includes(tool.name)),
    maxOutputTokens: 12800, metadata: { contextWindowTokens: 256000 },
  };
  new RuntimeRecoveryCoordinator({ eventLog, checkpoints: checkpointStore }).save({
    request, messages, nextRound: 72, cacheChainState: new CacheChainTracker().snapshot(),
    sessionCommit: {
      turnSequence: failed.turnSequence, createdAt: failed.createdAt,
      initialMessageCount: prefix.length + prior.turns.reduce((sum, turn) => sum + turn.messages.length, 0) + 1,
      prefixMessages: prefix, inputMessages: failed.messages.slice(0, 1),
      generatedMessages: failed.messages.slice(1), usage: {},
    },
  });
  const terminal = await host.resumeModelTurn(sessionId, failed.turnId);
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(maintenanceCalls, 1);
  assert.equal(probeToolExecutions, 1);
  assert.equal(requests.length, 3);
  for (const item of requests) assert.deepEqual(item.tools, requests[0].tools);
  const snapshot = sessionStore.snapshot(sessionId);
  const current = snapshot.turns.at(-1);
  assert.equal(current.contextCheckpoint.throughMessageId, originalBoundary);
  assert.deepEqual(current.messages.slice(0, failed.messages.length).map(item => ({ id: item.messageId, message: item.message })),
    failed.messages.map(item => ({ id: item.messageId, message: item.message })));
  assert.equal(snapshot.turns.length, prior.turns.length + 1);
  const executed = eventLog.replay(sessionId, failed.turnId).filter(event => event.kind === 'tool_running');
  assert.deepEqual(executed.map(event => event.payload.toolName), ['offline_probe_only']);
  assert.equal(await readFile(journalPath, 'utf8'), original);
  console.log(JSON.stringify({
    sessionId, turnId: failed.turnId, mode: 'offline scripted provider; reconstructed prefix/catalog',
    authorizedRevision: prior.revision, originalCurrentMessagesPreserved: failed.messages.length,
    precedingTurnsCompacted: prior.turns.length, exactBoundaryBound: true, maintenanceCalls,
    probeToolExecutions, originalProjectToolExecutions: 0, originalJournalUnchanged: true,
  }));
} finally {
  if (host) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  globalThis.fetch = originalFetch;
  const owned = relative(tmpdir(), temporaryRoot);
  assert.ok(!isAbsolute(owned) && owned.startsWith('cardbush-checkpoint-probe-') && !owned.includes(sep));
  await rm(temporaryRoot, { recursive: true, force: true });
  assert.equal(await readFile(journalPath, 'utf8'), original, 'Never modify the source journal.');
}
