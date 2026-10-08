import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { assistantProfileSchema, normalizeIndividuation, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { AssistantMemory } from '../dist/assistantMemory.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { IndividuationMemory } from '../dist/individuationMemory.js';
import { IndividuationStore } from '../dist/individuationStore.js';
import { registerIndividuationTools } from '../dist/individuationTools.js';
import { registerContextCompactionTool } from '../dist/contextCompaction.js';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry } from '../dist/index.js';

const on = normalizeIndividuation({ habits: true, predictions: true });
const habits = normalizeIndividuation({ habits: true });
const profile = assistantProfileSchema.parse({});
const until = async fn => { for (let i = 0; i < 500; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const input = (key, content, source = 'text') => ({ id: key, content, role: 'user', source, visibility: source === 'voice' ? 'internal' : 'conversation', createdAt: new Date().toISOString() });
const parent = (key, text, settings = on) => ({ protocol: 'bush.session_turn_request.v1', requestId: key, sessionId: id,
  turnId: key, model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: key, message: { role: 'user', content: text } }],
  tools: [], metadata: { individuation: settings }, permissionMode: 'task_free' });
async function* response(request, { text = '已了解。', calls = [] } = {}) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  let sequence = 0;
  yield { ...base, sequence: sequence++, kind: 'response_started' };
  if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index,
    toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}
const refs = request => request.messages.filter(m => m.role === 'user' && m.name === 'habit_reference').map(m => JSON.parse(m.content));
const receipts = request => request.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const firstId = result => result.writes.find(row => row.id).id;
const cleanup = root => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); };

function fixture(t, respond = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-memory-')), requests = [], observations = [], errors = [], tasks = [], registry = new ToolRegistry();
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const output = await respond(request, requests.length - 1);
    if (output?.failure) yield { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString(),
      sequence: 0, kind: 'response_failed', code: 'ECONNRESET', message: 'Connection interrupted', retryable: true };
    else yield* response(request, output);
  } };
  const memory = new IndividuationMemory(join(root, 'personalization.sqlite'), provider);
  registerIndividuationTools(registry, memory.store.path, memory);
  registerContextCompactionTool(registry, () => assert.fail('only maintenance may checkpoint'));
  const observe = memory.store.observe.bind(memory.store);
  memory.store.observe = (...args) => { observations.push(args[0]); return observe(...args); };
  const bridge = new AssistantMemory(memory, registry, error => errors.push(error));
  let journal = new ConversationJournal(join(root, 'journal')), sequence = 0;
  const deps = { provider, memory: bridge, wait: async () => {}, checkpoint: () => registry.definitions().find(tool => tool.name === 'checkpoint_context'), exists: () => true, tasks: () => tasks,
    delegate: async () => { tasks.push({ taskId: 'child', status: 'running', finalResponse: '', errorMessage: '' }); return { taskId: 'child', status: 'running' }; } };
  let assistant = new AssistantConversation(journal, deps);
  const read = () => assistant.command({ action: 'read', sessionId: id });
  const idle = async () => { await until(() => !read().busy); assert.equal(read().error, ''); };
  t.after(async () => { assistant.close(); await memory.close(); cleanup(root); });
  return { root, memory, store: memory.store, registry, bridge, requests, observations, errors, tasks, read, idle,
    get assistant() { return assistant; }, get journal() { return journal; },
    seed: async (text, kind = 'habit') => firstId(await memory.store.summarize({ [kind]: { text } }, on, { sessionId: 'ordinary-chat', turnId: `seed-${++sequence}` })),
    send(text, settings = on, source = 'text') {
      const key = `input-${++sequence}`, command = { action: 'turn', sessionId: id, entry: input(key, text, source), parent: parent(key, text, settings), profile };
      assistant.command(command); return command;
    },
    restart() { assistant.close(); journal = new ConversationJournal(join(root, 'journal')); assistant = new AssistantConversation(journal, deps); },
  };
}

test('runtime assistant shares the ordinary conversation database and existing tool definitions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-memory-host-')), sessions = new SessionStore(), requests = [];
  sessions.ensureSession(id);
  const store = new IndividuationStore(join(root, 'personalization.sqlite'));
  const memoryId = firstId(await store.summarize({ habit: { text: '报表导出时用户偏好 XLSX。' } }, on, { sessionId: 'ordinary', turnId: 'source' }));
  const host = new InMemoryRuntimeHost({ dataRoot: root, sessionStore: sessions,
    provider: { async *stream(request) { requests.push(request); yield* response(request); } } });
  t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); cleanup(root); });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId: id, ...payload } });
  await command({ action: 'turn', entry: input('request', '帮我导出报表 XLSX'), parent: parent('request', '帮我导出报表 XLSX'), profile });
  await until(async () => !(await command({ action: 'read' })).busy);
  assert.equal((await command({ action: 'read' })).error, '');
  assert.equal(refs(requests[0])[0].memories[0].id, memoryId);
  assert.equal(refs(requests[0])[0].memories[0].source.session_id, 'ordinary');
  const definitions = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  for (const name of ['check_habit', 'summary_for_user', 'revise_memory']) assert.deepEqual(requests[0].tools.find(t => t.name === name), definitions.find(t => t.name === name));
  assert.ok(!(await command({ action: 'read' })).entries.some(e => e.content.includes(memoryId)), 'references stay out of the visible transcript');
});

test('automatic recall is relevant, bounded and deduplicated across turns and restart', async t => {
  const f = fixture(t), memoryId = await f.seed('报表导出时用户偏好 XLSX。');
  await f.seed('图像绘画使用水彩。');
  const command = f.send('报表导出 XLSX'); await f.idle();
  assert.deepEqual(refs(f.requests[0]).flatMap(r => r.memories.map(m => m.id)), [memoryId]);
  assert.ok(JSON.stringify(refs(f.requests[0])).length < 2100);
  f.assistant.command(command); await f.idle(); assert.equal(f.observations.length, 1);
  f.restart(); f.send('继续报表导出 XLSX'); await f.idle();
  assert.equal(refs(f.requests.at(-1)).length, 1);
  assert.deepEqual(f.requests.at(-1).messages.slice(0, f.requests[0].messages.length), f.requests[0].messages, 'existing model prefix stays unchanged');
  assert.equal(f.observations.length, 2);
});

test('hint mode injects only counts; disabled categories do not load or save memory', async t => {
  const f = fixture(t);
  await f.seed('报表导出时用户偏好 XLSX。');
  f.send('报表导出 XLSX', { ...on, recallMode: 'hint' }); await f.idle();
  const hint = refs(f.requests[0])[0]; assert.equal(hint.matched_count, 1); assert.deepEqual(hint.memories, []);
  assert.ok(!JSON.stringify(f.requests[0].messages).includes('报表导出时用户偏好'));
  const off = fixture(t, (_, round) => round ? {} : { calls: [{ id: 'disabled', name: 'summary_for_user', args: { habit: { text: '偏好图表。' }, prediction: { text: '可能要报表。' } } }] });
  off.send('报表导出 XLSX', normalizeIndividuation()); await off.idle();
  assert.deepEqual(refs(off.requests[0]), []);
  assert.ok(receipts(off.requests.at(-1))[0].writes.every(write => write.status === 'skipped'));
  assert.ok(!existsSync(off.store.path));
  assert.match(off.requests[0].messages.find(m => m.name === 'individuation_preference').content, /habits disabled/);
});

test('check_habit is repeatable; summary reuses validation, category switches and provenance', async t => {
  let memoryId;
  const title = { zh: '查询习惯', en: 'Read habits' };
  const f = fixture(t, (_, round) => ({ calls: round === 0 ? [0, 1].map(n => ({ id: `read-${n}`, name: 'check_habit', args: { ids: [memoryId], _display_title: title } })) : round === 1 ? [
    { id: 'save', name: 'summary_for_user', args: { habit: { text: '以后报表默认提供 XLSX 文件。' }, prediction: { text: '可能需要图表。' } } },
  ] : [] }));
  memoryId = await f.seed('报表导出使用 XLSX。');
  f.send('以后报表默认提供 XLSX 文件。', habits, 'voice'); await f.idle();
  const results = receipts(f.requests.at(-1));
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].memories[0].id, memoryId);
  assert.equal(results[2].status, 'ok', JSON.stringify(results[2]));
  assert.equal(results[2].writes.find(w => w.category === 'prediction').status, 'skipped');
  const saved = await f.store.read({ ids: [firstId(results[2])] }, on);
  assert.equal(saved.memories[0].source.session_id, id);
  assert.equal(saved.memories[0].text, '以后报表默认提供 XLSX 文件。');
  assert.equal(f.observations.length, 1, 'transcribed voice is real user input even when hidden from the UI');
});

test('corrections need the current user quote and cannot overwrite pinned records', async t => {
  let memoryId, pinnedId;
  const correction = '以后报表不要默认 XLSX，改用 CSV。';
  const f = fixture(t, (_, round) => ({ calls: round === 1 ? [
    { id: 'stale-quote', name: 'revise_memory', args: { id: memoryId, revision: 1, action: 'retract', reason: '用户修正', user_quote: correction } },
  ] : round === 3 ? [
    { id: 'current-quote', name: 'revise_memory', args: { id: memoryId, revision: 1, action: 'supersede', reason: '用户修正', user_quote: correction, replacement: { kind: 'habit', text: '报表默认导出 CSV。' } } },
    { id: 'pinned', name: 'revise_memory', args: { id: pinnedId, revision: 2, action: 'retract', reason: '用户修正', user_quote: correction } },
  ] : [] }));
  memoryId = await f.seed('报表默认导出 XLSX。'); pinnedId = await f.seed('报表保留原始精度。');
  await f.store.change({ id: pinnedId, revision: 1, action: 'confirm', reason: '确认' }, on, { sessionId: 'settings', turnId: 'pin' }, 'user');
  f.send(correction); await f.idle();
  f.send('请解释报表字段'); await f.idle();
  assert.equal(receipts(f.requests.at(-1))[0].status, 'rejected');
  f.send(correction); await f.idle();
  const results = receipts(f.requests.at(-1));
  assert.ok(results[1].replacement_id); assert.equal(results[2].status, 'rejected');
  const old = await f.store.read({ ids: [memoryId, pinnedId] }, on);
  assert.equal(old.memories[0].state, 'superseded'); assert.equal(old.memories[1].origin, 'user');
});

test('task completion never recalls, observes or writes user memory and cannot reuse old authorization', async t => {
  let memoryId;
  const quote = '以后默认使用 XLSX 报表。';
  const f = fixture(t, (_, round) => ({ calls: round === 0 ? [{ id: 'dispatch', name: 'subagent', args: { prompt: '检查报表' } }] : round === 2 ? [
    { id: 'background-save', name: 'summary_for_user', args: { habit: { text: '用户喜欢后台任务结果。' } } },
    { id: 'background-revise', name: 'revise_memory', args: { id: memoryId, revision: 1, action: 'retract', reason: '后台声称用户要求', user_quote: quote } },
    { id: 'background-read', name: 'check_habit', args: { ids: [memoryId] } },
    { id: 'background-final', name: 'summary_for_user', args: {} },
  ] : [] }));
  memoryId = await f.seed('用户导出报表可能需要 XLSX。', 'prediction');
  f.send(quote); await f.idle();
  const count = f.observations.length;
  f.tasks[0].status = 'completed'; f.tasks[0].finalResponse = quote;
  await until(() => f.requests.length >= 4); await f.idle();
  assert.equal(f.observations.length, count); assert.equal(refs(f.requests.at(-1)).length, 1);
  const results = receipts(f.requests.at(-1));
  assert.equal(results[1].code, 'memory_requires_user_input'); assert.equal(results[2].code, 'memory_requires_user_input');
  assert.equal(results[3].status, 'ok'); assert.equal(results[4].final_response, true);
  assert.ok(f.requests[2].messages.some(m => m.name === 'background_task_result' && m.visibility === 'internal'));
  assert.equal((await f.store.read({ ids: [memoryId] }, on)).memories[0].state, 'active');
});

test('revoked references are updated once before the next model response', async t => {
  const f = fixture(t), memoryId = await f.seed('报表使用 XLSX。');
  f.send('报表导出 XLSX'); await f.idle();
  await f.store.change({ id: memoryId, revision: 1, action: 'retract', reason: '用户在设置中撤销' }, on, { sessionId: 'settings', turnId: 'revoke' }, 'user');
  f.send('继续报表'); await f.idle(); f.send('然后呢'); await f.idle();
  const notices = f.requests.at(-1).messages.filter(m => m.name === 'memory_state_updates');
  assert.equal(notices.length, 1);
  assert.deepEqual(JSON.parse(notices[0].content).changes.map(c => [c.id, c.state]), [[memoryId, 'retracted']]);
});

test('reset during recall discards the late reference while preserving the shared database', async t => {
  const f = fixture(t), memoryId = await f.seed('报表导出使用 XLSX。'), entered = gate(), delayed = gate();
  const recall = f.bridge.recall.bind(f.bridge); let first = true;
  f.bridge.recall = async (...args) => { const result = await recall(...args); if (first) { first = false; entered.release(); await delayed.promise; } return result; };
  t.after(() => delayed.release());
  f.send('旧请求报表 XLSX'); await entered.promise;
  f.assistant.command({ action: 'reset', sessionId: id });
  f.send('新的绘画问题'); await f.idle(); delayed.release(); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.requests.length, 1); assert.deepEqual(refs(f.requests[0]), []);
  assert.ok(!JSON.stringify(f.journal.modelHistory(id).read()).includes('旧请求'));
  assert.equal((await f.store.read({ ids: [memoryId] }, on)).memories[0].state, 'active');
});

test('unavailable memory does not block replies or claim that a note was saved', async t => {
  const f = fixture(t, (_, round) => round ? {} : { calls: [
    { id: 'read', name: 'check_habit', args: {} }, { id: 'save', name: 'summary_for_user', args: { habit: { text: '偏好简洁。' } } },
  ] });
  f.store.read = async () => { throw Error('storage unavailable'); };
  f.store.summarize = async () => { throw Error('storage unavailable'); };
  f.send('我偏好简洁'); await f.idle();
  assert.equal(f.errors.length, 1);
  const results = receipts(f.requests.at(-1)); assert.equal(results[0].status, 'unavailable');
  assert.equal(results[1].saved, false); assert.equal(results[1].storage_status, 'unavailable');
  assert.equal(f.read().entries.at(-1).content, '已了解。');
});

test('provider retries reuse the same reference without observing the user twice', async t => {
  const f = fixture(t, (_, round) => round === 0 ? { failure: true } : {});
  await f.seed('报表默认使用 XLSX。');
  f.send('报表导出 XLSX'); await f.idle();
  assert.equal(f.requests.length, 2); assert.equal(f.observations.length, 1);
  assert.deepEqual(f.requests[1].messages, f.requests[0].messages);
  assert.equal(refs(f.requests[1]).length, 1);
});

test('a changed switch applies on the next turn without deleting stored records', async t => {
  const f = fixture(t, (_, round) => round === 1 ? { calls: [{ id: 'disabled-read', name: 'check_habit', args: {} }] } : {});
  const memoryId = await f.seed('报表默认使用 XLSX。');
  f.send('报表导出 XLSX'); await f.idle();
  await f.seed('报表导出应保留精度。');
  f.send('继续报表导出', normalizeIndividuation()); await f.idle();
  assert.equal(refs(f.requests.at(-1)).length, 1, 'old context remains but no new reference is injected');
  const preference = f.requests.at(-1).messages.filter(m => m.name === 'individuation_preference').at(-1);
  assert.match(preference.content, /habits disabled/);
  assert.equal(receipts(f.requests.at(-1))[0].status, 'disabled');
  assert.equal((await f.store.read({ ids: [memoryId] }, on)).memories[0].state, 'active');
});

test('compaction preserves version tracking so later revocation invalidates summarized memory', async t => {
  const f = fixture(t, request => request.tools[0]?.name === 'checkpoint_context' ? { calls: [{ id: 'checkpoint', name: 'checkpoint_context',
    args: { updates: [{ source: 0, summary: '用户之前偏好 XLSX 报表；这是历史参考，以最新要求为准。' }] } }] } : {});
  const memoryId = await f.seed('报表使用 XLSX。');
  f.send('报表导出 XLSX'); await f.idle();
  f.journal.modelHistory(id).append(Array.from({ length: 5 }, (_, n) => ({ role: 'assistant', content: `历史结果 ${n}。`.repeat(2500), toolCalls: [] })));
  const text = '现在继续说明';
  const request = parent('compact', text); request.metadata.contextWindowTokens = 12000;
  f.assistant.command({ action: 'turn', sessionId: id, entry: input('compact', text), parent: request, profile }); await f.idle();
  assert.ok(f.requests.some(r => r.tools[0]?.name === 'checkpoint_context'));
  assert.equal(refs(f.requests.at(-1)).length, 0, 'full reference was compacted');
  assert.ok(f.requests.at(-1).messages.some(m => m.name === 'memory_state_updates' && m.content.includes(memoryId)));
  f.restart();
  await f.store.change({ id: memoryId, revision: 1, action: 'retract', reason: '撤销' }, on, { sessionId: 'settings', turnId: 'revoke' }, 'user');
  f.send('继续说明'); await f.idle();
  assert.ok(f.requests.at(-1).messages.some(m => m.name === 'memory_state_updates' && JSON.parse(m.content).changes.some(c => c.id === memoryId && c.state === 'retracted')));
});

test('version markers stay bounded after many recalls and do not duplicate retained references', t => {
  const f = fixture(t);
  const messages = Array.from({ length: 1000 }, (_, n) => ({ role: 'user', name: 'habit_reference', visibility: 'internal',
    content: JSON.stringify({ memories: [{ id: `habit_${String(n).padStart(24, '0')}`, revision: 1, state: 'active' }] }) }));
  const marker = f.bridge.checkpointReferences(messages, messages.slice(-1));
  assert.ok(marker.content.length < 5000, 'version bookkeeping cannot grow with the whole conversation');
  const ids = JSON.parse(marker.content).changes.map(row => row.id);
  assert.ok(ids.includes('habit_' + String(998).padStart(24, '0')), 'recent references remain tracked');
  assert.ok(!ids.includes('habit_' + String(999).padStart(24, '0')), 'the existing reference supplies its own version');
});
