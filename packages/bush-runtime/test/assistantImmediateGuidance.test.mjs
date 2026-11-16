import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as sessionId } from '@cardbush/bush-protocol';

const at = '2026-11-15T08:00:00.000Z';
const event = (request, sequence, kind, data = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: at, kind, ...data });
async function* reply(request, text) {
  yield event(request, 0, 'text_delta', { delta: text });
  yield event(request, 1, 'response_completed', { finishReason: 'stop' });
}
async function* call(request) {
  yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: 'child-call', nameDelta: 'subagent', argumentsDelta: JSON.stringify({ prompt: 'Read the fixture' }) });
  yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
}
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await pause(5); }
  assert.fail('Assistant did not reach the expected state');
}
function fixture(t, stream, deps = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-immediate-'));
  let journal = new ConversationJournal(root);
  const requests = [], signals = [], executions = [];
  const create = () => new AssistantConversation(journal, {
    exists: () => true, tasks: () => [], checkpoint: () => ({}), delegate: async () => assert.fail('Unexpected tool'),
    agents: { begin: request => executions.push(request.turnId), update() {}, forget() {} }, ...deps,
    provider: { async *stream(request, options) {
      const index = requests.length;
      requests.push(structuredClone(request)); signals.push(options.signal);
      yield* stream(request, options, index);
    } },
  });
  let assistant = create();
  t.after(() => assistant.close());
  const reopen = () => { assistant.close(); journal = new ConversationJournal(root); assistant = create(); };
  const command = (id, content, entry = {}, parent = {}) => ({ action: 'turn', sessionId,
    entry: { id, content, createdAt: at, role: 'user', source: 'text', visibility: 'conversation', ...entry },
    parent: { protocol: 'bush.session_turn_request.v1', requestId: id, sessionId, turnId: `turn-${id}`, model: 'fixture', prefixMessages: [],
      inputMessages: [{ messageId: id, message: { role: 'user', content } }], tools: [], permissionMode: 'task_free', metadata: { assistantOutputMode: 'text' }, ...parent },
    profile: assistantProfileSchema.parse({}),
  });
  const send = (...args) => assistant.command(command(...args));
  const read = () => assistant.command({ action: 'read', sessionId });
  const replies = () => read().entries.filter(entry => entry.role === 'assistant');
  return { get assistant() { return assistant; }, get journal() { return journal; }, root, reopen, command, send, read, replies, requests, signals, executions };
}

for (const stage of ['waiting', 'reasoning', 'text', 'partial-tool']) {
  test(`Assistant immediately guides ${stage}, retains one reply owner and ignores late output`, async t => {
    const old = Promise.withResolvers(), finish = Promise.withResolvers();
    const f = fixture(t, async function* (request, options, index) {
      if (!index) {
        yield event(request, 0, 'response_started');
        if (stage === 'reasoning') yield event(request, 1, 'reasoning_delta', { delta: 'Unfinished thought' });
        if (stage === 'text') yield event(request, 1, 'text_delta', { delta: 'Unpublished draft' });
        if (stage === 'partial-tool') yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: 'never-run', nameDelta: 'subagent', argumentsDelta: '{"prompt":' });
        await old.promise; // An adapter that ignores cancellation must not publish late.
        yield* reply(request, 'STALE');
      } else { await finish.promise; yield* reply(request, 'Updated answer'); }
    });
    t.after(() => { old.resolve(); finish.resolve(); });
    f.send('initial', 'Original request'); await until(() => f.requests.length === 1);
    f.send('correction', 'New direction'); f.send('extra', 'Also include the count');
    f.send('correction', 'New direction');
    assert.equal(f.signals[0].aborted, true);
    await until(() => f.requests.length === 2);
    assert.deepEqual(f.requests[1].messages.filter(m => m.role === 'user' && !m.name).map(m => m.content),
      ['Original request', 'New direction', 'Also include the count']);
    assert.equal(f.requests[1].messages.some(m => m.role === 'assistant'), false);
    f.send('correction', 'New direction');
    assert.equal(f.signals[1].aborted, false, 'an admission retry must not interrupt again');
    old.resolve(); await pause(20); assert.equal(f.replies().length, 0);
    finish.resolve(); await until(() => !f.read().busy);
    assert.equal(f.read().error, '');
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.replies().map(e => [e.content, e.responseTo]), [['Updated answer', ['initial', 'correction', 'extra']]]);
    assert.equal(new Set(f.executions).size, 1, 'guidance continues the current execution');
    assert.equal(JSON.stringify(f.journal.modelHistory(sessionId).read().messages).includes('STALE'), false);
  });
}

test('Assistant applies input arriving before initial context admission exactly once', async t => {
  const prepared = Promise.withResolvers(), delegated = []; let entered = false;
  const f = fixture(t, async function* (request, options, index) {
    if (!index) yield* call(request); else yield* reply(request, 'Both inputs');
  }, {
    prepareParent: async parent => { entered = true; await prepared.promise; return parent; },
    delegate: async input => { delegated.push(structuredClone(input)); return { status: 'completed' }; },
  });
  t.after(() => prepared.resolve());
  f.send('first', 'First input'); await until(() => entered);
  f.send('second', 'Second input', { attachments: [{ id: 'document', name: 'report.md', path: 'C:/fixture/report.md', type: 'document' }] }); prepared.resolve();
  await until(() => !f.read().busy);
  assert.equal(f.requests.length, 2, 'one tool round and one final reply cover both inputs');
  assert.deepEqual(f.requests[0].messages.filter(m => m.role === 'user' && !m.name).map(m => m.content.split('\n')[0]), ['First input', 'Second input']);
  assert.equal(delegated.length, 1);
  assert.deepEqual(delegated[0].parent.inputMessages.map(m => m.messageId), ['first', 'second']);
  assert.match(delegated[0].parent.inputMessages[1].message.content, /C:\/fixture\/report.md/, 'early guidance also retains attachments in subsequent delegation');
  assert.deepEqual(f.replies()[0].responseTo, ['first', 'second']);
  assert.equal(new Set(f.executions).size, 1);
});

test('Assistant discards a context snapshot prepared before new guidance', async t => {
  const prepared = Promise.withResolvers(); let entered = false;
  const f = fixture(t, async function* (request) { yield* reply(request, 'Current context'); }, {
    environment: { message: async () => { entered = true; await prepared.promise; return undefined; } },
  });
  t.after(() => prepared.resolve());
  f.send('first', 'First input'); await until(() => entered);
  f.send('second', 'Second input'); prepared.resolve();
  await until(() => !f.read().busy);
  assert.equal(f.requests.length, 1, 'do not issue a model request against the stale snapshot');
  assert.ok(f.requests[0].messages.some(m => m.content === 'Second input'));
  assert.deepEqual(f.replies()[0].responseTo, ['first', 'second']);
});

test('Assistant guidance preserves quotes, attached images, prompt context and delegation evidence', async t => {
  const old = Promise.withResolvers(), delegated = [], recalled = [];
  const f = fixture(t, async function* (request, options, index) {
    if (index === 0) { await old.promise; yield* reply(request, 'STALE'); }
    else if (index === 1) yield* call(request);
    else yield* reply(request, 'Updated task dispatched');
  }, {
    snapshotImage: async path => { assert.equal(path, 'C:/fixture/image.png'); return 'data:image/png;base64,fixture'; },
    delegate: async input => { delegated.push(structuredClone(input)); return { status: 'completed' }; },
    memory: { definitions: () => [], recall: async (parent, text) => { recalled.push(text); }, changes: async () => undefined, schedule() {} },
  });
  t.after(() => old.resolve());
  f.journal.append(sessionId, { id: 'quoted', role: 'assistant', source: 'text', visibility: 'conversation', content: 'Earlier advice', createdAt: at });
  f.send('first', 'Original task', {}, { requestCapabilities: { vision: true, interactiveRequests: false } });
  await until(() => f.requests.length === 1);
  f.send('second', 'Use this selection', { replyTo: { messageId: 'quoted', excerpt: 'advice' },
    promptContext: [{ kind: 'preview-selection', content: 'Selected reference' }],
    attachments: [{ id: 'image', name: 'image.png', path: 'C:/fixture/image.png', type: 'image' }],
  });
  await until(() => !f.read().busy);
  assert.equal(f.read().error, '');
  const message = f.requests[1].messages.find(m => m.content.startsWith('Use this selection'));
  assert.match(message.content, /Selected reference/); assert.match(message.content, /Earlier advice/); assert.match(message.content, /image.png/);
  assert.equal(message.images[0].url, 'data:image/png;base64,fixture');
  assert.deepEqual(recalled, ['Original task', 'Use this selection']);
  assert.equal(delegated.length, 1);
  assert.deepEqual(delegated[0].parent.inputMessages.map(m => m.messageId), ['first', 'second']);
  assert.deepEqual(delegated[0].parent.inputMessages[1].message, message, 'delegation retains the complete guided input, including quotes and attachments');
  assert.deepEqual(delegated[0].parent.metadata.assistantEventEvidence.map(e => e.id), ['first', 'second']);
  assert.deepEqual(f.replies().at(-1).responseTo, ['first', 'second']);
});

test('Assistant guidance waits only for the in-flight tool receipt and never aborts or replays the tool', async t => {
  const tool = Promise.withResolvers(), executions = []; let toolSignal;
  const f = fixture(t, async function* (request, options, index) {
    if (index === 0) yield* call(request); else yield* reply(request, 'Result with correction');
  }, { delegate: async (input, signal) => { executions.push(input); toolSignal = signal; await tool.promise; return { status: 'completed', result: 'tool output' }; } });
  t.after(() => tool.resolve());
  f.send('first', 'Start work'); await until(() => executions.length === 1);
  f.send('second', 'Change the explanation');
  assert.equal(toolSignal.aborted, false); assert.equal(f.requests.length, 1);
  tool.resolve(); await until(() => !f.read().busy);
  assert.equal(f.read().error, ''); assert.equal(executions.length, 1); assert.equal(f.requests.length, 2);
  const messages = f.requests[1].messages;
  assert.ok(messages.findIndex(m => m.role === 'tool') < messages.findIndex(m => m.content === 'Change the explanation'));
  assert.equal(messages.filter(m => m.toolCallId === 'child-call').length, 1);
  assert.deepEqual(f.replies()[0].responseTo, ['first', 'second']);
});

for (const reset of [false, true]) test(`guidance arriving during image preparation ${reset ? 'cannot escape a reset' : 'preserves subsequent input in order'}`, async t => {
  const old = Promise.withResolvers(), image = Promise.withResolvers(); let preparing = false;
  const f = fixture(t, async function* (request, options, index) {
    if (!index) { await old.promise; yield* reply(request, 'STALE'); }
    else yield* reply(request, 'Current answer');
  }, { snapshotImage: async () => { preparing = true; await image.promise; return 'data:image/png;base64,fixture'; } });
  t.after(() => { old.resolve(); image.resolve(); });
  f.send('first', 'Original request', {}, { requestCapabilities: { vision: true, interactiveRequests: false } });
  await until(() => f.requests.length === 1);
  f.send('image', 'Image correction', { attachments: [{ id: 'image', name: 'image.png', path: 'C:/fixture/image.png', type: 'image' }] });
  await until(() => preparing);
  if (reset) f.assistant.command({ action: 'reset', sessionId });
  f.send('third', 'Latest input');
  if (reset) await until(() => !f.read().busy);
  image.resolve(); old.resolve(); await until(() => !f.read().busy); await pause(20);
  assert.equal(f.read().error, ''); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.replies().map(e => [e.content, e.responseTo]), [['Current answer', reset ? ['third'] : ['first', 'image', 'third']]]);
  const content = f.requests[1].messages.filter(m => m.role === 'user' && !m.name);
  assert.deepEqual(content.map(m => m.content.split('\n')[0]), reset ? ['Latest input'] : ['Original request', 'Image correction', 'Latest input']);
  assert.equal(f.journal.modelHistory(sessionId).read().entryIds.has('image'), !reset);
});

test('Assistant immediate input interrupts retry backoff without waiting for the old retry', async t => {
  let waiting = false;
  const f = fixture(t, async function* (request, options, index) {
    if (!index) yield event(request, 0, 'response_failed', { code: 'ECONNRESET', message: 'Try later', retryable: true });
    else yield* reply(request, 'New input handled');
  }, { wait: async (ms, signal) => { waiting = true; await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  f.send('first', 'Original request'); await until(() => waiting);
  f.send('second', 'Updated request'); await until(() => !f.read().busy);
  assert.equal(f.read().error, ''); assert.equal(f.read().retry, null);
  assert.equal(f.signals[0].aborted, true); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.replies()[0].responseTo, ['first', 'second']);
});

for (const action of ['stop', 'reset']) test(`Assistant ${action} wins over pending guidance and ignores late generation`, async t => {
  const old = Promise.withResolvers();
  const f = fixture(t, async function* (request, options, index) {
    if (!index) { await old.promise; yield* reply(request, 'STALE'); }
    else yield* reply(request, 'Fresh reply');
  });
  t.after(() => old.resolve());
  f.send('first', 'Old request'); await until(() => f.requests.length === 1);
  f.send('second', 'Old correction'); f.assistant.command({ action, sessionId });
  await until(() => !f.read().busy);
  assert.equal(f.replies().length, 0);
  f.send('fresh', 'New request'); await until(() => !f.read().busy);
  old.resolve(); await pause(20);
  assert.deepEqual(f.replies().map(e => e.content), ['Fresh reply']);
  if (action === 'reset') {
    assert.equal(f.requests[1].messages.some(m => m.content.includes('Old request') || m.content.includes('Old correction')), false);
    assert.deepEqual(f.replies()[0].responseTo, ['fresh']);
  }
});

test('Assistant passive journal appends do not invoke or interrupt generation; a published reply starts a new turn', async t => {
  const old = Promise.withResolvers();
  const f = fixture(t, async function* (request, options, index) {
    if (!index) await old.promise;
    yield* reply(request, index ? 'Next answer' : 'First answer');
  });
  t.after(() => old.resolve());
  f.send('first', 'First request'); await until(() => f.requests.length === 1);
  f.assistant.command({ action: 'append', sessionId, entry: { id: 'transcript', content: 'Recorded speech', createdAt: at, role: 'user', source: 'voice' } });
  assert.equal(f.signals[0].aborted, false);
  old.resolve(); await until(() => !f.read().busy);
  assert.equal(f.requests.length, 1);
  f.send('second', 'Next request'); await until(() => !f.read().busy);
  assert.deepEqual(f.replies().map(e => e.content), ['First answer', 'Next answer']);
  assert.equal(new Set(f.executions).size, 2);
});

test('Assistant never merges local guidance into an external-recipient reply', async t => {
  const old = Promise.withResolvers();
  const f = fixture(t, async function* (request, options, index) {
    if (!index) await old.promise;
    yield* reply(request, index ? 'Local response' : 'External response');
  });
  t.after(() => old.resolve());
  f.send('external', 'External input', { botSourceRef: 'webhook:external', botRecipientKey: 'a'.repeat(64) },
    { turnId: 'webhook-external', metadata: { botSourceRef: 'webhook:external' } });
  await until(() => f.requests.length === 1);
  f.send('local', 'Local input');
  assert.equal(f.signals[0].aborted, false);
  old.resolve(); await until(() => !f.read().busy);
  assert.deepEqual(f.replies().map(e => e.responseTo), [['external'], ['local']]);
  assert.equal(f.requests[1].metadata.botSourceRef, undefined);
});

for (const action of ['stop', 'reset']) test(`late environment preparation after ${action} cannot write into the next turn`, async t => {
  const old = Promise.withResolvers(); let environmentCalls = 0;
  const f = fixture(t, async function* (request) { yield* reply(request, 'Fresh answer'); }, {
    environment: { message: async () => {
      if (++environmentCalls === 1) { await old.promise; return { role: 'user', name: 'runtime_environment', content: 'STALE_ENVIRONMENT' }; }
    } },
  });
  t.after(() => old.resolve());
  f.send('first', 'Old input'); await until(() => environmentCalls === 1);
  f.assistant.command({ action, sessionId }); await until(() => !f.read().busy);
  f.send('fresh', 'Fresh input'); await until(() => !f.read().busy);
  old.resolve(); await pause(30);
  assert.deepEqual(f.replies().map(entry => entry.content), ['Fresh answer']);
  const reopened = new ConversationJournal(f.root).modelHistory(sessionId).read();
  assert.ok(!reopened.messages.some(message => message.content === 'STALE_ENVIRONMENT'), 'late environment data must not survive in durable history');
  assert.equal(f.requests.length, 1);
});

for (const restart of [false, true]) test(`retry after interrupted guidance preserves the complete assignment${restart ? ' after compaction and restart' : ''}`, async t => {
  const old = Promise.withResolvers(), delegated = [];
  const f = fixture(t, async function* (request, options, index) {
    if (index === 0) { await old.promise; yield* reply(request, 'STALE'); }
    else if (index === 1) yield event(request, 0, 'response_failed', { code: 'fixture_failed', message: 'Fixture generation failed', retryable: false });
    else if (index === 2) yield* call(request);
    else yield* reply(request, 'Retried with full context');
  }, { delegate: async input => { delegated.push(structuredClone(input)); return { status: 'completed' }; } });
  t.after(() => old.resolve());
  f.send('first', 'Read the report and compare both proposals', {
    attachments: [{ id: 'file', name: 'report.md', path: 'C:/fixture/report.md', type: 'document' }],
  });
  await until(() => f.requests.length === 1);
  f.send('second', 'Use the revised budget'); await until(() => !f.read().busy);
  assert.ok(f.read().error);
  if (restart) {
    const history = f.journal.modelHistory(sessionId);
    history.checkpoint(history.read().messages.length, 'Compare both proposals from the attached report using the revised budget.');
    f.reopen();
    assert.equal(f.read().canRetry, true);
  }
  const retry = f.command('retry', 'Use the revised budget');
  f.assistant.command({ action: 'retry', sessionId, parent: retry.parent, profile: retry.profile });
  await until(() => !f.read().busy);
  assert.equal(f.read().error, '');
  assert.equal(delegated.length, 1);
  assert.deepEqual(delegated[0].parent.inputMessages.map(input => input.messageId), ['first', 'second']);
  assert.match(delegated[0].parent.inputMessages[0].message.content, /C:\/fixture\/report.md/);
  assert.deepEqual(delegated[0].parent.metadata.assistantEventEvidence.map(entry => entry.id), ['first', 'second']);
  assert.deepEqual(f.replies().at(-1).responseTo, ['first', 'second']);
  assert.deepEqual(new ConversationJournal(f.root).modelHistory(sessionId).replyInputs(), [], 'a completed reply must release its input ownership');
  f.send('fresh', 'A different assignment'); await until(() => !f.read().busy);
  assert.deepEqual(f.replies().at(-1).responseTo, ['fresh']);
});
