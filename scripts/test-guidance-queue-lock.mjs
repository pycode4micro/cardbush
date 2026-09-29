import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the production hook callbacks with a deterministic event queue.
// Async send preparation is held separately from the external model call.
const source = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat');
const callback = name => {
  const declaration = hook.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(source) === name);
  assert.ok(declaration, name);
  return declaration.initializer.arguments[0];
};
const names = ['nextAutomaticQueuedMessage', 'scheduleQueuedMessage', 'applyQueueLockState', 'toggleQueueLock', 'sendQueuedMessageAsGuidance'];
const callbackSource = names.map(name => `const ${name} = ${callback(name).getText(source)};`).join('\n');
const admission = callback('sendMessage');
const mark = admission.body.statements.findIndex(node => node.getText(source) === 'markSessionRunning(sessionId);');
assert.ok(mark > 0);
const admissionSource = `async function prepareSend(${admission.parameters.map(node => node.getText(source)).join(',')}) {
  ${admission.body.statements.slice(0, mark + 1).map(node => node.getText(source)).join('\n')}
}`;
const code = ts.transpileModule(`${callbackSource}\n${admissionSource}\nglobalThis.api = { ${names.join(',')}, prepareSend };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const item = (id, session = 'a') => ({ id, conversation: { id: session }, text: `Original ${id}\n完整原文`, sourceEnabled: false, createdAt: '2026-09-29' });
  const state = { queued: [item('one'), item('two'), item('other', 'b')], locks: {}, sent: [], error: null, inspecting: null };
  const queuedMessagesRef = { get current() { return state.queued; }, set current(value) { state.queued = value; } };
  const context = {
    backend: {}, queueScope: 'fixture', continuedLocalQueueTurns: new Set(), dispatchingLocalQueues: new Set(),
    queuedMessagesRef, getQueueLocks: () => state.locks,
    setQueueLocks: update => { state.locks = update(state.locks); },
    setQueuedMessages: update => { state.queued = typeof update === 'function' ? update(state.queued) : update; },
    removeQueuedMessage: id => { state.queued = state.queued.filter(item => item.id !== id); },
    queuedMessageConversationId: item => item.conversation.id,
    queueLockRequests: { current: new Set() }, queueLockRevisions: { current: new Map() },
    activeConversationIdRef: { current: 'a' }, sendingSessionsRef: { current: new Set() }, setQueueLockPending() {},
    activeConversationId: 'a', activeTurnIdsRef: { current: {} },
    setError: value => { state.error = value; }, errorMessage: String,
    window: { setTimeout: fn => { state.timers.push(fn); } },
    sendMessageRef: { current: null },
    resolveConversationSource: () => true, splitStreamAttachmentMentions: text => ({ userInput: text, displayInput: text }),
    chatAttachmentsFromOutbound: async () => { if (state.inspecting) await state.inspecting; return []; },
    streamAttachmentsForVision: () => ({ files: [], images: [] }),
    requestContext: {}, selectedModel: 'fixture', localize: text => text,
    conversationsRef: { current: [] }, preparedConversationsRef: { current: {} }, workspaceSwitchesRef: { current: new Map() },
    setConnectionRecoveryByConversation() {}, messagesByConversation: {}, firstUserTitleSource: () => '',
    isSessionSending: id => context.sendingSessionsRef.current.has(id),
    markSessionRunning: id => { state.sent.push(id); },
  };
  state.timers = [];
  vm.runInNewContext(code, context);
  context.sendMessageRef.current = context.api.prepareSend;
  return { state, context, api: context.api, tick: () => { state.timers.splice(0).forEach(fn => fn()); } };
}

test('locking after completion scheduling prevents auto delivery and preserves text/order', async () => {
  const f = fixture(), original = JSON.stringify(f.state.queued);
  f.api.scheduleQueuedMessage('a', 'finished');
  await f.api.toggleQueueLock(); f.tick(); await settle();
  assert.equal(JSON.stringify(f.state.queued), original);
  assert.deepEqual(f.state.sent, []);
  f.api.scheduleQueuedMessage('b', 'finished-other'); f.tick(); await settle();
  assert.deepEqual(f.state.sent, ['b'], 'another chat remains independent');
  await f.api.toggleQueueLock(); f.tick(); await settle();
  assert.deepEqual(f.state.sent, ['b', 'a']);
  assert.deepEqual(f.state.queued.map(item => item.id), ['two']);
});

test('a late lock during attachment preparation retains the original queued message', async () => {
  const f = fixture(); let release;
  f.state.inspecting = new Promise(resolve => { release = resolve; });
  f.api.scheduleQueuedMessage('a', 'finished'); f.tick();
  assert.equal(f.state.queued[0].id, 'one', 'preparation never consumes the queue');
  await f.api.toggleQueueLock(); release(); await settle();
  assert.deepEqual(f.state.sent, []);
  assert.deepEqual(f.state.queued.map(item => item.id), ['one', 'two', 'other']);
});

test('manual delivery during a lock releases only the selected item', async () => {
  const f = fixture(); await f.api.toggleQueueLock();
  const selected = f.state.queued[1];
  await f.api.prepareSend(selected.text, selected.conversation, undefined, undefined, false, { item: selected, automatic: false });
  assert.deepEqual(f.state.sent, ['a']); assert.equal(f.state.locks.a, true);
  assert.deepEqual(f.state.queued.map(item => item.id), ['one', 'other']);
  f.api.scheduleQueuedMessage('a', 'manual-finished'); f.tick(); await settle();
  assert.deepEqual(f.state.sent, ['a']);
});

test('duplicate terminal observers cannot send two queued items', async () => {
  const f = fixture();
  f.api.scheduleQueuedMessage('a', 'same-turn'); f.api.scheduleQueuedMessage('a', 'same-turn');
  f.tick(); await settle();
  assert.deepEqual(f.state.sent, ['a']);
  assert.deepEqual(f.state.queued.map(item => item.id), ['two', 'other']);
});

test('manual send does not hold the queue buttons for the duration of the new loop', async () => {
  const f = fixture(); await f.api.toggleQueueLock(); let release;
  f.state.inspecting = new Promise(resolve => { release = resolve; });
  let returned = false;
  const sent = f.api.sendQueuedMessageAsGuidance('one').then(() => { returned = true; });
  await settle(); assert.equal(returned, true);
  release(); await sent; await settle();
  assert.deepEqual(f.state.sent, ['a']); assert.equal(f.state.locks.a, true);
});

test('failed lock updates restore the confirmed state; stale polls cannot undo an acknowledged lock', async () => {
  const f = fixture();
  f.context.backend.queue = { setLocked: async () => { throw new Error('connection lost'); } };
  await f.api.toggleQueueLock();
  assert.equal(f.state.locks.a, false); assert.match(f.state.error, /connection lost/);
  f.context.backend.queue.setLocked = async () => ({ locked: true, revision: 3 });
  await f.api.toggleQueueLock();
  f.api.applyQueueLockState('a', { locked: false, revision: 2 });
  assert.equal(f.state.locks.a, true);
  f.api.applyQueueLockState('a', { locked: false, revision: 4 });
  assert.equal(f.state.locks.a, false);
});
