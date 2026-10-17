import { readUserPrompt, promptContextMetadata } from '@cardbush/bush-protocol';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
import path from 'node:path';

const attentionStorage = new Map();
const attentionApi = await loadChatTranscript({ source: [
  `export * from ${JSON.stringify(path.resolve('src/features/sessionAttention.ts'))};`,
  `export * from ${JSON.stringify(path.resolve('src/features/taskPlanWaiting.ts'))};`,
].join('\n'), globals: { window: { localStorage: {
  getItem: key => attentionStorage.get(key) ?? null,
  setItem: (key, value) => attentionStorage.set(key, value),
  removeItem: key => attentionStorage.delete(key),
} } } });

test('stored wait categories stay distinct and legacy badges cannot invent a user action', () => {
  const states = Object.fromEntries(['user', 'background', 'dependency', undefined].map((waitingKind, index) => [String(index), {
    sessionId: String(index), kind: 'waiting', ...(waitingKind ? { waitingKind } : {}),
    title: 'Task', body: 'Needs your confirmation', turnId: 'turn', updatedAt: new Date().toISOString(),
  }]));
  attentionApi.persistSessionAttentionState(states);
  const restored = attentionApi.readSessionAttentionState();
  assert.deepEqual(Object.values(restored).map(item => item.waitingKind), ['user', 'background', 'dependency', 'unspecified']);
  assert.equal(restored['3'].body, '', 'discard the old generic instruction to the user');
  assert.equal(Object.values(restored).filter(attentionApi.sessionAttentionNeedsNotification).length, 1);
  assert.deepEqual(Object.values(restored).map(item => attentionApi.sessionAttentionLabel(item, 'zh')),
    ['等待用户确认', '等待后台任务', '等待前置步骤', '等待中']);
  attentionApi.persistSessionAttentionState(restored);
  assert.equal(attentionApi.readSessionAttentionState()['2'].waitingKind, 'dependency');
  attentionApi.persistSessionAttentionState({});
});

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
  const context = { ...attentionApi, exports, useCallback: fn => fn, notifyAttentionSound: event => sounds.push(event),
    backend: {}, attentionByConversationRef: attention, viewActiveRef: { current: true }, activeConversationIdRef: { current: 'visible' },
    isCardbushForeground: () => true, clearSessionAttention(id, kind) { if (attention.current[id]?.kind === kind) delete attention.current[id]; }, localize: zh => zh,
    conversationsRef: { current: [] }, setAttentionByConversation() {},
    window: { cardbushDesktop: { notifySessionAttention: event => { toasts.push(event); return Promise.resolve(); } } } };
  vm.runInNewContext(compiled, context);
  exports.mark('visible', 'completed', 'done', 'turn');
  assert.equal(sounds[0].kind, 'completed');
  assert.equal(toasts.length, 1, 'native window state decides delivery even before a minimize IPC reaches the renderer');
  assert.equal(attention.current.visible, undefined, 'foreground completion still has no unread badge');
  exports.mark('visible', 'waiting', 'approval', 'turn', 'prompt');
  assert.equal(sounds[1].notificationId, 'prompt');
  exports.mark('visible', 'waiting', 'Task pending', 'turn', undefined, 'background');
  assert.equal(attention.current.visible.waitingKind, 'user', 'a pending question cannot be overwritten by a passive plan wait');
  assert.equal(attention.current.visible.interactionId, 'prompt');
  exports.mark('background', 'error', 'failed', 'next');
  assert.equal(sounds[2].kind, 'error');
  const soundCount = sounds.length, toastCount = toasts.length;
  for (const kind of ['background', 'dependency', 'unspecified']) {
    exports.mark('passive', 'waiting', 'Task pending', 'wait-turn', undefined, kind);
    assert.equal(attention.current.passive.waitingKind, kind, 'the same turn may change wait categories');
  }
  assert.equal(sounds.length, soundCount, 'passive waits do not chime');
  assert.equal(toasts.length, toastCount, 'passive waits do not show desktop notifications');
  exports.mark('passive', 'waiting', 'Approve next step', 'wait-turn', undefined, 'user');
  assert.equal(sounds.length, soundCount + 1, 'an explicit user wait promotes the passive state');
  assert.equal(toasts.length, toastCount + 1);
  exports.mark('visible', 'completed', 'done', 'turn');
  assert.equal(attention.current.visible.interactionId, 'prompt', 'a still-open question survives completion');
  const beforeNextQuestion = toasts.length;
  exports.mark('visible', 'waiting', 'approval', 'turn', 'next-prompt');
  assert.equal(toasts.length, beforeNextQuestion + 1, 'two identical questions in one turn have independent notification identities');
  delete attention.current.visible;
  exports.mark('visible', 'waiting', 'Rendering', 'turn', undefined, 'background');
  exports.mark('visible', 'completed', 'done', 'turn');
  assert.equal(attention.current.visible, undefined, 'completion clears a visible passive wait');
});

// Execute the real send/edit callbacks and recovery against controlled transport
// facts. In particular, resolving the stream or loading history is not a terminal.
const hookSource = ts.createSourceFile('hook.ts', fs.readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const hookBody = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat').body;
const callbackNames = ['sendMessage', 'runControlAssistantStream', 'subscribeGoalTurn', 'recoverInterruptedSession', 'refreshGoal', 'markTurnAttention'];
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

function turnFixture({ status, transport, latestTurn, goal = null, goalReadFails = false, afterTerminal, finalText } = {}) {
  const attention = [], candidate = { id: 'chat', title: 'Chat', preview: '', updatedAt: '' };
  const identity = value => value;
  let messages = {};
  const context = {
    ...attentionApi,
    exports: {}, crypto: webcrypto, AbortController, console: { warn() {} },
    window: { setTimeout, cardbushDesktop: {} }, backend: {}, requestContext: {},
    activeConversation: candidate, activeConversationId: 'chat', activeConversationIdRef: { current: 'chat' },
    activeTurnIdsRef: { current: {} }, terminalTurnIdsRef: { current: new Set() }, controllersRef: { current: {} },
    goalTurnControllersRef: { current: {} }, goalTurnCursorRef: { current: {} }, goalStreamCheckpointsRef: { current: {} },
    workspaceSwitchesRef: { current: new Map() }, conversationsRef: { current: [] }, preparedConversationsRef: { current: { chat: candidate } },
    messagesByConversation: messages, messagesByConversationRef: { current: messages }, viewActiveRef: { current: true },
    selectedModel: 'fixture', defaultModelId: 'fixture', availableModels: [], managedModelConfigs: [],
    referencePlanMode: 'normal', permissionMode: 'ask', subagentPermissionRouting: 'parent', languageRef: { current: 'zh' },
    resolveConversationModelId: () => 'fixture', resolveModelReasoningEffort: () => 'default', selectConversationModel() {}, readConversationModel: () => 'fixture',
    modelConfigFor: () => ({}), selectedModelName: () => 'fixture', normalizeDisabledToolNames: () => [],
    readUserPrompt, promptContextMetadata,
    selectedTeamReference: () => undefined, teamReferenceInstructions: () => undefined,
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
    createFrameStreamBuffers: () => ({ push() {}, completeSegment: async () => {}, completeRoute: async () => {}, flushToolBoundary() {},
      releaseTerminal: async () => {}, flushAllStreaming: async () => {}, checkpoint: () => ({}), dispose() {} }),
    assignTurnToLocalMessages: identity, markOptimisticChatRequestAccepted: identity, applyAssistantStreamRoute: identity,
    ensureBackgroundTurnAssistant: identity, appendAssistantDelta: identity, markLocalAssistantTurnCompleted: identity,
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
    if (finalText) handlers.onFinalAssistantText(finalText, { turnId: 'turn', messageId: 'message' });
    if (status) handlers.onDone(terminalFact(status));
    if (afterTerminal) await afterTerminal;
    if (transport === 'aborted') controller.abort();
    if (transport) throw Object.assign(Error('stream interrupted'), { transport: transport !== 'other' });
  };
  context.streamChat = request => stream(context.controllersRef.current.chat, request);
  context.streamTurnEvents = request => stream(context.goalTurnControllersRef.current.chat.controller, request);
  return { context, attention, run: async route => {
    if (route === 'send') await context.sendMessage('test message');
    else if (route === 'host') {
      context.subscribeGoalTurn('chat', 'turn');
      for (let attempt = 0; attempt < 20 && context.goalTurnControllersRef.current.chat; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(context.goalTurnControllersRef.current.chat, undefined, 'host observer settles');
    }
    else await context.runControlAssistantStream({ conversation: candidate, initialMessages: [], rollbackMessages: [],
      tempAssistant: { id: 'assistant', conversationId: 'chat', role: 'assistant', content: '' }, stream });
    return attention.map(args => args[1]);
  } };
}

for (const route of ['send', 'edit']) {
  test(`${route}: completion delivery does not wait for decorative animation or history refresh`, async () => {
    const f = turnFixture({ status: 'completed' });
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    f.context.createFrameStreamBuffers = () => ({ push() {}, completeSegment: async () => {}, flushToolBoundary() {},
      releaseTerminal: () => pending, flushAllStreaming: async () => {}, dispose() {} });
    f.context.loadTeamFlow = async () => { assert.equal(f.attention[0]?.[1], 'completed'); };
    const finished = f.run(route);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.attention[0]?.[1], 'completed', 'terminal delivery is independent of the UI drain');
    release(); await finished;
  });
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

test('reattached ordinary host turns notify without a Goal and before loading history', async () => {
  for (const [status, expected] of [['completed', ['completed']], ['failed', ['error']], ['stopped', []]]) {
    const f = turnFixture({ status });
    f.context.fetchSessionMessages = async () => {
      assert.deepEqual(f.attention.map(args => args[1]), expected, 'terminal is reported before history is read');
      return { messages: [] };
    };
    assert.deepEqual(await f.run('host'), expected);
  }
});

for (const route of ['send', 'edit', 'host']) {
  test(`${route}: a terminal notifies while the transport is still reconciling its final snapshot`, async () => {
    let release;
    const afterTerminal = new Promise(resolve => { release = resolve; });
    const f = turnFixture({ status: 'completed', afterTerminal, finalText: 'Completed result' });
    const finished = f.run(route);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.attention[0]?.[1], 'completed');
    assert.equal(f.attention[0]?.[2], 'Completed result');
    release(); await finished;
  });
}

test('host recovery ignores old turns, aborts and active Goals, but reports matching terminals', async () => {
  for (const [latestTurn, expected] of [[undefined, []], [terminalFact('completed', 'older'), []],
    [terminalFact('running'), []], [terminalFact('completed'), ['completed']], [terminalFact('failed'), ['error']]]) {
    assert.deepEqual(await turnFixture({ latestTurn }).run('host'), expected);
  }
  assert.deepEqual(await turnFixture({ transport: 'aborted', latestTurn: terminalFact('completed') }).run('host'), []);
  assert.deepEqual(await turnFixture({ status: 'completed', goal: { status: 'active' } }).run('host'), []);
  assert.deepEqual(await turnFixture({ status: 'completed', goal: { status: 'blocked', objective: 'Input' } }).run('host'), ['waiting']);
});

test('non-network history reconciliation uses the matching terminal rather than any assistant final message', async () => {
  for (const [status, expected] of [['completed', ['completed']], ['failed', ['error']], ['stopped', []]]) {
    assert.deepEqual(await turnFixture({ transport: 'other', latestTurn: terminalFact(status) }).run('send'), expected);
  }
  assert.deepEqual(await turnFixture({ transport: 'other', latestTurn: terminalFact('completed', 'older-turn') }).run('send'), ['error']);
});

test('task-plan waits carry their explicit category, including during an active goal', async () => {
  for (const goal of [null, { status: 'active', objective: 'continue' }]) {
    for (const kind of ['user', 'background', 'dependency', undefined]) {
      const f = turnFixture({ goal });
      await f.context.markTurnAttention('chat', { ...terminalFact('completed'), stopReason: 'task_plan_waiting',
        ...(kind ? { stopDetails: { planWaiting: { kind, reason: 'Exact dependency' } } } : {}) }, 'partial');
      assert.deepEqual(f.attention.map(args => args[1]), ['waiting']);
      assert.equal(f.attention[0][5], kind ?? 'unspecified');
      assert.equal(attentionApi.sessionAttentionNeedsNotification({ kind: 'waiting', waitingKind: f.attention[0][5] }), kind === 'user');
    }
  }
});
