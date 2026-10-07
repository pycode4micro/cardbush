import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { modelReplayMatches } from '../dist/modelReplay.js';
import { validateConversation } from '../dist/sessionStore.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { registerContextCompactionTool } from '../dist/contextCompaction.js';
import { toChatCompletionsParams } from '../../bush-provider-openai/dist/chatCompletions.js';
import { toResponsesCreateParams } from '../../bush-provider-openai/dist/responses.js';

const entry = (key, content = key) => ({ id: key, role: 'user', content, source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() });
const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: id, turnId: 'turn', model: 'fixture',
  tools: [], prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'fixture' } }],
  metadata: { contextWindowTokens: 400000 }, permissionMode: 'task_free' };
const event = (request, sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, createdAt: new Date().toISOString(), kind, ...fields });
async function* reply(request, { calls = [], text = '', reasoning = '', replay } = {}) {
  let sequence = 0;
  if (reasoning) yield event(request, sequence++, 'reasoning_delta', { delta: reasoning });
  if (text) yield event(request, sequence++, 'text_delta', { delta: text });
  for (const [index, call] of calls.entries()) yield event(request, sequence++, 'tool_call_delta', { index,
    toolCallId: call.id, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) });
  yield event(request, sequence, 'response_completed', { finishReason: calls.length ? 'tool_calls' : 'stop', ...(replay ? { providerReplay: replay } : {}) });
}
const until = async predicate => { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('timed out'); };
function fixture(t, provider, delegate = async () => ({ status: 'accepted' }), checkpoint = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-cache-')), instances = [];
  const create = () => {
    const journal = new ConversationJournal(root);
    const assistant = new AssistantConversation(journal, { provider, delegate, exists: () => true, tasks: () => [], checkpoint });
    instances.push(assistant);
    return { assistant, journal, send: key => assistant.command({ action: 'turn', sessionId: id, entry: entry(key), parent, profile: assistantProfileSchema.parse({}) }),
      read: () => assistant.command({ action: 'read', sessionId: id }) };
  };
  t.after(() => { instances.forEach(a => a.close()); assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return { root, create };
}

for (const protocol of ['chat', 'responses']) test(`${protocol}: assistant preserves actual provider prefix, reasoning and tool exchanges across turns and restart`, async t => {
  const requests = [], calls = [{ id: 'page', name: 'page_write', args: { content: '## Result\nA written result.' } },
    { id: 'dispatch', name: 'subagent', args: { prompt: 'Read the report' } }];
  const reasoning = 'Need to record a result and delegate the requested follow-up.';
  const replay = protocol === 'chat' ? { format: 'openai.chat_completions.v1', data: { reasoning_content: reasoning } }
    : { format: 'openai.responses.output.v1', data: { items: [
      { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: reasoning }], encrypted_content: 'opaque-fixture' },
      ...calls.map(c => ({ type: 'function_call', id: `item-${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args), status: 'completed' })),
    ] } };
  let delegated = 0;
  const f = fixture(t, { async *stream(request) {
    requests.push(structuredClone(request));
    yield* reply(request, requests.length === 1 ? { calls, reasoning, replay } : { text: `Answer ${requests.length}` });
  } }, async () => { delegated++; return { status: 'accepted' }; });
  const first = f.create(); first.send('first'); await until(() => !first.read().busy);
  assert.equal(first.read().error, '');
  const wire = request => protocol === 'chat' ? toChatCompletionsParams(request, 'https://api.deepseek.com').messages : toResponsesCreateParams(request).input;
  const previous = wire(requests[1]);
  const originalAssistant = requests[1].messages.find(m => m.role === 'assistant' && m.toolCalls.length);
  assert.equal(originalAssistant.reasoningContent, reasoning);
  assert.ok(modelReplayMatches(originalAssistant, requests[1]));
  if (protocol === 'chat') assert.ok(previous.some(m => m.reasoning_content === reasoning));
  else assert.ok(previous.some(m => m.type === 'reasoning' && m.encrypted_content === 'opaque-fixture'));
  first.send('second'); await until(() => !first.read().busy);
  assert.deepEqual(wire(requests[2]).slice(0, previous.length), previous);
  first.assistant.close();
  const restarted = f.create(); restarted.send('third'); await until(() => !restarted.read().busy);
  assert.equal(restarted.read().error, '');
  const second = wire(requests[2]);
  assert.deepEqual(wire(requests[3]).slice(0, second.length), second);
  for (const request of requests) validateConversation(request.messages);
  assert.equal(delegated, 1, 'restoring model history does not redispatch a child');
  assert.equal(requests[3].messages.filter(m => m.role === 'tool').length, 2);
  assert.equal(requests[3].messages.filter(m => m.role === 'assistant' && m.content.startsWith('## Result')).length, 0, 'page_write is not reinserted as a new model message');
  assert.equal(restarted.journal.read(id).filter(m => m.source === 'page').length, 1);
  assert.ok(restarted.journal.read(id).every(m => !('reasoningContent' in m) && m.role !== 'tool'), 'UI journal excludes reasoning and tool receipts');
  restarted.assistant.command({ action: 'reset', sessionId: id });
  assert.deepEqual(new ConversationJournal(f.root).modelHistory(id).read().messages, []);
});

test('new input arriving during a tool keeps the old exchange intact and enters the next response once', async t => {
  const gate = Promise.withResolvers(), requests = [];
  const f = fixture(t, { async *stream(request) {
    requests.push(structuredClone(request));
    yield* reply(request, requests.length === 1 ? { calls: [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Read' } }] } : { text: 'Done' });
  } }, async () => { await gate.promise; return { status: 'accepted' }; });
  t.after(gate.resolve);
  const app = f.create(); app.send('first'); await until(() => requests.length === 1);
  app.send('queued'); gate.resolve(); await until(() => !app.read().busy);
  assert.equal(app.read().error, ''); assert.equal(requests.length, 3);
  assert.ok(!requests[1].messages.some(m => m.content === 'queued'));
  assert.deepEqual(requests[2].messages.slice(0, requests[1].messages.length), requests[1].messages);
  assert.equal(requests[2].messages.filter(m => m.content === 'queued').length, 1);
  assert.equal(requests[2].messages.at(-1).content, 'queued');
  validateConversation(requests[2].messages);
});

test('interrupted persisted tools receive an explicit unknown receipt without replaying side effects', async t => {
  const requests = [];
  const f = fixture(t, { async *stream(request) { requests.push(request); yield* reply(request, { text: 'Check current state first.' }); } }, () => assert.fail('must not redispatch'));
  const journal = new ConversationJournal(f.root);
  journal.append(id, entry('old'));
  journal.modelHistory(id).append([{ role: 'user', content: 'old' }, { role: 'assistant', content: '', toolCalls: [
    { id: 'first-call', name: 'subagent', argumentsText: '{}' }, { id: 'second-call', name: 'page_write', argumentsText: '{}' },
  ] }, { role: 'tool', toolCallId: 'first-call', content: '{"status":"accepted"}' }], ['old']);
  const modelFile = readdirSync(f.root).find(name => name.endsWith('.model.jsonl'));
  appendFileSync(join(f.root, modelFile), '{"type":"append",');
  const app = f.create(); app.send('new'); await until(() => !app.read().busy);
  assert.equal(app.read().error, ''); validateConversation(requests[0].messages);
  const receipts = requests[0].messages.filter(m => m.role === 'tool');
  assert.equal(receipts.length, 2); assert.equal(receipts[0].content, '{"status":"accepted"}');
  assert.equal(JSON.parse(receipts[1].content).code, 'interrupted_tool_execution');
  assert.equal(requests[0].messages.at(-1).content, 'new');
});

test('large configured assistant context is not compacted at the old 20k-character threshold', async t => {
  const requests = [];
  const f = fixture(t, { async *stream(request) { requests.push(request); yield* reply(request, { text: 'Done' }); } });
  const app = f.create();
  for (let i = 0; i < 8; i++) app.journal.append(id, entry(`old-${i}`, `Important context ${i}. `.repeat(400)));
  app.send('latest'); await until(() => !app.read().busy);
  assert.equal(app.read().error, ''); assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.filter(m => m.role === 'user').length, 9);
  assert.ok(!requests[0].tools.some(tool => tool.name === 'checkpoint_context'));
});

test('pressure checkpoints complete tool exchanges, retains source, and restores the compact prefix after restart', async t => {
  const requests = [], registry = new ToolRegistry();
  registerContextCompactionTool(registry, () => assert.fail('only the maintenance transaction accepts a checkpoint'));
  const f = fixture(t, { async *stream(request) {
    requests.push(structuredClone(request));
    yield* reply(request, request.tools[0]?.name === 'checkpoint_context'
      ? { calls: [{ id: `checkpoint-${requests.length}`, name: 'checkpoint_context', args: { updates: [{ source: 0, summary: 'The report was inspected. Keep its constraints and wait for the user.' }] } }] }
      : { text: 'Ready.' });
  } }, undefined, () => registry.definitions().find(tool => tool.name === 'checkpoint_context'));
  const app = f.create(); app.journal.append(id, entry('old'));
  app.journal.modelHistory(id).append([{ role: 'user', content: 'old' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'subagent', argumentsText: '{"prompt":"Inspect"}' }] },
    { role: 'tool', toolCallId: 'old-call', content: 'receipt-marker: Important report constraints. '.repeat(4000) },
    { role: 'assistant', content: 'Report received.', toolCalls: [] }], ['old']);
  app.assistant.command({ action: 'turn', sessionId: id, entry: entry('new'), parent: { ...parent, metadata: { contextWindowTokens: 8000 } }, profile: assistantProfileSchema.parse({}) });
  await until(() => !app.read().busy); assert.equal(app.read().error, '');
  const maintenance = requests.filter(r => r.tools[0]?.name === 'checkpoint_context');
  assert.ok(maintenance.some(r => JSON.stringify(r.messages).includes('old-call') && JSON.stringify(r.messages).includes('receipt-marker')));
  const before = requests.at(-1); validateConversation(before.messages);
  assert.ok(before.messages.some(m => m.name === 'conversation_memory'));
  assert.ok(!before.messages.some(m => m.role === 'tool'));
  const source = readFileSync(join(f.root, readdirSync(f.root).find(n => n.endsWith('.model.jsonl'))), 'utf8');
  assert.ok(source.includes('receipt-marker') && source.includes('old-call'), 'original exchanges remain available in the append-only log');
  app.assistant.close(); const restarted = f.create(); restarted.send('follow-up'); await until(() => !restarted.read().busy);
  assert.equal(restarted.read().error, '');
  assert.deepEqual(requests.at(-1).messages.slice(0, before.messages.length), before.messages);
});
