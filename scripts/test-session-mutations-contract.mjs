import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function evaluate(source, bindings) {
  const context = vm.createContext(bindings);
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
  } }).outputText, context);
  return context;
}

const api = readFileSync('src/backend/api.ts', 'utf8');
const editStart = api.indexOf('export async function editMessage(');
const editSource = api.slice(editStart, api.indexOf('\nexport async function sendGuidance', editStart))
  .replace('export async function', 'async function');
const original = { revision: 7, supersededMessageIds: [], turns: [{ messages: [
  { messageId: 'u', turnId: 't', message: { role: 'user', content: 'original' } },
  { messageId: 'a', turnId: 't', message: { role: 'assistant', content: 'answer' } },
] }] };
let dispatched;
const edit = evaluate(`${editSource}\nglobalThis.run = editMessage;`, {
  crypto: globalThis.crypto,
  createDesktopRuntimeSession: () => ({
    client: { getSession: async () => structuredClone(original),
      supersedeSessionMessages: () => { assert.fail('Preparation must never supersede durable messages'); } },
    dispose() {},
  }),
  isInternalRuntimeMessage: () => false,
  localizedClientMessage: (_, english) => english,
  streamRuntimeChat: async (request, options) => {
    dispatched = { request, options };
    throw new Error('model configuration unavailable');
  },
});
await assert.rejects(edit.run({ sessionId: 's', messageId: 'u', content: 'edited' }),
  /model configuration unavailable/);
assert.deepEqual(JSON.parse(JSON.stringify(dispatched.options.supersession)), {
  expectedRevision: 7, messageIds: ['u', 'a'], reason: 'user_edit_regenerate',
});
assert.equal(dispatched.request.userInput, 'edited');
assert.match(dispatched.options.turnId, /^turn_/);

const hook = readFileSync('src/hooks/useCardbushChat.ts', 'utf8');
const deleteStart = hook.indexOf('  const deleteConversation = useCallback(');
const deletion = hook.slice(deleteStart, hook.indexOf('\n  const renameConversation', deleteStart));
assert.ok(deletion.length > 0);
for (const rejected of [true, false]) {
  let conversations = [{ id: 's' }, { id: 'other' }];
  let messages = { s: ['original'], other: ['other'] };
  let active = 's';
  let error;
  let settle;
  let clearedAttention = 0;
  const invalidatedReads = [];
  const receipt = new Promise((resolve, reject) => { settle = () => rejected
    ? reject(new Error('An active Session cannot be deleted.')) : resolve(true); });
  const ctx = evaluate(`${deletion}\nglobalThis.run = deleteConversation;`, {
    useCallback: (callback) => callback,
    historyReadsRef: { current: { invalidate: id => invalidatedReads.push(['history', id]) } },
    contextUsageReadsRef: { current: { invalidate: id => invalidatedReads.push(['usage', id]) } },
    clearSessionAttention: () => { clearedAttention++; }, setMessageHistoryLoading() {},
    setConversations: (update) => { conversations = update(conversations); },
    setMessagesByConversation: (update) => { messages = update(messages); },
    setActiveConversationId: (update) => { active = update(active); },
    deleteConversationApi: () => receipt,
    setError: (value) => { error = value; }, errorMessage: (value) => value.message,
  });
  const pending = ctx.run('s');
  assert.equal(conversations.length, 2, 'The pending delete stays visible');
  assert.deepEqual(messages.s, ['original']);
  active = 'other'; // A late deletion must not switch away from another task.
  settle();
  await pending;
  assert.equal(active, 'other');
  assert.equal(conversations.length, rejected ? 2 : 1);
  assert.equal(clearedAttention, rejected ? 0 : 1);
  assert.equal('s' in messages, rejected);
  assert.deepEqual(invalidatedReads, rejected ? [] : [['history','s'],['usage','s']],
    'Only a confirmed deletion invalidates pending reads for that exact session');
  if (rejected) assert.match(error, /active Session/);
}
console.log('Session mutation failure regression tests passed');
