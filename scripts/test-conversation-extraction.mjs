import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../packages/bush-runtime/dist/sessionStore.js';
import { InMemoryRuntimeHost, ToolExecutionStore } from '../packages/bush-runtime/dist/index.js';
import { extractSessionSource } from '../packages/bush-runtime/dist/sessionExtraction.js';
import { ConversationExtractStore, extractTokenUpperBound } from '../dist-electron/conversationExtracts.mjs';

const now = '2026-09-19T10:00:00.000Z';
function turn(id, sequence, messages) {
  return { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now, status: 'completed', reason: 'stop', usage: {},
    messages: messages.map((message, index) => ({ messageId: `${id}-${index}`, turnId: id, turnSequence: sequence, messageIndex: index, createdAt: now, message })) };
}
function fixture() {
  const store = new SessionStore(); store.ensureSession('source', { title: '中文会话', goal: 'must not copy', agentRole: 'child' });
  for (let i = 1; i <= 7; i++) store.commitTurn('source', turn(`t${i}`, i, [
    { role: 'user', content: `请求 ${i}` }, { role: 'assistant', content: `回复 ${i}`, reasoningContent: 'PRIVATE_REASONING', toolCalls: [] },
  ]));
  return store;
}
test('default extraction selects five visible turns and prefers committed summaries over final replies', () => {
  const store = fixture(), snapshot = store.snapshot('source');
  store.summarizeTurns({ sessionId: 'source', expectedRevision: snapshot.revision, summaries: [{ turnId: 't7', summary: '完整总结，包括最终答复未覆盖的证据。' }] });
  const source = extractSessionSource(store.snapshot('source'));
  assert.equal(source.defaultKeys.length, 10);
  assert.equal(source.defaultKeys[0], 'user:t3-0');
  assert.equal(source.units.at(-1).text, '完整总结，包括最终答复未覆盖的证据。');
  assert.equal(source.units.at(-1).summarized, true);
  assert.doesNotMatch(JSON.stringify(source), /PRIVATE_REASONING/);
  const selected = extractSessionSource(store.snapshot('source'), ['assistant:t7', 'user:t3-0']);
  assert.deepEqual(selected.units.map(unit => unit.key), ['user:t3-0', 'assistant:t7']);
  assert.throws(() => extractSessionSource(store.snapshot('source'), ['user:missing']), /变更|不存在/);
});
test('incremental checkpoint receipts preserve summaries and post-checkpoint replies without importing other turns', () => {
  const store = fixture(), snapshot = store.snapshot('source');
  const eighth = turn('t8', 8, [{ role: 'user', content: '继续' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'checkpoint_context', argumentsText: '{"updates":[{"source":0,"summary":"last partial"}]}' }] },
    { role: 'tool', toolCallId: 'c', content: JSON.stringify({ summarized_turns: ['t7'], active_turn: { turn_id: 't8' },
      summaries: [{ turn_id: 't7', summary: '第七轮的后台总结' }, { turn_id: 't8', summary: '第八轮检查点的证据' }] }) },
    { role: 'assistant', content: '检查点后新增的结果', toolCalls: [] }]);
  eighth.contextCheckpoint = { projectionVersion: 'exchange_v1', throughMessageId: 't8-2', inputMessageCount: 1,
    exchangeMessageIds: ['t8-1', 't8-2'], coveredTurnIds: ['t7'] };
  eighth.messages[1].metadata = eighth.messages[2].metadata = { runtimeMaintenance: 'context_compaction' };
  const source = extractSessionSource({ ...snapshot, turns: [...snapshot.turns, eighth] });
  assert.equal(source.units.find(unit => unit.key === 'assistant:t7').text, '第七轮的后台总结');
  assert.equal(source.units.at(-1).text, '第八轮检查点的证据\n\n检查点后新增的结果');
});
test('ordered and legacy checkpoints preserve source attribution and filter superseded/internal messages', () => {
  const store = fixture(), snapshot = store.snapshot('source');
  const last = snapshot.turns.at(-1);
  last.contextCheckpoint = { throughMessageId: 't7-1', inputMessageCount: 1, summary: 'legacy evidence' };
  assert.equal(extractSessionSource(snapshot).units.at(-1).text, 'legacy evidence');
  snapshot.supersededMessageIds = ['t7-0', 't7-1'];
  const source = extractSessionSource(snapshot);
  assert.equal(source.defaultKeys[0], 'user:t2-0');
  assert.ok(!source.units.some(unit => unit.turnId === 't7'));
});
test('ordered checkpoint slots use receipt identities and actual user guidance remains selectable', () => {
  const store = fixture(), snapshot = store.snapshot('source');
  const eighth = turn('t8', 8, [{ role: 'user', content: 'initial' },
    { role: 'user', name: 'turn_guidance', content: '用户追加的更正' },
    { role: 'user', name: 'runtime_context', content: 'hidden internal' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'checkpoint_context', argumentsText: JSON.stringify({ summaries: ['第七轮事实', '当前轮的检查点'] }) }] },
    { role: 'tool', toolCallId: 'c', content: JSON.stringify({ summarized_turns: ['t7'], active_turn: { turn_id: 't8' } }) },
    { role: 'assistant', content: '新结论', toolCalls: [] }]);
  eighth.contextCheckpoint = { projectionVersion: 'exchange_v1', throughMessageId: 't8-4', inputMessageCount: 3,
    exchangeMessageIds: ['t8-3', 't8-4'], coveredTurnIds: ['t7'] };
  const source = extractSessionSource({ ...snapshot, turns: [...snapshot.turns, eighth] });
  assert.equal(source.units.find(unit => unit.key === 'assistant:t7').text, '第七轮事实');
  assert.equal(source.units.at(-1).text, '当前轮的检查点\n\n新结论');
  assert.ok(source.units.some(unit => unit.text === '用户追加的更正'));
  assert.ok(!source.units.some(unit => unit.text === 'hidden internal'));
});
test('fork copies committed history independently, preserves summaries and does not inherit runtime authority', () => {
  const store = fixture();
  store.summarizeTurns({ sessionId: 'source', expectedRevision: store.snapshot('source').revision, summaries: [{ turnId: 't1', summary: 'first summary: tool-result://source/t1/call' }] });
  store.supersedeMessages({ sessionId: 'source', messageIds: ['t2-0', 't2-1'], reason: 'replaced' });
  store.ensureSession('fork', { title: 'Fork', workspace_dir: 'new-workspace' });
  const original = store.snapshot('source'), fork = store.fork('source', 'fork');
  assert.equal(fork.turns.length, 7); assert.equal(fork.turns[0].contextSummary, 'first summary: tool-result://fork/t1/call');
  assert.deepEqual(fork.supersededMessageIds, ['t2-0', 't2-1']);
  assert.equal(fork.metadata.goal, undefined); assert.equal(fork.metadata.agentRole, undefined);
  assert.equal(fork.metadata.workspace_dir, 'new-workspace');
  store.commitTurn('fork', turn('new', 8, [{ role: 'user', content: 'new branch' }]));
  assert.deepEqual(store.snapshot('source'), original);
  assert.throws(() => store.fork('source', 'fork'), /empty/);
  assert.throws(() => store.fork('source', 'source'), /different/);
});
test('runtime extraction and fork commands retain tool evidence without executing it or granting source undo actions', async () => {
  const sessions = fixture(), executions = new ToolExecutionStore();
  const call = { protocol: 'bush.tool_call.v1', id: 'call', name: 'read_file', argumentsText: '{}' };
  executions.record(call, { requestId: 'request', sessionId: 'source', turnId: 't1', round: 1, ordinal: 0 }, {
    kind: 'returned', actionManifest: { protocol: 'bush.tool.action_manifest.v1', manifest_id: 'attempt', effect_kind: 'observation',
      operation: 'file.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    result: { text: 'Durable tool evidence' }, workspaceChanges: [{ change_id: 'change', path: 'source.txt', status: 'modified', additions: 1, deletions: 0, metadata: {} }],
  });
  sessions.ensureSession('fork', { title: 'Fork' });
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, toolExecutionStore: executions, provider: { async *stream() { throw new Error('Must not invoke a model.'); } } });
  try {
    const source = await host.sendCommand({ kind: 'runtime.extract_session', payload: { sessionId: 'source', keys: ['assistant:t7'] } });
    assert.equal(source.units.length, 1);
    await host.sendCommand({ kind: 'runtime.fork_session', payload: { sourceSessionId: 'source', sessionId: 'fork' } });
    const record = executions.get('fork', 't1', 'call');
    assert.deepEqual(record.result, { text: 'Durable tool evidence' });
    assert.deepEqual(record.workspaceChanges, []);
    assert.equal(executions.get('source', 't1', 'call').workspaceChanges.length, 1);
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

function withExtractStore(run) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-extract-')), sessions = fixture();
  let clock = 1000;
  const source = async (id, keys) => {
    const snapshot = sessions.snapshot(id); if (!snapshot) throw new Error('source missing');
    return extractSessionSource(snapshot, keys);
  };
  const create = () => new ConversationExtractStore(root, source, { now: () => clock });
  const extracts = create();
  return Promise.resolve().then(() => run({ root, sessions, extracts, create, advance: ms => { clock += ms; } }))
    .finally(() => { extracts.close(); rmSync(root, { recursive: true, force: true }); });
}
const selection = { sessionId: 'source', keys: ['user:t7-0', 'assistant:t7'], title: '', description: '', contextWindowTokens: 16000 };
test('temporary MD is disk-backed, expires at 30 seconds, consumes once and remains readable until exit', () => withExtractStore(async ({ root, extracts, advance }) => {
  const pending = await extracts.save(selection, 'temporary');
  assert.equal(extracts.list().pending.length, 1);
  assert.match(readFileSync(join(root, 'files', `${pending.id}.md`), 'utf8'), /请求 7/);
  advance(29999); extracts.consume(pending.id); assert.equal(extracts.list().pending.length, 0);
  assert.throws(() => extracts.consume(pending.id), /使用/);
  advance(2); assert.ok((await extracts.resolve(pending.id)).path.endsWith('.md'));
  const expired = await extracts.save(selection, 'temporary'); advance(30000);
  assert.equal(extracts.list().pending.length, 0);
  await assert.rejects(extracts.resolve(expired.id), /失效/);
  assert.ok(!readdirSync(join(root, 'files')).includes(`${expired.id}.md`));
}));
test('permanent entries require both fields, store selectors only, survive restart and materialize on demand', () => withExtractStore(async ({ root, extracts, create }) => {
  await assert.rejects(extracts.save(selection, 'permanent'), /标题和描述/);
  await assert.rejects(extracts.save({ ...selection, title: 'title' }, 'permanent'), /标题和描述/);
  const saved = await extracts.save({ ...selection, title: '知识点', description: '描述' }, 'permanent');
  assert.equal(readdirSync(join(root, 'files')).length, 0);
  const db = new DatabaseSync(join(root, 'extracts.sqlite'));
  const row = db.prepare('SELECT selection FROM extracts WHERE id = ?').get(saved.id);
  assert.doesNotMatch(row.selection, /回复 7/); db.close();
  const resolved = await extracts.resolve(saved.id); assert.match(readFileSync(resolved.path, 'utf8'), /回复 7/);
  const temporary = await extracts.save(selection, 'temporary'); extracts.consume(temporary.id);
  extracts.close(); const reopened = create();
  try {
    assert.equal(reopened.list().permanent.length, 1); assert.equal(reopened.list().pending.length, 0);
    assert.equal(readdirSync(join(root, 'files')).length, 0);
    await assert.rejects(reopened.resolve(temporary.id), /失效/);
    assert.ok((await reopened.resolve(saved.id)).path);
  } finally { reopened.close(); }
}));
test('budgets count multilingual markdown framing, reject overflow and revalidate against a smaller model', () => withExtractStore(async ({ extracts }) => {
  assert.equal(extractTokenUpperBound('中文🙂'), 10);
  const preview = await extracts.preview(selection);
  assert.equal(preview.tokenLimit, 4000);
  const item = await extracts.save(selection, 'reference');
  const resolved = await extracts.resolve(item.id);
  assert.equal(resolved.tokens, preview.overheadTokens + preview.source.units.filter(unit => selection.keys.includes(unit.key)).reduce((n, unit) => n + unit.tokens, 0));
  await assert.rejects(extracts.resolve(item.id, resolved.tokens * 4 - 4), /超过|四分之一/);
  await assert.rejects(extracts.save({ ...selection, contextWindowTokens: resolved.tokens * 4 - 4 }, 'temporary'), /超过/);
  await assert.rejects(extracts.save({ ...selection, keys: [] }, 'reference'), /至少/);
}));
test('dragged session references freeze their selection, deduplicate and remain usable after restart without duplicating text', () => withExtractStore(async ({ extracts, create, sessions }) => {
  const reference = await extracts.save(selection, 'reference');
  assert.equal((await extracts.save(selection, 'reference')).id, reference.id);
  sessions.commitTurn('source', turn('t8', 8, [{ role: 'user', content: 'Later self reference must not recurse into its own input' }]));
  extracts.close(); const reopened = create();
  try {
    assert.equal(reopened.list().permanent.length, 0, 'a direct reference does not bypass named-library requirements');
    const resolved = await reopened.resolve(reference.id);
    assert.doesNotMatch(readFileSync(resolved.path, 'utf8'), /Later self reference/);
  } finally { reopened.close(); }
}));
test('MD export handles cancellation and destination writes; source deletion invalidates bookmarks', () => withExtractStore(async ({ root, extracts, sessions }) => {
  assert.deepEqual(await extracts.export(selection, async () => undefined), { cancelled: true });
  const destination = join(root, 'export.md'); await extracts.export(selection, async () => destination);
  assert.match(readFileSync(destination, 'utf8'), /历史资料/);
  const saved = await extracts.save({ ...selection, title: 'title', description: 'description' }, 'permanent');
  sessions.deleteSession('source'); await assert.rejects(extracts.resolve(saved.id), /missing/);
}));
