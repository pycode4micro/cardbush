import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { installWindowVisibilityEvents, isWindowVisible } from '../dist-electron/windowVisibility.js';
import { showWindowPopupMenu } from '../dist-electron/windowPopupMenu.js';

function windowFixture() {
  const target = new EventEmitter(), contents = new EventEmitter(), sent = [];
  Object.assign(target, { visible: false, minimized: false, destroyed: false, webContents: contents,
    isVisible: () => target.visible, isMinimized: () => target.minimized, isDestroyed: () => target.destroyed });
  Object.assign(contents, { destroyed: false, crashed: false, isDestroyed: () => contents.destroyed,
    isCrashed: () => contents.crashed,
    mainFrame: { isDestroyed: () => contents.destroyed, detached: false, send: (...args) => sent.push(args) } });
  return { target, contents, sent };
}

test('native visibility is per window, includes minimize and replays after renderer reload', () => {
  const { target, contents, sent } = windowFixture();
  installWindowVisibilityEvents(target);
  contents.emit('dom-ready');
  assert.equal(sent.at(-1)[1], false);
  target.visible = true; target.emit('show');
  assert.equal(isWindowVisible(target), true);
  assert.equal(sent.at(-1)[1], true);
  target.minimized = true; target.emit('minimize');
  assert.equal(sent.at(-1)[1], false);
  target.emit('minimize');
  assert.equal(sent.length, 3, 'duplicate native events do not publish');
  contents.emit('dom-ready');
  assert.equal(sent.length, 4, 'reload receives even an unchanged state');
  target.minimized = false; target.emit('restore');
  assert.equal(sent.at(-1)[1], true);
  target.visible = false; target.emit('hide');
  assert.equal(sent.at(-1)[1], false);
  assert.equal(isWindowVisible(windowFixture().target), false);
});

test('repeated installation and show/hide cycles do not accumulate native listeners', () => {
  const { target, contents } = windowFixture();
  const dispose = installWindowVisibilityEvents(target);
  for (let index = 0; index < 100; index++) {
    assert.equal(installWindowVisibilityEvents(target), dispose);
    target.visible = true; target.emit('show');
    target.visible = false; target.emit('hide');
  }
  assert.equal(target.listenerCount('hide'), 1);
  assert.equal(contents.listenerCount('dom-ready'), 1);
  target.destroyed = true; target.emit('closed');
  dispose();
  assert.deepEqual(target.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
});

test('destroying web contents cleans visibility listeners before window destruction', () => {
  const { target, contents } = windowFixture();
  installWindowVisibilityEvents(target);
  contents.destroyed = true; contents.emit('destroyed');
  assert.deepEqual(target.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
});

test('hide/restore while a renderer has crashed does not send to a dead frame', () => {
  const { target, contents, sent } = windowFixture();
  installWindowVisibilityEvents(target);
  contents.crashed = true;
  target.visible = true; target.emit('show');
  target.visible = false; target.emit('hide');
  assert.equal(sent.length, 0);
  contents.crashed = false; contents.emit('dom-ready');
  assert.equal(sent.at(-1)[1], false);
});

function menuFixture() {
  return { shown: 0, closed: 0,
    popup(options) { this.shown++; this.options = options; },
    closePopup() { this.closed++; this.options.callback(); },
  };
}

test('native popups are replaced and close when the owner hides or minimizes', () => {
  const { target, contents } = windowFixture(); target.visible = true;
  const first = menuFixture(), second = menuFixture();
  showWindowPopupMenu(target, first);
  showWindowPopupMenu(target, second);
  assert.equal(first.closed, 1);
  first.options.callback(); // Late callback must not forget the replacement.
  assert.equal(target.listenerCount('hide'), 1);
  target.emit('hide');
  assert.equal(second.closed, 1);
  assert.deepEqual(target.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
  showWindowPopupMenu(target, second);
  target.emit('minimize');
  assert.equal(second.closed, 2);
});

test('popup close, failure, and window destruction all release ownership/listeners', () => {
  const { target, contents } = windowFixture(); target.visible = true;
  for (let index = 0; index < 100; index++) {
    const menu = menuFixture(); showWindowPopupMenu(target, menu); menu.options.callback();
  }
  assert.deepEqual(target.eventNames(), []);
  assert.deepEqual(contents.eventNames(), []);
  assert.throws(() => showWindowPopupMenu(target, { popup() { throw Error('native failure'); } }), /native failure/);
  assert.deepEqual(target.eventNames(), []);
  const menu = menuFixture(); showWindowPopupMenu(target, menu);
  target.destroyed = true; target.emit('closed');
  assert.equal(menu.closed, 0, 'do not call native methods on a destroyed window');
  assert.deepEqual(contents.eventNames(), []);
  showWindowPopupMenu(target, menu);
  assert.equal(menu.shown, 1);
});

test('hidden windows do not create native menus; one window cannot close another menu', () => {
  const a = windowFixture().target, b = windowFixture().target, menuA = menuFixture(), menuB = menuFixture();
  showWindowPopupMenu(a, menuA); assert.equal(menuA.shown, 0);
  a.visible = b.visible = true;
  showWindowPopupMenu(a, menuA); showWindowPopupMenu(b, menuB);
  a.emit('hide'); assert.equal(menuA.closed, 1); assert.equal(menuB.closed, 0);
  b.webContents.emit('destroyed'); assert.equal(menuB.closed, 1);
});

const rendererCode = ts.transpileModule(readFileSync('src/shared/windowVisibility.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function rendererFixture(withNative = true) {
  const document = new EventTarget();
  document.documentElement = { dataset: {} }; document.visibilityState = 'visible';
  let receive, resolve, unsubscribed = 0;
  const window = { cardbushDesktop: withNative ? {
    onWindowVisibilityChanged: fn => { receive = fn; return () => { unsubscribed++; }; },
    isWindowVisible: () => new Promise(done => { resolve = done; }),
  } : undefined };
  const exports = {};
  vm.runInNewContext(rendererCode, { exports, document, window, Event });
  return { api: exports, document, native: value => receive(value), resolve: value => resolve(value), unsubscribed: () => unsubscribed };
}

test('native visibility wins over unthrottled document state and stale initial responses', async () => {
  const f = rendererFixture();
  const dispose = f.api.installWindowVisibility();
  let changes = 0; const unwatch = f.api.watchWindowVisibility(() => { changes++; });
  f.native(false);
  assert.equal(f.document.visibilityState, 'visible', 'do not override browser APIs');
  assert.equal(f.api.isWindowVisible(), false);
  assert.equal(f.document.documentElement.dataset.windowVisible, 'false');
  f.resolve(true); await Promise.resolve();
  assert.equal(f.api.isWindowVisible(), false, 'stale initial response cannot restart hidden animations');
  f.native(false); assert.equal(changes, 1);
  f.native(true); assert.equal(changes, 2);
  unwatch(); dispose();
  f.native(false); assert.equal(changes, 2);
  assert.equal(f.unsubscribed(), 1);
  assert.equal(f.document.documentElement.dataset.windowVisible, undefined);
});

test('native visibility query initializes hidden renderers and disposed queries cannot change state', async () => {
  const f = rendererFixture(); const dispose = f.api.installWindowVisibility();
  f.resolve(false); await Promise.resolve();
  assert.equal(f.api.isWindowVisible(), false);
  dispose();
  const later = rendererFixture(); const stop = later.api.installWindowVisibility(); stop();
  later.resolve(false); await Promise.resolve();
  assert.equal(later.api.isWindowVisible(), true);
});

test('ordinary browser previews retain Page Visibility API behavior', () => {
  const f = rendererFixture(false); const dispose = f.api.installWindowVisibility();
  f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.api.isWindowVisible(), false);
  assert.equal(f.document.documentElement.dataset.windowVisible, 'false');
  f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.api.isWindowVisible(), true);
  dispose();
});
