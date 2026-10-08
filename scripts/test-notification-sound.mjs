import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync('src/features/notificationSound.ts', 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
  const storage = new Map(), window = new EventTarget();
  const state = { starts: 0, stopped: 0, now: 10000, writeFails: false, deviceFails: false, resume: undefined };
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => {
    if (state.writeFails) throw Error('Storage unavailable'); storage.set(key, value);
  } };
  const module = { exports: {} };
  class AudioContext {
    state = state.resume ? 'suspended' : 'running'; currentTime = 0; destination = {};
    constructor() { if (state.deviceFails) throw Error('No audio device'); }
    async resume() { await state.resume?.(); this.state = 'running'; }
    createOscillator() { return { frequency: {}, connect() {}, disconnect() {},
      start() { state.starts++; }, stop() { state.stopped++; } }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
  }
  vm.runInNewContext(code, { module, exports: module.exports, window, Event, AudioContext, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return state.now; } } });
  return { api: module.exports, state, storage, window };
}

test('notification preferences default on, clamp volume and preserve mute even when storage fails', () => {
  const { api, state, storage } = fixture();
  assert.equal(api.readNotificationSoundPreferences().enabled, true);
  assert.equal(api.readNotificationSoundPreferences().volume, 50);
  for (const [input, expected] of [[-20, 0], [120, 100], [NaN, 50], ['90', 50], [44.8, 45]]) {
    assert.equal(api.normalizeNotificationSoundPreferences({ volume: input }).volume, expected);
  }
  api.saveNotificationSoundPreferences({ enabled: false, volume: 35 });
  assert.equal(JSON.parse(storage.get(api.notificationSoundStorageKey)).enabled, false);
  state.writeFails = true;
  api.saveNotificationSoundPreferences({ enabled: false, volume: 0 });
  assert.equal(api.readNotificationSoundPreferences().volume, 0);
});

test('settings changes notify mounted panels and cross-window updates remain live', () => {
  const { api, storage, window } = fixture();
  let calls = 0;
  const stop = api.subscribeNotificationSoundPreferences(() => calls++);
  api.saveNotificationSoundPreferences({ enabled: false, volume: 25 });
  assert.equal(calls, 1);
  storage.set(api.notificationSoundStorageKey, '{"enabled":true,"volume":75}');
  const event = new Event('storage'); event.key = api.notificationSoundStorageKey;
  window.dispatchEvent(event);
  assert.equal(calls, 2); assert.equal(api.readNotificationSoundPreferences().volume, 75);
  stop(); window.dispatchEvent(event); assert.equal(calls, 2);
});

test('completion replay is silent while new turns, prompts and remote scopes have distinct identities', () => {
  const { api } = fixture(), gate = new api.NotificationSoundGate();
  const event = { sessionId: 'chat', turnId: 'turn', kind: 'completed' };
  assert.equal(gate.accept(event), true);
  assert.equal(gate.accept(event), false);
  assert.equal(gate.accept({ ...event, turnId: 'next' }), true);
  assert.equal(gate.accept({ ...event, scope: 'remote:one' }), true);
  assert.equal(gate.accept({ ...event, kind: 'waiting', notificationId: 'approval-1' }), true);
  assert.equal(gate.accept({ ...event, kind: 'waiting', notificationId: 'approval-1' }), false);
  assert.equal(gate.accept({ ...event, kind: 'waiting', notificationId: 'approval-2' }), true);
  assert.equal(gate.accept({ ...event, kind: 'error' }), true);
  assert.equal(gate.accept({ ...event, sessionId: ' ' }), false);
  const early = { sessionId: 'early', kind: 'error' };
  assert.equal(gate.accept(early, 0), true);
  assert.equal(gate.accept(early, 500), false);
  assert.equal(gate.accept(early, 2000), true, 'a later pre-turn failure is a new notification');
});

test('muting and zero volume suppress automatic audio, preview is explicit, and bursts do not overlap', async () => {
  const { api, state } = fixture();
  api.saveNotificationSoundPreferences({ enabled: false, volume: 50 });
  assert.equal(await api.playNotificationSound(), false);
  assert.equal(state.starts, 0);
  assert.equal(await api.playNotificationSound(true), true);
  assert.equal(state.starts, 2, 'one two-note chime');
  api.saveNotificationSoundPreferences({ enabled: true, volume: 50 });
  assert.equal(await api.playNotificationSound(), false, 'do not stack a second chime immediately');
  state.now += 1000;
  assert.equal(await api.playNotificationSound(), true);
  const stopped = state.stopped;
  api.saveNotificationSoundPreferences({ enabled: true, volume: 0 });
  assert.ok(state.stopped > stopped, 'zero volume stops the current chime');
  assert.equal(await api.playNotificationSound(true), false);
});

test('notifications are consumed while muted and device failures never interrupt the chat', async () => {
  const { api, state } = fixture();
  const event = { sessionId: 'chat', turnId: 'turn', kind: 'completed' };
  api.saveNotificationSoundPreferences({ enabled: false, volume: 50 });
  api.notifyAttentionSound(event);
  api.saveNotificationSoundPreferences({ enabled: true, volume: 50 });
  api.notifyAttentionSound(event);
  assert.equal(state.starts, 0, 'enabling audio must not replay old notifications');
  state.deviceFails = true;
  assert.equal(await api.playNotificationSound(), false);
  state.deviceFails = false;
  assert.equal(await api.playNotificationSound(), true);
});

test('mute during audio activation prevents deferred sound', async () => {
  const { api, state } = fixture();
  let ready;
  state.resume = () => new Promise(resolve => { ready = resolve; });
  const pending = api.playNotificationSound();
  api.saveNotificationSoundPreferences({ enabled: false, volume: 50 });
  ready();
  assert.equal(await pending, false); assert.equal(state.starts, 0);
});

test('an audio context that never resumes times out instead of replaying on later focus', async () => {
  const { api, state } = fixture();
  state.resume = () => new Promise(() => {});
  assert.equal(await api.playNotificationSound(), false);
  assert.equal(state.starts, 0);
});

test('the actual chat callback includes foreground completion, waiting and error cues before badge suppression', () => {
  const hook = ts.createSourceFile('hook.ts', fs.readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const body = hook.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat').body;
  const declaration = body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name?.text === 'markSessionAttention');
  const compiled = ts.transpileModule(declaration.getText(hook) + '\nexports.mark = markSessionAttention;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sounds = [], toasts = [], exports = {}, attention = { current: {} };
  const context = { exports, useCallback: fn => fn, notifyAttentionSound: event => sounds.push(event),
    backend: {}, attentionByConversationRef: attention, viewActiveRef: { current: true }, activeConversationIdRef: { current: 'visible' },
    isCardbushForeground: () => true, clearSessionAttention() {}, localize: zh => zh,
    conversationsRef: { current: [] }, setAttentionByConversation() {},
    window: { cardbushDesktop: { notifySessionAttention: event => { toasts.push(event); return Promise.resolve(); } } } };
  vm.runInNewContext(compiled, context);
  exports.mark('visible', 'completed', 'done', 'turn');
  assert.equal(sounds[0].kind, 'completed'); assert.equal(toasts.length, 0);
  exports.mark('visible', 'waiting', 'approval', 'turn', 'prompt');
  assert.equal(sounds[1].notificationId, 'prompt');
  exports.mark('background', 'error', 'failed', 'next');
  assert.equal(sounds[2].kind, 'error');
});

// Execute the real send/edit callbacks and recovery against controlled transport
// facts. In particular, resolving the stream or loading history is not a terminal.
const hookSource = ts.createSourceFile('hook.ts', fs.readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const hookBody = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat').body;
const callbackNames = ['sendMessage', 'runControlAssistantStream', 'recoverInterruptedSession', 'refreshGoal', 'markTurnAttention'];
const callbackCode = callbackNames.map(name => {
  const declaration = hookBody.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(hookSource) === name);
  return `exports.${name} = ${declaration.initializer.arguments[0].getText(hookSource)};`;
}).join('\n');
const helperCode = ['withTerminalTurnId', 'terminalSnapshotFromLatestTurn', 'matchingTerminalSnapshot'].map(name =>
  hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(hookSource)).join('\n');
const attachmentSource = ts.createSourceFile('attachments.ts', fs.readFileSync('src/shared/chatAttachments.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const attachments = attachmentSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'chatAttachmentsFromOutbound')
  .getText(attachmentSource).replace(/^export /, '');
const turnCode = ts.transpileModule(`${helperCode}\n${attachments}\n${callbackCode}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const terminalFact = (status, turnId = 'turn') => ({ turnId, status, stopped: status === 'stopped', stopReason: '', stopScenario: '', raw: {} });

function turnFixture({ status, transport, latestTurn, goal = null, goalReadFails = false } = {}) {
  const attention = [], candidate = { id: 'chat', title: 'Chat', preview: '', updatedAt: '' };
  const identity = value => value;
  let messages = {};
  const context = {
    exports: {}, crypto: webcrypto, AbortController, console: { warn() {} },
    window: { setTimeout, cardbushDesktop: {} }, backend: {}, requestContext: {},
    activeConversation: candidate, activeConversationId: 'chat', activeConversationIdRef: { current: 'chat' },
    activeTurnIdsRef: { current: {} }, terminalTurnIdsRef: { current: new Set() }, controllersRef: { current: {} },
    workspaceSwitchesRef: { current: new Map() }, conversationsRef: { current: [] }, preparedConversationsRef: { current: { chat: candidate } },
    messagesByConversation: messages, messagesByConversationRef: { current: messages }, viewActiveRef: { current: true },
    selectedModel: 'fixture', defaultModelId: 'fixture', availableModels: [], managedModelConfigs: [],
    referencePlanMode: 'normal', permissionMode: 'ask', subagentPermissionRouting: 'parent', languageRef: { current: 'zh' },
    resolveConversationModelId: () => 'fixture', resolveModelReasoningEffort: () => 'default', selectConversationModel() {}, readConversationModel: () => 'fixture',
    modelConfigFor: () => ({}), selectedModelName: () => 'fixture', normalizeDisabledToolNames: () => [],
    splitStreamAttachmentMentions: text => ({ displayInput: text, userInput: text, files: [], images: [] }), streamAttachmentsForVision: identity,
    firstUserTitleSource: (_messages, text) => text, resolveConversationSource: () => true, isSessionSending: () => false,
    persistPreparedConversation: async () => candidate, persistAutoConversationTitle() {},
    conversationProjectRequestDir: () => undefined, conversationWorkspaceRoot: () => undefined,
    setMessagesByConversation: update => { messages = update(messages); context.messagesByConversationRef.current = messages; },
    setConversations: update => update([]), upsertConversationPreview: identity, conversationPreviewFromMessages: () => '',
    markSessionRunning: (sessionId, turnId) => { if (turnId) context.activeTurnIdsRef.current[sessionId] = turnId; },
    clearSessionRunning() {}, markSessionDone() {}, clearConnectionRecovery() {}, setPendingInteraction() {},
    setError() {}, setConnectionRecoveryByConversation() {}, beginHistoryRead: () => ({}), isHistoryReadCurrent: () => true, applyHistoryRead() {},
    fetchMessages: async () => [], fetchSessionMessages: async () => ({ messages: [], latestTurn }), loadTeamFlow: async () => null, reloadConversations: async () => {},
    createFrameStreamBuffers: () => ({ push() {}, completeSegment: async () => {}, flushToolBoundary() {}, releaseTerminal: async () => {}, flushAllStreaming: async () => {}, dispose() {} }),
    assignTurnToLocalMessages: identity, markOptimisticChatRequestAccepted: identity, applyAssistantStreamRoute: identity,
    markLocalMessageTurnStarted: identity, applyTurnTerminalSnapshot: identity, appendToolExecution: identity, applyGoalExecution() {},
    goalAvailable: true, goalByConversationRef: { current: { chat: goal } }, setGoalByConversation() {}, currentExperimentalGoal: goals => goals[0],
    fetchExperimentalGoals: async () => { if (goalReadFails) throw Error('goal read interrupted'); return goal ? [goal] : []; },
    markSessionAttention: (...args) => attention.push(args), localize: zh => zh, truncateText: text => text,
    scheduleQueuedMessage() {}, isPendingInteractionConflictError: () => false,
    isNetworkTransportError: error => error.transport === true, errorMessage: String, rawErrorMessage: String,
  };
  vm.runInNewContext(turnCode, context);
  Object.assign(context, context.exports);
  const stream = async (controller, handlers) => {
    handlers.onStart({ turnId: 'turn' });
    // Several loop rounds and tool results must remain quiet until a real terminal.
    for (let round = 0; round < 3; round++) {
      handlers.onDelta('partial', { turnId: 'turn' });
      handlers.onAssistantSegmentCompleted('partial', { turnId: 'turn' });
      handlers.onToolExecution({ id: `tool-${round}`, state: 'completed' });
      assert.equal(attention.length, 0, 'loop output does not notify');
    }
    if (status) handlers.onDone(terminalFact(status));
    if (transport === 'aborted') controller.abort();
    if (transport) throw Object.assign(Error('stream interrupted'), { transport: transport !== 'other' });
  };
  context.streamChat = request => stream(context.controllersRef.current.chat, request);
  return { context, attention, run: async route => {
    if (route === 'send') await context.sendMessage('test message');
    else await context.runControlAssistantStream({ conversation: candidate, initialMessages: [], rollbackMessages: [],
      tempAssistant: { id: 'assistant', conversationId: 'chat', role: 'assistant', content: '' }, stream });
    return attention.map(args => args[1]);
  } };
}

for (const route of ['send', 'edit']) {
  test(`${route}: stream endings notify only successful or failed terminal facts`, async () => {
    for (const [status, expected] of [[undefined, []], ['stopped', []], ['failed', ['error']], ['completed', ['completed']], ['awaiting_user_action', []]]) {
      assert.deepEqual(await turnFixture({ status }).run(route), expected, status ?? 'no terminal');
    }
  });
  test(`${route}: recovery never mistakes an older turn or history without a terminal for completion`, async () => {
    for (const [latestTurn, expected] of [[undefined, []], [terminalFact('completed', 'older-turn'), []],
      [terminalFact('running'), []], [terminalFact('completed'), ['completed']], [terminalFact('failed'), ['error']], [terminalFact('stopped'), []]]) {
      assert.deepEqual(await turnFixture({ transport: 'network', latestTurn }).run(route), expected);
    }
    assert.deepEqual(await turnFixture({ transport: 'aborted', latestTurn: terminalFact('completed') }).run(route), []);
  });
  test(`${route}: active goal continuation stays quiet even when refreshing its state fails`, async () => {
    for (const goalReadFails of [false, true]) {
      assert.deepEqual(await turnFixture({ status: 'completed', goal: { status: 'active', objective: 'continue' }, goalReadFails }).run(route), []);
    }
    assert.deepEqual(await turnFixture({ status: 'completed', goal: { status: 'blocked', objective: 'needs input' } }).run(route), ['waiting']);
  });
}

test('non-network history reconciliation uses the matching terminal rather than any assistant final message', async () => {
  for (const [status, expected] of [['completed', ['completed']], ['failed', ['error']], ['stopped', []]]) {
    assert.deepEqual(await turnFixture({ transport: 'other', latestTurn: terminalFact(status) }).run('send'), expected);
  }
  assert.deepEqual(await turnFixture({ transport: 'other', latestTurn: terminalFact('completed', 'older-turn') }).run('send'), ['error']);
});

test('a genuine task-plan wait is an input cue rather than a completion cue', async () => {
  const f = turnFixture();
  await f.context.markTurnAttention('chat', { ...terminalFact('completed'), stopReason: 'task_plan_waiting' }, 'partial');
  assert.deepEqual(f.attention.map(args => args[1]), ['waiting']);
});
