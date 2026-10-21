import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const routing = {};
vm.runInNewContext(compile(readFileSync('electron/sessionAttentionRouting.ts', 'utf8')), { exports: routing });
const source = ts.createSourceFile('main.ts', readFileSync('electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['sanitizeSessionAttentionPayload', 'showSessionAttentionNotification', 'sessionAttentionToastXml', 'escapeXmlAttribute', 'escapeXmlText'];
const code = compile(names.map(name => source.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === name).getText(source)).join('\n') + '\nexports.show = showSessionAttentionNotification;');
const nativeVisibility = {};
vm.runInNewContext(compile(readFileSync('electron/windowVisibility.ts', 'utf8')), {
  exports: nativeVisibility, require: () => ({}),
});

function fixture(initial = {}) {
  const state = { visible: true, focused: false, minimized: false, destroyed: false, supported: true, throws: false, ...initial };
  const notices = [], opened = [], logs = [];
  let flashes = 0;
  const window = {
    isVisible: () => state.visible, isFocused: () => state.focused,
    isMinimized: () => state.minimized, isDestroyed: () => state.destroyed,
    flashFrame: () => { assert.equal(state.destroyed, false); flashes++; },
  };
  class Notification extends EventEmitter {
    static isSupported() { return state.supported; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { if (state.throws) throw Error('native delivery unavailable'); }
  }
  const active = new Set();
  const context = { exports: {}, ...routing, ...nativeVisibility, process: { platform: 'win32' },
    sessionAttentionNotificationGate: new routing.SessionAttentionNotificationGate(),
    mainWindow: initial.noWindow ? null : window, Notification, activeSessionAttentionNotifications: active,
    randomUUID: () => String(notices.length), loadCardbushIcon: () => undefined,
    activateSessionAttention: id => opened.push(id), appendDebugLog: (...args) => logs.push(args),
  };
  vm.runInNewContext(code, context);
  return { state, notices, opened, logs, active, flashes: () => flashes, show: context.exports.show };
}
const attention = { sessionId: 'chat', turnId: 'turn', kind: 'completed', title: 'Task', body: 'Done' };

test('native delivery uses visibility, focus AND minimize state', () => {
  for (const [state, expected] of [
    [{ focused: true }, false], [{ focused: false }, true],
    [{ focused: true, minimized: true }, true], [{ focused: true, visible: false }, true],
    [{ destroyed: true }, true], [{ noWindow: true }, true],
  ]) {
    const f = fixture(state);
    assert.equal(f.show(attention).shown, expected, JSON.stringify(state));
    assert.equal(f.notices.length, Number(expected));
  }
});

test('viewed completions and replayed terminals do not become late or duplicate toasts', () => {
  const f = fixture({ focused: true });
  assert.equal(f.show(attention).shown, false);
  f.state.minimized = true;
  assert.equal(f.show(attention).shown, false, 'reading in foreground consumes this delivery identity');
  assert.equal(f.show({ ...attention, turnId: 'next' }).shown, true);
  assert.equal(f.show({ ...attention, turnId: 'next', body: 'Updated preview' }).shown, false);
  assert.equal(f.notices.length, 1);
  f.notices[0].emit('close');
  assert.equal(f.active.size, 0);
  assert.equal(f.show({ ...attention, turnId: 'next' }).shown, false, 'dismissing a toast does not allow its replay');
});

test('questions in one turn and failures have separate identities and retain click navigation', () => {
  const f = fixture();
  const question = { ...attention, kind: 'interaction', interactionId: 'question-1' };
  assert.equal(f.show(question).shown, true);
  assert.equal(f.show(question).shown, false);
  assert.equal(f.show({ ...question, interactionId: 'question-2' }).shown, true);
  assert.equal(f.show({ ...attention, kind: 'error' }).shown, true);
  f.notices[1].emit('click');
  assert.deepEqual(f.opened, ['chat']);
  assert.match(f.notices[1].options.toastXml, /cardbush-attention-v1:chat/);
  assert.equal(f.notices[1].options.silent, true, 'keep the configured chime as the sole sound source');
});

test('legacy waits, unknown states and unidentified Solutions do not become native notifications', () => {
  const f = fixture();
  for (const kind of ['waiting', 'warning', 'approval', 'interaction', undefined]) {
    assert.equal(f.show({ ...attention, kind }).shown, false);
  }
  assert.equal(f.notices.length, 0);
});

test('native failures release ownership, record diagnostics and allow a later delivery attempt', () => {
  const f = fixture();
  assert.equal(f.show(attention).shown, true);
  f.notices[0].emit('failed', {}, 'Windows rejected toast');
  assert.equal(f.active.size, 0);
  assert.equal(f.logs[0][1].stage, 'failed');
  assert.match(f.logs[0][1].error, /rejected/);
  assert.equal(f.show(attention).shown, true);
  const sync = fixture({ throws: true });
  assert.equal(sync.show(attention).shown, false);
  assert.equal(sync.active.size, 0);
  sync.state.throws = false;
  assert.equal(sync.show(attention).shown, true);
  const unavailable = fixture({ supported: false });
  assert.equal(unavailable.show(attention).shown, false);
  unavailable.state.supported = true;
  assert.equal(unavailable.show(attention).shown, true);
  assert.equal(unavailable.show({ ...attention, sessionId: ' ' }).shown, false);
});

test('legacy requests have a bounded duplicate window; the native gate has bounded memory', () => {
  const gate = new routing.SessionAttentionNotificationGate();
  const legacy = { sessionId: 'chat', kind: 'error' };
  assert.equal(gate.accept(legacy, 0), true);
  assert.equal(gate.accept(legacy, 1), false);
  assert.equal(gate.accept(legacy, routing.sessionAttentionDuplicateWindowMs + 1), true);
  gate.accept(attention);
  for (let index = 0; index < 512; index++) gate.accept({ ...attention, turnId: String(index) });
  assert.equal(gate.accept(attention), true, 'old delivery records are evicted');
});

test('unthrottled renderer visibility and stale focus cannot mark a minimized conversation as read', async () => {
  const document = new EventTarget(), window = new EventTarget();
  document.documentElement = { dataset: {} }; document.visibilityState = 'visible';
  let focus = true, receive, resolveInitial;
  document.hasFocus = () => focus;
  window.cardbushDesktop = {
    onWindowVisibilityChanged: callback => { receive = callback; return () => {}; },
    isWindowVisible: () => new Promise(resolve => { resolveInitial = resolve; }),
  };
  const api = await loadChatTranscript({ source: [
    `export * from ${JSON.stringify(path.resolve('src/features/sessionAttention.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/shared/windowVisibility.ts'))};`,
  ].join('\n'), globals: { document, window, Event } });
  const dispose = api.installWindowVisibility();
  let readReceipts = 0;
  const unwatch = api.watchWindowVisibility(() => { if (api.isCardbushForeground()) readReceipts++; });
  receive(false);
  assert.equal(api.isCardbushForeground(), false, 'native minimize beats stale DOM focus');
  resolveInitial(true); await Promise.resolve();
  assert.equal(api.isCardbushForeground(), false, 'a stale initial IPC response cannot mark it read');
  assert.equal(readReceipts, 0);
  receive(true);
  assert.equal(api.isCardbushForeground(), true);
  assert.equal(readReceipts, 1, 'restoring the visible focused conversation marks it read');
  focus = false;
  assert.equal(api.isCardbushForeground(), false);
  focus = true; document.visibilityState = 'hidden';
  assert.equal(api.isCardbushForeground(), false);
  unwatch(); dispose();
});
