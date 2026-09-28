import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

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
