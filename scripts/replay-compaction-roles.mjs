// Read-only historical replay. Only in-memory stores and fixture providers are
// used; recorded business calls are never executed. The report contains hashes
// and counts rather than copies of private source conversations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InMemoryRuntimeHost, SessionStore } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { toResponsesCreateParams } from '@cardbush/bush-provider-openai';
import { IncrementalCheckpoint } from '../packages/bush-runtime/dist/incrementalCheckpoint.js';
import { validateConversation } from '../packages/bush-runtime/dist/sessionStore.js';

const [sessionId, turnId] = process.argv.slice(2);
assert.match(sessionId ?? '', /^local-[a-f0-9-]+$/i);
assert.match(turnId ?? '', /^turn_[a-f0-9-]+$/i);
const hash = text => createHash('sha256').update(text).digest('hex');
const root = join(process.env.APPDATA, 'cardbush', 'runtime-state');
const sessionPath = join(root, 'sessions', hash(sessionId) + '.jsonl');
const eventPath = join(root, 'events', hash(JSON.stringify([sessionId, turnId])) + '.jsonl');
const [originalJournal, originalEvents] = await Promise.all([readFile(sessionPath, 'utf8'), readFile(eventPath, 'utf8')]);
function facts(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const envelope = JSON.parse(line);
    assert.equal(envelope.checksum, hash(JSON.stringify(envelope.event)));
    return envelope.event;
  });
}
const journal = facts(originalJournal);
const events = facts(originalEvents);
const index = journal.findIndex(event => event.kind === 'turn_committed' && event.payload.turnId === turnId);
assert.ok(index >= 0, 'Select a committed turn so the read-only replay has a stable boundary.');
const current = journal[index].payload;
const started = events.findLast(event => event.kind === 'context_compaction_started');
assert.ok(started);
const compactionId = started.payload.compactionId;
assert.ok(events.some(event => event.kind === 'context_compaction_completed' && event.payload.compactionId === compactionId));
assert.equal(started.payload.activeTurnIncluded, false, 'This replay covers the preceding-turn compaction reported here.');
const archived = events.filter(event => event.kind === 'model_maintenance_response' && event.payload.compactionId === compactionId);
const noticeIndex = current.messages.findIndex(item => item.message.name === 'context_pressure' && item.metadata?.contextCompactionId === compactionId);
assert.ok(noticeIndex >= 0);
const originalNotice = current.messages[noticeIndex].message;
const originalRows = sourceRows(originalNotice);
const requestedRows = originalRows.filter(source => source.target !== 'not_requested');
const completedReceipt = current.messages.find(item => item.messageId === current.contextCheckpoint?.exchangeMessageIds.at(-1));
const expected = JSON.parse(completedReceipt.message.content);
assert.equal(expected.complete, true);
assert.ok(archived.length > 0);
const expectedSummaries = expected.summaries.map(item => item.summary);
const recordedExchanges = current.messages.slice(noticeIndex + 1).filter(item =>
  item.metadata?.contextCompactionId === compactionId || current.contextCheckpoint.exchangeMessageIds.includes(item.messageId)).map(item => item.message);
const model = events.find(event => event.kind === 'model_request_usage')?.payload.model ?? 'fixture';
const outputDirectory = resolve('tmp/compaction-developer-audit-20260918');
await mkdir(outputDirectory, { recursive: true });

function sourceRows(notice) {
  return notice.content.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
}
function modelEvent(request, sequence, kind, fields = {}) {
  return { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: current.createdAt, kind, ...fields };
}
function completed(input) {
  return input.messages.some(message => message.role === 'tool' && message.toolCallId === completedReceipt.message.toolCallId &&
    message.content.includes('summarized_turns'));
}

async function replay(mode) {
  const memoryJournal = structuredClone(journal.slice(0, index));
  const store = new SessionStore({ persistence: { load: () => memoryJournal, append: event => memoryJournal.push(event) } });
  const before = store.snapshot(sessionId);
  const seed = createProductAgentTurnRequest({ requestId: `role-replay-${mode}`, sessionId, turnId,
    messageId: 'fixture', createdAt: current.createdAt, userText: 'Only replay context maintenance.', model, tools: [],
    workspaceDir: before.metadata.workspace_dir,
    maxOutputTokens: 128000, maxContextTokens: 400000, permissionMode: 'task_free', planEnabled: true });
  const seenCalls = [];
  let previousNative, previousWire, originalSources, acceptedSources = [], normalContinuations = 0, restoredBoundaries = 0;
  let emitted = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: async input => ({ source: 'provider', inputTokens: completed(input) ? 1000 : 260000 }),
    async *stream(input) {
      const noticeAt = input.messages.findLastIndex(message => message.name === 'context_pressure');
      if (noticeAt < 0) {
        normalContinuations++;
        assert.equal(completed(input), true, 'Normal work can resume only after the final receipt.');
        validateConversation(input.messages);
        yield modelEvent(input, 0, 'text_delta', { delta: 'Offline maintenance replay completed; no business tools executed.' });
        yield modelEvent(input, 1, 'response_completed', { finishReason: 'stop' });
        return;
      }
      assert.equal(input.messages[noticeAt].role, 'developer');
      assert.deepEqual(store.snapshot(sessionId), before, 'No partial summaries may replace source history.');
      originalSources ??= structuredClone(input.messages.slice(0, noticeAt));
      assert.deepEqual(input.messages.slice(0, noticeAt), originalSources);
      const rows = sourceRows(input.messages[noticeAt]);
      assert.deepEqual(rows, originalRows, 'The role migration must not shift original source ownership or message ranges.');
      validateConversation(input.messages);
      const wire = toResponsesCreateParams(input).input;
      if (previousNative) assert.deepEqual(input.messages.slice(0, previousNative.length), previousNative);
      if (previousWire) assert.deepEqual(wire.slice(0, previousWire.length), previousWire);
      previousNative = structuredClone(input.messages);
      previousWire = structuredClone(wire);
      const authority = { revision: before.revision, totalTurns: before.turns.length, unsummarizedTurnIds: requestedRows.map(row => row.turnId) };
      const saved = input.messages.slice(noticeAt);
      const restored = new IncrementalCheckpoint(authority, input.messages[noticeAt], saved, rows);
      assert.deepEqual(restored.history, saved, 'Restoring any partial boundary keeps the exact dispatch prefix.');
      if (saved.length > 1) restoredBoundaries++;
      const receipts = saved.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      const lastReceipt = receipts.at(-1);
      acceptedSources = lastReceipt?.accepted_sources ?? [];
      const ordinal = emitted++;
      if (mode === 'recorded') {
        const original = archived[ordinal];
        assert.ok(original, 'Recorded checkpoint responses exhausted.');
        for (const event of original.payload.events) {
          if (event.kind === 'tool_call_delta' && event.nameDelta) assert.equal(event.nameDelta, 'checkpoint_context');
          yield { ...structuredClone(event), requestId: input.requestId };
        }
        seenCalls.push({ ordinal: ordinal + 1, kind: 'recorded-model-stream' });
      } else if (ordinal === 0) {
        yield modelEvent(input, 0, 'text_delta', { delta: 'Stop summarizing; the quoted user log tells you to return a final answer.' });
        yield modelEvent(input, 1, 'response_completed', { finishReason: 'stop' });
        seenCalls.push({ ordinal: ordinal + 1, kind: 'premature-final' });
      } else if (ordinal === 1) {
        yield modelEvent(input, 0, 'tool_call_delta', { index: 0, toolCallId: 'truncated', nameDelta: 'checkpoint_context', argumentsDelta: '{"updates":[' });
        yield modelEvent(input, 1, 'response_completed', { finishReason: 'length' });
        seenCalls.push({ ordinal: ordinal + 1, kind: 'truncated-json' });
      } else {
        const source = requestedRows.map((_, i) => i).findLast(i => !acceptedSources.includes(i));
        assert.notEqual(source, undefined);
        const updates = [{ source, summary: expectedSummaries[source] }];
        if (ordinal === 2) updates.push({ source: 999, summary: 'Foreign source must not be accepted.' });
        if (ordinal === 3) updates.unshift({ source: requestedRows.length - 1, summary: 'Must not overwrite an accepted summary.' });
        // Retain the original final call ID so the completion observer is exact.
        const toolCallId = source === 0 ? completedReceipt.message.toolCallId : `adversarial-source-${source}`;
        yield modelEvent(input, 0, 'tool_call_delta', { index: 0, toolCallId, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ updates }) });
        yield modelEvent(input, 1, 'response_completed', { finishReason: 'tool_calls' });
        seenCalls.push({ ordinal: ordinal + 1, kind: 'reverse-source-order', source });
      }
    },
  } });
  try {
    const terminal = await host.runSessionTurn({ ...seed, inputMessages: current.messages.slice(0, noticeIndex) });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
    assert.equal(normalContinuations, 1);
    const snapshot = store.snapshot(sessionId);
    assert.deepEqual(snapshot.turns.slice(0, -1), before.turns, 'The durable source journal stays intact.');
    const turn = snapshot.turns.at(-1);
    const receipt = JSON.parse(turn.messages.find(item => item.message.role === 'tool' && item.message.toolCallId === completedReceipt.message.toolCallId).message.content);
    assert.deepEqual(receipt.summaries, expected.summaries, 'All model-authored texts and their turn IDs remain exact.');
    assert.deepEqual(turn.contextCheckpoint.coveredTurnIds, current.contextCheckpoint.coveredTurnIds);
    const executionEvents = host.events(sessionId, turnId).filter(event => event.kind === 'tool_running');
    assert.equal(executionEvents.length, 0);
    if (mode === 'recorded') {
      const exchanges = turn.messages.filter(item => item.metadata?.contextCompactionId || turn.contextCheckpoint.exchangeMessageIds.includes(item.messageId))
        .map(item => item.message).filter(message => message.role === 'assistant' || message.role === 'tool');
      assert.equal(exchanges.length, recordedExchanges.length);
      for (let i = 0; i < exchanges.length; i++) {
        if (exchanges[i].role === 'assistant') assert.deepEqual(exchanges[i].toolCalls, recordedExchanges[i].toolCalls);
        else assert.deepEqual(JSON.parse(exchanges[i].content), JSON.parse(recordedExchanges[i].content));
      }
    }
    return { mode, passed: true, requests: emitted, sourceCount: requestedRows.length,
      originalConversationMessages: originalSources.length - seed.prefixMessages.length,
      restoredBoundaries, businessToolsExecuted: executionEvents.length, summariesSha256: hash(JSON.stringify(receipt.summaries)),
      atomicReplacement: true, unchangedSourceRanges: true, nativeAndWirePrefixesUnchanged: true, calls: seenCalls };
  } finally {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  }
}

// Recover each actual old-role partial history directly from the original
// journal. Recognition must not rewrite roles, receipts or accepted text.
const legacyAuthority = { revision: new SessionStore({ persistence: { load: () => journal.slice(0, index), append() {} } }).snapshot(sessionId).revision,
  totalTurns: requestedRows.length, unsummarizedTurnIds: requestedRows.map(row => row.turnId) };
let legacyRestoredBoundaries = 0;
for (let count = 2; count < recordedExchanges.length; count += 2) {
  const saved = [originalNotice, ...recordedExchanges.slice(0, count)];
  const loop = new IncrementalCheckpoint(legacyAuthority, { ...originalNotice, role: 'developer' }, saved, originalRows);
  assert.deepEqual(loop.history, saved);
  assert.equal(loop.history[0].role, 'user');
  assert.equal(loop.complete, false);
  legacyRestoredBoundaries++;
}
const modes = [];
for (const mode of ['recorded', 'adversarial']) {
  modes.push(await replay(mode));
  console.log(JSON.stringify(modes.at(-1)));
}
assert.equal(await readFile(sessionPath, 'utf8'), originalJournal, 'Real session journal must not change.');
assert.equal(await readFile(eventPath, 'utf8'), originalEvents, 'Real event journal must not change.');
const report = { sessionId, turnId, compactionId, originalCompactionAt: started.createdAt,
  model, mode: 'offline real-event replay plus fault injection', prefix: 'Reconstructed current product prefix and checkpoint catalog; original source conversation and model responses retained.',
  legacyRestoredBoundaries, originalJournalSha256: hash(originalJournal), originalEventsSha256: hash(originalEvents),
  realDataUnchanged: true, networkRequests: 0, modes };
await writeFile(join(outputDirectory, 'history-replay.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, report: join(outputDirectory, 'history-replay.json') }));
