import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { InMemoryRuntimeHost, SessionStore, assembleContext } from '../packages/bush-runtime/dist/index.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const transcript = await loadChatTranscript();
const plain = value => JSON.parse(JSON.stringify(value));
const now = '2026-09-11T00:00:00.000Z';
const user = (id, turnId, content, extra = {}) => ({
  id, turnId, role: 'user', content, conversationId: 's', createdAt: now, ...extra,
});
const assistant = (id, turnId, extra = {}) => ({
  id, turnId, role: 'assistant', content: 'answer', conversationId: 's', createdAt: now, ...extra,
});
const first = user('message_first', 'first', 'first request');
const firstAnswer = assistant('msg_first', 'first');
const latest = user('user-pending', 'latest', 'latest request');
const latestAnswer = assistant('msg_latest', 'latest');
const find = transcript.findUserMessageForAssistantRegenerate;

assert.equal(find(latestAnswer, [first, firstAnswer, latest, latestAnswer]), undefined,
  'A latest user row with a temporary ID must trigger a history read, never select the first Turn');
const savedLatest = { ...latest, id: 'message_latest' };
assert.equal(find(latestAnswer, [first, firstAnswer, savedLatest, latestAnswer]), savedLatest);
assert.equal(find(assistant('unknown', 'missing'), [first, firstAnswer]), undefined);
assert.equal(find(assistant('unknown', ''), [first, firstAnswer]), undefined);
assert.equal(find(latestAnswer, [first, firstAnswer, latestAnswer]), undefined);
const guidance = user('message_guidance', 'latest', 'later guidance');
assert.equal(find(latestAnswer, [savedLatest, latestAnswer, guidance]), savedLatest,
  'Retrying an earlier assistant segment cannot select guidance submitted after it');
assert.equal(find(assistant('after-guidance', 'latest'), [savedLatest, latest, assistant('after-guidance', 'latest')]), undefined,
  'An unpersisted guidance row cannot be skipped in favor of an earlier input in the same Turn');
assert.equal(find(latestAnswer, [{ ...savedLatest, metadata: { __bush_superseded: true } }, latestAnswer]), undefined);
assert.equal(find(latestAnswer, [{ ...savedLatest, conversationId: 'other' }, latestAnswer]), undefined);
assert.equal(find(assistant('unlocated', 'latest'), [savedLatest, guidance]), undefined,
  'An unlocated assistant with multiple possible inputs must not guess');

function evaluate(source, bindings) {
  const context = vm.createContext({ crypto: globalThis.crypto, AbortController, ...bindings });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText, context);
  return context.run;
}
const apiSource = ts.createSourceFile('api.ts', readFileSync('src/backend/api.ts', 'utf8'), 99, true);
const editSource = apiSource.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'editMessage')
  .getText(apiSource).replace('export async function', 'async function');
const hookSource = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), 99, true);
const hook = hookSource.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'useCardbushChat');
const retrySource = hook.body.statements.find(s => ts.isVariableStatement(s) &&
  s.declarationList.declarations.some(d => d.name.getText(hookSource) === 'regenerateAssistantMessage')).getText(hookSource);

function fixture() {
  const journal = [];
  const persistence = { load: () => structuredClone(journal), append: event => journal.push(structuredClone(event)) };
  const store = new SessionStore({ persistence, now: () => now });
  for (let n = 1; n <= 3; n++) {
    const messages = [
      { role: 'user', visibility: 'internal', name: 'runtime_context', content: `context ${n}` },
      { role: 'user', content: `request ${n}` },
      { role: 'assistant', content: `answer ${n}`, toolCalls: [] },
    ];
    store.commitTurn('s', {
      turnId: `turn_${n}`, turnSequence: n, createdAt: now, completedAt: now,
      status: 'completed', reason: 'done', usage: {},
      messages: messages.map((message, i) => ({
        messageId: `message_${n}_${i}`, turnId: `turn_${n}`, turnSequence: n,
        messageIndex: i, createdAt: now, message,
      })),
    });
  }
  const visible = store.snapshot('s').turns.flatMap(turn => turn.messages
    .filter(m => m.message.visibility !== 'internal').map(m => ({
      id: m.messageId, messageId: m.messageId, role: m.message.role, content: m.message.content,
      conversationId: 's', turnId: m.turnId, turnSequence: m.turnSequence,
      messageIndex: m.messageIndex, createdAt: now,
    })));
  const requests = [];
  const host = new InMemoryRuntimeHost({ sessionStore: store, provider: { async *stream(request) {
    requests.push(request);
    yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 0, createdAt: now,
      kind: 'text_delta', delta: 'replacement answer' };
    yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 1, createdAt: now,
      kind: 'response_completed', finishReason: 'stop' };
  } } });
  let dispatched;
  const edit = evaluate(`${editSource}\nglobalThis.run = editMessage;`, {
    localizedClientMessage: (_, english) => english,
    isInternalRuntimeMessage: m => m.message.visibility === 'internal',
    createDesktopRuntimeSession: () => ({
      client: { getSession: async () => store.snapshot('s') }, dispose() {},
    }),
    streamRuntimeChat: async (request, options) => {
      dispatched = { request, options };
      return host.runSessionTurn({
        protocol: 'bush.session_turn_request.v1', requestId: 'retry', sessionId: 's',
        turnId: options.turnId, model: 'test', tools: [], metadata: {},
        prefixMessages: [{ role: 'system', content: 'fixed prefix' }],
        inputMessages: [{ messageId: 'message_replacement', createdAt: now,
          message: { role: 'user', content: request.userInput } }],
        supersession: options.supersession,
      });
    },
  });
  return { store, persistence, visible, requests, edit, get dispatched() { return dispatched; } };
}

async function runRetry(f, { load = async () => f.visible, stale = false, busyAfterRead = false } = {}) {
  const current = f.visible.map(m => m.role === 'user' && m.turnId !== 'turn_1'
    ? { ...m, id: `user-optimistic-${m.turnId}`, messageId: undefined }
    : m);
  // A completed assistant still carries its old status/timing/identity. The
  // new streaming placeholder must not inherit any of those routing facts.
  const selected = { ...current.at(-1), status: 'completed',
    metadata: { cardbush_turn_completed_at: now, segment_complete: true } };
  current[current.length - 1] = selected;
  let reads = 0;
  let error;
  let optimistic;
  const no = () => {};
  const conversation = { id: 's', title: 'test' };
  const callback = evaluate(`${retrySource}\nglobalThis.run = regenerateAssistantMessage;`, {
    ...transcript, useCallback: callback => callback,
    activeConversationId: 's', activeConversation: conversation, conversations: [conversation],
    activeMessages: current, messagesByConversation: { s: current },
    selectedModel: 'test', managedModelConfigs: [], requestContext: {}, skills: [],
    languageRef: { current: 'zh' }, referencePlanMode: 'off', permissionMode: 'task_free',
    subagentPermissionRouting: 'parent', reasoningLevel: 'medium',
    localize: (_, english) => english, setError: value => { error = value; }, errorMessage: e => e.message,
    isSessionSending: () => busyAfterRead && reads > 0,
    beginHistoryRead: () => ({}), isHistoryReadCurrent: () => !stale, applyHistoryRead: no,
    fetchMessages: async (id, options) => {
      assert.equal(id, 's'); assert.equal(options.includeSuperseded, false);
      reads++; return load();
    },
    selectedModelName: () => 'test', modelConfigFor: no,
    conversationProjectRequestDir: no, conversationWorkspaceRoot: no, teamModeContextPrompt: no,
    teamIdFromMessage: no, normalizeDisabledToolNames: () => [],
    streamAttachmentsFromChatAttachments: () => ({}), sendMessage: no,
    editMessage: f.edit,
    runControlAssistantStream: async input => {
      optimistic = input;
      await input.stream(new AbortController(), {});
    },
  });
  await callback(selected);
  return { reads, error, optimistic };
}

const f = fixture();
const before = f.store.snapshot('s');
const result = await runRetry(f);
assert.equal(result.error, undefined);
assert.equal(result.reads, 1);
assert.equal(f.dispatched.request.expectedTurnId, 'turn_3');
assert.equal(f.dispatched.request.userInput, 'request 3');
assert.deepEqual(plain(f.dispatched.options.supersession.messageIds),
  before.turns[2].messages.map(m => m.messageId), 'Only the selected last Turn is superseded');
assert.deepEqual(plain(result.optimistic.initialMessages.slice(0, 4).map(m => m.id)),
  f.visible.slice(0, 4).map(m => m.id), 'Refreshing durable IDs retains both preceding exchanges');
assert.deepEqual(plain(result.optimistic.initialMessages.filter(m => m.role === 'user').map(m => m.content)),
  ['request 1', 'request 2', 'request 3'], 'The replayed user input appears exactly once');
for (const placeholder of result.optimistic.initialMessages.slice(-2)) {
  for (const key of ['turnId', 'messageId', 'messageIndex', 'turnSequence', 'metadata', 'status']) {
    assert.equal(placeholder[key], undefined, `Replacement placeholders cannot inherit ${key}`);
  }
}
assert.equal(f.requests.length, 1, 'One regeneration starts one model request, not every Session Turn');
assert.deepEqual(f.requests[0].messages.map(m => m.content), [
  'fixed prefix', 'context 1', 'request 1', 'answer 1', 'context 2', 'request 2', 'answer 2', 'request 3',
]);
const after = f.store.snapshot('s');
assert.deepEqual(after.turns.slice(0, 3), before.turns, 'Original journal facts remain immutable');
assert.deepEqual(assembleContext({ session: after }).messages.map(m => m.content), [
  'context 1', 'request 1', 'answer 1', 'context 2', 'request 2', 'answer 2', 'request 3', 'replacement answer',
]);
assert.deepEqual(new SessionStore({ persistence: f.persistence }).snapshot('s'), after,
  'Restarting from the journal retains the same history and regeneration boundary');

for (const options of [
  { load: async () => [] },
  { load: async () => { throw new Error('history unavailable'); } },
  { stale: true },
  { busyAfterRead: true },
]) {
  const failed = fixture();
  const original = failed.store.snapshot('s');
  await runRetry(failed, options);
  assert.equal(failed.requests.length, 0);
  assert.deepEqual(failed.store.snapshot('s'), original);
}
for (const [messageId, expectedTurnId] of [
  ['message_1_1', 'turn_3'], ['message_3_2', 'turn_3'], ['message_3_0', 'turn_3'],
  ['unknown', 'turn_3'], ['message_3_1', ''],
]) {
  const rejected = fixture();
  const original = rejected.store.snapshot('s');
  await assert.rejects(rejected.edit({ sessionId: 's', messageId, expectedTurnId, content: 'retry' }));
  assert.equal(rejected.requests.length, 0, 'Invalid targets must never reach the provider');
  assert.deepEqual(rejected.store.snapshot('s'), original);
}
console.log('Regeneration regression passed: optimistic IDs, exact Turn, guidance order, refresh failure/races, preserved history, single model request and durable replay.');
