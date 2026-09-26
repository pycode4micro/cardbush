import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, appendFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, FileToolExecutionPersistence, SessionStore, FileSessionEventPersistence } from '../dist/index.js';
import { EXECUTION_HISTORY_TOOL, EXECUTION_HISTORY_SUMMARY_VERSION, executionHistoryScope, registerExecutionHistoryTool, summarizeExecution } from '../dist/executionHistory.js';
import { collectUnreferencedCache } from '../dist/cacheMaintenance.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const now = '2026-09-18T08:00:00.000Z';
const query = { keywords: ['verify_4k', '补漏'], description: '查找之前抽查头部遮罩覆盖的执行记录' };
const createRecord = (store, id, sessionId = 'one', options = {}) => store.record({ protocol: 'bush.tool_call.v1', id,
  name: options.tool ?? 'terminal_exec', argumentsText: JSON.stringify({ command: options.command ?? `python verify_4k.py --补漏 ${id}`, ...(options.args ?? {}) }) },
  { requestId: id, sessionId, turnId: `turn_${id}`, round: 1, ordinal: 0 },
  { kind: options.outcome ?? 'returned', result: { stdout: options.output ?? '检查 138 帧；仍需目视抽查', ...(options.result ?? {}) },
    workspaceChanges: options.changes ?? [], ...(options.error ? { error: options.error } : {}) });
const attach = (store, listSessions) => {
  const registry = new ToolRegistry();
  registerExecutionHistoryTool(registry, store, listSessions);
  const tool = registry.resolve(EXECUTION_HISTORY_TOOL);
  return { tool, search: (input = query, sessionId = 'one', signal) => tool.execute({ sessionId, input: tool.decodeInput(input), signal }) };
};
async function disk(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-execution-history-'));
  const handles = [];
  const open = () => { const file = new FileToolExecutionPersistence({ root }); handles.push(file); return file; };
  t.after(async () => {
    handles.forEach(file => file.close());
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes('cardbush-execution-history-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, open };
}

test('search uses 1–3 clues plus a sentence and returns bounded summaries, not full payloads', async () => {
  const store = new ToolExecutionStore({ now: () => now });
  const saved = createRecord(store, 'mask', 'one', {
    args: { content: 'SECRET_FILE_BODY'.repeat(500) },
    result: { success: false, content: [{ type: 'image', data: 'PRIVATE_IMAGE'.repeat(1000) }], enormous: 'PRIVATE_NATIVE'.repeat(1000) },
    changes: [{ change_id: 'change', path: 'mask.py', status: 'modified', metadata: { diff: 'SECRET_DIFF'.repeat(1000) } }],
  });
  const { search, tool } = attach(store, async () => [{ sessionId: 'one', metadata: {} }]);
  const page = await search({ keywords: ['verify_4k', 'unmatched', '不存在'], description: query.description });
  assert.equal(page.results.length, 1, 'clues are fuzzy candidates, not mandatory AND filters');
  assert.equal(page.results[0].recorded_at, now);
  assert.equal(page.results[0].outcome, 'returned');
  assert.match(page.results[0].summary, /success: false/);
  assert.deepEqual(page.results[0].matched_keywords, ['verify_4k']);
  assert.ok(page.results[0].summary.length <= 640);
  assert.doesNotMatch(JSON.stringify(page), /SECRET_FILE_BODY|PRIVATE_IMAGE|PRIVATE_NATIVE|SECRET_DIFF/);
  assert.deepEqual(store.get('one', 'turn_mask', 'mask'), saved);
  for (const input of [
    { ...query, keywords: [] }, { ...query, keywords: ['a', 'b', 'c', 'd'] }, { ...query, keywords: [' '] },
    { ...query, description: '' }, { ...query, description: 'two\nlines' }, { ...query, offset: -1 }, { ...query, full: true },
  ]) assert.throws(() => tool.decodeInput(input), /1–3/);
});

test('scope includes only the same project; projectless queries stay in their own conversation', async () => {
  const store = new ToolExecutionStore({ now: () => now });
  const sessions = [
    { sessionId: 'one', metadata: { projectDir: 'C:\\repo\\cardbush' } },
    { sessionId: 'two', metadata: { runtimeWorkspace: { sourceDir: 'c:/repo/cardbush/', workspaceDir: 'C:/worktrees/two' } } },
    { sessionId: 'outside', metadata: { projectDir: 'C:/repo/cardbush-other' } },
    { sessionId: 'loose', metadata: { workspace_dir: 'C:/tasks/one' } },
    { sessionId: 'another_loose', metadata: { workspace_dir: 'C:/tasks/one' } },
  ];
  const ids = new Map(sessions.map(session => [session.sessionId, summarizeExecution(createRecord(store, session.sessionId, session.sessionId)).id]));
  const { search } = attach(store, async () => sessions);
  assert.equal((await search()).scope, 'project');
  assert.deepEqual(new Set((await search()).results.map(item => item.record_id)), new Set([ids.get('one'), ids.get('two')]));
  assert.deepEqual((await search(query, 'loose')).results.map(item => item.record_id), [ids.get('loose')]);
  sessions.splice(1, 1);
  assert.deepEqual((await search()).results.map(item => item.record_id), [ids.get('one')], 'deleted session records cannot reappear');
  const posix = [{ sessionId: 'a', metadata: { projectDir: '/repo/One' } }, { sessionId: 'b', metadata: { projectDir: '/repo/one' } }];
  assert.deepEqual(executionHistoryScope(posix, 'a').sessions.map(item => item.sessionId), ['a']);
});

test('plugin receipts retain nested identifying arguments and structured result facts', async () => {
  const store = new ToolExecutionStore({ now: () => now });
  createRecord(store, 'plugin', 'one', { tool: 'mcp_call', command: '', output: '',
    args: { name: 'stylize_video', arguments: { path: 'head_regions.mp4', content: 'PRIVATE_BODY'.repeat(1000) } },
    result: { structuredContent: { success: false, summary: '帽檐处还有缺口，等待抽查', frames: 'PRIVATE_FRAMES'.repeat(1000) } },
  });
  const { search } = attach(store, async () => [{ sessionId: 'one', metadata: {} }]);
  const page = await search({ keywords: ['head_regions.mp4'], description: '查找视频插件的头部区域处理' });
  assert.equal(page.results.length, 1);
  assert.match(page.results[0].summary, /success: false/);
  assert.match(page.results[0].summary, /stylize_video.*head_regions\.mp4.*帽檐处还有缺口/);
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE_BODY|PRIVATE_FRAMES/);
});

test('Chinese text matches locally; pagination is stable and queries do not retrieve themselves', async () => {
  const store = new ToolExecutionStore({ now: () => now });
  for (let index = 0; index < 8; index++) createRecord(store, `mask_${index}`);
  createRecord(store, 'self', 'one', { tool: EXECUTION_HISTORY_TOOL });
  createRecord(store, 'irrelevant', 'one', { command: 'npm install', output: 'installed packages' });
  const { search } = attach(store, async () => [{ sessionId: 'one', metadata: {} }]);
  const first = await search({ keywords: ['补漏'], description: '头部遮罩抽查' });
  const second = await search({ keywords: ['补漏'], description: '头部遮罩抽查', offset: first.next_offset });
  assert.equal(first.total_matches, 8);
  assert.equal(first.results.length, 5);
  assert.equal(second.results.length, 3);
  assert.equal(second.next_offset, null);
  assert.equal(new Set([...first.results, ...second.results].map(item => item.record_id)).size, 8);
  assert.deepEqual(await search({ keywords: ['补漏'], description: '头部遮罩抽查' }), first);
  assert.equal((await search({ keywords: ['qzxv_missing'], description: 'qzxv_missing' })).total_matches, 0);
});

test('restart and incremental indexing use excerpts without loading complete execution arrays', async t => {
  const f = await disk(t);
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'legacy');
  const journal = join(f.root, `${hash('one')}.jsonl`);
  await writeFile(journal, JSON.stringify({ protocol: 'bush.tool_execution_journal_record.v1', checksum: hash(JSON.stringify(record)), record }) + '\n');
  let persistence = f.open();
  persistence.load = () => { throw new Error('full journal load is forbidden for search'); };
  assert.equal((await new ToolExecutionStore({ persistence }).historySummaries('one')).entries.length, 1);
  persistence.close();
  persistence = f.open();
  const large = createRecord(new ToolExecutionStore({ now: () => now }), 'large', 'one', { result: { private: 'x'.repeat(17 * 1024 * 1024) } });
  persistence.append(large);
  persistence.load = () => { throw new Error('full journal load is forbidden for search'); };
  const page = await new ToolExecutionStore({ persistence }).historySummaries('one');
  assert.equal(page.entries.length, 2);
  assert.equal(page.omitted, 0, 'large new records use their separately stored summary header');
  assert.ok((await readFile(journal + '.history')).length < 5000);
  await writeFile(journal + '.history', '{broken index');
  assert.deepEqual(await persistence.historySummaries('one'), page, 'derived index can be rebuilt');
  await appendFile(journal, '{"incomplete":');
  assert.deepEqual(await persistence.historySummaries('one'), page, 'uncommitted tail never becomes a false execution');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(persistence.historySummaries('one', controller.signal), /abort/i);
  assert.deepEqual(await persistence.historySummaries('one'), page);
});

test('derived history indexes are reclaimed with their session journals', async t => {
  const f = await disk(t), persistence = f.open();
  const store = new ToolExecutionStore({ persistence, now: () => now });
  createRecord(store, 'keep', 'keep'); createRecord(store, 'gone', 'gone');
  await store.historySummaries('keep'); await store.historySummaries('gone');
  const result = await collectUnreferencedCache(await store.cacheEntries(), ['keep']);
  assert.deepEqual(result.errors, []);
  assert.ok((await readdir(f.root)).includes(`${hash('keep')}.jsonl.history`));
  assert.equal((await readdir(f.root)).some(name => name.startsWith(hash('gone'))), false);
});

test('viewing a project history summary does not keep another deleted conversation alive', async t => {
  const f = await disk(t), persistence = f.open();
  const store = new ToolExecutionStore({ persistence, now: () => now });
  createRecord(store, 'mask', 'deleted-conversation');
  const sessions = ['live-conversation', 'deleted-conversation'].map(sessionId => ({ sessionId, metadata: { projectDir: 'C:/project' } }));
  const { search } = attach(store, async () => sessions);
  const result = await search(query, 'live-conversation');
  assert.equal(result.results.length, 1);
  store.record({ protocol: 'bush.tool_call.v1', id: 'search', name: EXECUTION_HISTORY_TOOL, argumentsText: JSON.stringify(query) },
    { requestId: 'search', sessionId: 'live-conversation', turnId: 'current-turn', round: 1, ordinal: 0 },
    { kind: 'returned', result, workspaceChanges: [] });
  const cleaned = await collectUnreferencedCache(await store.cacheEntries(), ['live-conversation', result]);
  assert.deepEqual(cleaned.errors, []);
  assert.equal((await readdir(f.root)).some(name => name.startsWith(hash('deleted-conversation'))), false);
});

test('oversized legacy receipts report omissions and corrupt summary headers fail explicitly', async t => {
  const f = await disk(t), persistence = f.open();
  const journal = join(f.root, `${hash('one')}.jsonl`);
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'old', 'one', { result: { private: 'x'.repeat(17 * 1024 * 1024) } });
  await writeFile(journal, JSON.stringify({ protocol: 'bush.tool_execution_journal_record.v1', checksum: hash(JSON.stringify(record)), record }) + '\n');
  const { search } = attach(new ToolExecutionStore({ persistence }), async () => [{ sessionId: 'one', metadata: {} }]);
  const page = await search();
  assert.equal(page.total_matches, 0);
  assert.equal(page.unindexed_oversized_records, 1);
  const current = createRecord(new ToolExecutionStore({ now: () => now }), 'new');
  const history = summarizeExecution(current);
  await appendFile(journal, JSON.stringify({ protocol: 'bush.tool_execution_journal_record.v1', checksum: hash(JSON.stringify(current)),
    history, historyChecksum: 'invalid', record: current }) + '\n');
  await assert.rejects(search(), /checksum or identity mismatch/);
});

test('project lookup reads metadata without projecting full saved conversation payloads', async t => {
  const f = await disk(t);
  const persistence = new FileSessionEventPersistence({ root: f.root });
  t.after(() => persistence.close());
  const store = new SessionStore({ persistence });
  store.ensureSession('one', { projectDir: 'C:/repo/project' });
  store.ensureSession('two', { projectDir: 'C:/repo/elsewhere' });
  persistence.load = () => { throw new Error('full conversation load is forbidden for search scope'); };
  const reopened = new SessionStore({ persistence });
  let entries = await reopened.listMetadata();
  assert.equal(entries.length, 2);
  assert.equal(entries.find(item => item.sessionId === 'one').metadata.projectDir, 'C:/repo/project');
  store.updateMetadata({ sessionId: 'two', expectedRevision: store.snapshot('two').revision, metadata: { projectDir: 'C:/repo/project' } });
  entries = await reopened.listMetadata();
  assert.equal(executionHistoryScope(entries, 'one').sessions.length, 2);
  store.deleteSession('two');
  assert.deepEqual((await reopened.listMetadata()).map(item => item.sessionId), ['one']);
});

test('history tool is available through the normal model tool loop and returns only summaries', async t => {
  const store = new ToolExecutionStore({ now: () => now });
  createRecord(store, 'earlier');
  const registry = new ToolRegistry(), seen = [];
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, toolExecutionStore: store, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      seen.push(structuredClone(request));
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: now };
      if (seen.length === 1) {
        yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'search', nameDelta: EXECUTION_HISTORY_TOOL, argumentsDelta: JSON.stringify(query) };
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
      } else {
        yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Found the recorded receipt.' };
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
      }
    } },
  });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'history', sessionId: 'one', turnId: 'search_turn', model: 'fixture',
    prefixMessages: [{ role: 'system', content: 'Use available tools.' }], inputMessages: [{ messageId: 'user', message: { role: 'user', content: '之前什么时候检查过？' } }],
    tools: registry.definitions().filter(tool => tool.name === EXECUTION_HISTORY_TOOL), permissionMode: 'task_free', requestCapabilities: {}, metadata: {} });
  assert.equal(terminal.payload.status, 'completed');
  const result = JSON.parse(seen.at(-1).messages.find(message => message.role === 'tool' && message.toolCallId === 'search').content);
  assert.equal(result.results[0].recorded_at, now);
  assert.equal(result.results[0].tool, 'terminal_exec');
  assert.ok(result.results[0].summary.length <= 640);
  assert.deepEqual(seen.at(-1).messages.slice(0, seen[0].messages.length), seen[0].messages);
});

test('failed and cancelled receipts keep their factual status in concise summaries', () => {
  for (const outcome of ['failed', 'cancelled']) {
    const store = new ToolExecutionStore({ now: () => now });
    const record = createRecord(store, outcome, 'one', { outcome, error: { kind: 'tool', code: 'stopped', message: '任务未执行完成', details: {} } });
    const summary = summarizeExecution(record);
    assert.equal(summary.outcome, outcome);
    assert.match(summary.summary, /stopped.*任务未执行完成/);
  }
});

test('file summaries preserve saved purposes and points while bounding long paths and private payloads', () => {
  const store = new ToolExecutionStore({ now: () => now });
  const args = { path: 'C:/' + 'project/'.repeat(50) + 'cut_v2_clean.mp4', purpose: '视频定稿，底部文字修补',
    points: ['720x1280 / 24fps / 10.08s，AAC 人声旁白', '第4段为灰底白条纹开衫', '底部小字已抹除'], content: 'PRIVATE_BODY'.repeat(1000) };
  const record = createRecord(store, 'notes', 'one', { tool: 'remember_file', command: '', output: '', args });
  const snapshot = structuredClone(record);
  const fromArgs = summarizeExecution(record);
  assert.match(fromArgs.summary, /cut_v2_clean\.mp4.*purpose: 视频定稿.*points: .*720x1280.*第4段.*底部小字/);
  assert.ok(fromArgs.summary.length <= 640);
  assert.doesNotMatch(fromArgs.summary, /PRIVATE_BODY/);
  assert.equal(fromArgs.summaryVersion, EXECUTION_HISTORY_SUMMARY_VERSION);
  const fromNote = summarizeExecution({ ...record, result: { structuredContent: { note: {
    purpose: '已保存的用途', points: ['原始核查要点'], private: 'PRIVATE_NOTE'.repeat(1000),
  } } } });
  assert.match(fromNote.summary, /purpose: 已保存的用途; points: 原始核查要点/);
  assert.doesNotMatch(fromNote.summary, /视频定稿|PRIVATE_NOTE/);
  assert.deepEqual(record, snapshot, 'extracting summaries must never rewrite execution facts');
});

const legacyEnvelope = (record, summary) => {
  const history = { ...summarizeExecution(record), summary };
  delete history.summaryVersion;
  return { protocol: 'bush.tool_execution_journal_record.v1', checksum: hash(JSON.stringify(record)),
    history, historyChecksum: hash(JSON.stringify(history)), record };
};

test('old summary headers and a valid v1 index are upgraded without rewriting the source journal', async t => {
  const f = await disk(t), persistence = f.open();
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'old-notes', 'one', {
    tool: 'remember_file', args: { path: 'cut_v2_clean.mp4', purpose: '视频定稿', points: ['AAC 人声旁白'] },
  });
  const envelope = legacyEnvelope(record, 'path: cut_v2_clean.mp4');
  const journal = join(f.root, `${hash('one')}.jsonl`);
  const bytes = Buffer.from(JSON.stringify(envelope) + '\n');
  await writeFile(journal, bytes);
  const source = await stat(journal);
  const index = { version: 1, sessionId: 'one', through: source.size, mtimeMs: source.mtimeMs,
    prefix: hash(bytes.subarray(0, 4096)), entries: [envelope.history], omitted: 0 };
  await writeFile(journal + '.history', JSON.stringify({ checksum: hash(JSON.stringify(index)), index }));
  persistence.load = () => { throw new Error('migration cannot load the complete journal'); };
  const page = await persistence.historySummaries('one');
  assert.equal(page.entries.length, 1);
  assert.match(page.entries[0].summary, /purpose: 视频定稿; points: AAC 人声旁白/);
  assert.equal(page.entries[0].id, envelope.history.id);
  assert.equal(page.entries[0].summaryVersion, EXECUTION_HISTORY_SUMMARY_VERSION);
  assert.equal(JSON.parse(await readFile(journal + '.history', 'utf8')).index.version, EXECUTION_HISTORY_SUMMARY_VERSION);
  assert.deepEqual(await persistence.historySummaries('one'), page, 'warm reads expose no internal index metadata');
  assert.deepEqual(await readFile(journal), bytes);
});

test('oversized old records retain their checked excerpt and report that it could not be refreshed', async t => {
  const f = await disk(t), persistence = f.open();
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'old-large', 'one', {
    result: { private: 'x'.repeat(17 * 1024 * 1024) },
  });
  const envelope = legacyEnvelope(record, 'command: verify_4k.py --补漏; success: false');
  const journal = join(f.root, `${hash('one')}.jsonl`);
  const serialized = JSON.stringify(envelope) + '\n';
  await writeFile(journal, serialized);
  const { search } = attach(new ToolExecutionStore({ persistence }), async () => [{ sessionId: 'one', metadata: {} }]);
  const page = await search();
  assert.equal(page.unrefreshed_summaries, 1);
  assert.equal(page.unindexed_oversized_records, undefined);
  assert.equal(page.results[0].summary, envelope.history.summary);
  assert.deepEqual(await search(), page);
  assert.equal(hash(await readFile(journal)), hash(serialized));
});

test('migrating a valid old summary still checks its bounded raw record checksum', async t => {
  const f = await disk(t), persistence = f.open();
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'tampered');
  const envelope = legacyEnvelope(record, 'command: verify_4k.py --补漏');
  envelope.record.result.stdout = 'modified without updating the checksum';
  await writeFile(join(f.root, `${hash('one')}.jsonl`), JSON.stringify(envelope) + '\n');
  await assert.rejects(persistence.historySummaries('one'), /journal checksum mismatch/);
});

test('history locators read exact evidence only in the current live project', async t => {
  const store = new ToolExecutionStore(), sessions = new SessionStore(), registry = new ToolRegistry();
  sessions.ensureSession('one', { projectDir: 'C:/same' }); sessions.ensureSession('two', { projectDir: 'C:/same' });
  sessions.ensureSession('outside', { projectDir: 'C:/elsewhere' });
  createRecord(store, 'cross', 'two', { output: 'exact evidence: 中文😀' });
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, toolRegistry: registry, toolExecutionStore: store, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const search = registry.resolve(EXECUTION_HISTORY_TOOL);
  const page = await search.execute({ sessionId: 'one', input: search.decodeInput(query) });
  const locator = page.results[0].locator;
  assert.match(locator, /^tool-result:\/\/history\/[a-f0-9]{64}$/);
  const reader = registry.resolve('read_archived_tool_result');
  const read = (sessionId, value = locator) => reader.execute({ sessionId, input: reader.decodeInput({ locator: value }) });
  assert.match((await read('one')).text, /exact evidence: 中文😀/);
  await assert.rejects(read('outside'), /outside/);
  await assert.rejects(read('outside', 'tool-result://two/turn_cross/cross'), /outside/);
  sessions.deleteSession('two');
  await assert.rejects(read('one'), /deleted/);
});

test('v2 summary migration adds locators without rewriting the journal', async t => {
  const f = await disk(t), persistence = f.open();
  const record = createRecord(new ToolExecutionStore({ now: () => now }), 'v2');
  const history = { ...summarizeExecution(record), summaryVersion: 2 }; delete history.toolCallId;
  const row = { protocol: 'bush.tool_execution_journal_record.v1', checksum: hash(JSON.stringify(record)), history, historyChecksum: hash(JSON.stringify(history)), record };
  const path = join(f.root, `${hash('one')}.jsonl`), original = JSON.stringify(row) + '\n';
  await writeFile(path, original);
  const page = await persistence.historySummaries('one');
  assert.equal(page.entries[0].summaryVersion, EXECUTION_HISTORY_SUMMARY_VERSION);
  assert.equal(page.entries[0].toolCallId, 'v2');
  assert.equal(await readFile(path, 'utf8'), original);
});
