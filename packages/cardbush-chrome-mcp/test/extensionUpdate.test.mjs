import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildBrowserExtension, extensionBuildSource, extensionRoot } from '../../../scripts/build-browser-extension.mjs';

const popupSource = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function popup(initialState) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: false, disabled: false, open: true, textContent: '', value: '', dataset: {},
      listeners: {}, classes: new Set(),
      addEventListener(event, listener) { this.listeners[event] = listener; },
      replaceChildren(...children) { this.children = children; },
      classList: {
        toggle(name, enabled) { if (enabled) nodes.get(id).classes.add(name); else nodes.get(id).classes.delete(name); },
        add(name) { nodes.get(id).classes.add(name); },
      },
    });
    return nodes.get(id);
  };
  const actions = ['pair', 'reconnect', 'allow_once', 'allow_site', 'allow_all', 'disconnect', 'disable_connector', 'revoke'];
  const buttons = actions.map(action => Object.assign(element(action), { dataset: { action } }));
  let state = initialState, reloads = 0, tick;
  const messages = [];
  const context = vm.createContext({
    CARDBUSH_CONNECTOR_BUILD: 'current-build',
    document: { querySelector: element, querySelectorAll: () => buttons },
    chrome: { runtime: {
      sendMessage: async message => { messages.push(message); return typeof state === 'function' ? state(message) : state; },
      reload() { reloads++; },
    } },
    Option: function(text, value) { Object.assign(this, { text, value }); },
    setInterval(fn) { tick = fn; },
  });
  vm.runInContext(popupSource, context);
  await flush();
  return { element, messages, context, get reloads() { return reloads; },
    setState(value) { state = value; },
    async refresh() { tick(); await flush(); },
    async reload() { await element('#reload-extension').listeners.click(); },
  };
}

const offline = { ok: true, connectorEnabled: true, nativeConnected: false, nativeConnecting: false, controlledTabCount: 0, hasPairing: true };

test('old cached workers prompt reload instead of re-pairing or claiming auto-reconnect and lost grants', async () => {
  // Old workers lack both build ID and the new saved-permission fields.
  const f = await popup({ ...offline, hasPairing: undefined, lastError: '旧版配对失败提示' });
  assert.equal(f.element('#extension-update').hidden, false);
  assert.match(f.element('#connection').textContent, /旧版本/);
  assert.doesNotMatch(f.element('#connection').textContent, /旧版配对失败|自动重连/);
  assert.doesNotMatch(f.element('#site-access').textContent, /尚未保存/);
  assert.equal(f.element('#pairing-details').open, false);
  assert.equal(f.element('pair').disabled, true);
  assert.equal(f.element('#reload-extension').disabled, false);
  await f.reload();
  assert.equal(f.reloads, 1);
  assert.equal(f.messages.every(message => message.action === 'status'), true, 'reload never re-pairs, disables or revokes');
});

test('matching builds retain normal reconnect and saved authorization display', async () => {
  const f = await popup({ ...offline, runtimeBuild: 'current-build', allowAllSites: true });
  assert.equal(f.element('#extension-update').hidden, true);
  assert.match(f.element('#connection').textContent, /自动重连/);
  assert.match(f.element('#site-access').textContent, /已保存：允许/);
  await f.reload();
  assert.equal(f.reloads, 0);
});

test('reload rechecks live connection state instead of interrupting a newly established connection', async () => {
  const f = await popup({ ...offline, runtimeBuild: 'old-build' });
  f.setState({ ...offline, nativeConnected: true });
  await f.reload();
  assert.equal(f.reloads, 0);
  assert.equal(f.element('#reload-extension').disabled, true);
  assert.match(f.element('#connection').textContent, /连接或控制仍在进行/);
  f.setState({ ...offline, controlledTabCount: 1 });
  await f.refresh();
  assert.equal(f.element('#reload-extension').disabled, true);
});

test('failed status checks never reload blindly', async () => {
  const f = await popup(offline);
  f.setState({ ok: false, error: { message: 'worker unavailable' } });
  await f.reload();
  assert.equal(f.reloads, 0);
  assert.match(f.element('#connection').textContent, /worker unavailable/);
});

test('background identity is a loaded-code snapshot, not a fresh manifest version', async () => {
  const background = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  assert.match(background, /importScripts\('build-info\.js'/);
  const html = fs.readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
  assert.ok(html.indexOf('src="build-info.js"') < html.indexOf('src="popup.js"'));
  buildBrowserExtension(extensionRoot, true);
});

test('content build IDs are deterministic across line endings and regenerate for source changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-extension-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 1;\n');
  buildBrowserExtension(directory);
  const first = extensionBuildSource(directory);
  buildBrowserExtension(directory, true);
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 1;\r\n');
  assert.equal(extensionBuildSource(directory), first);
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 2;\n');
  assert.throws(() => buildBrowserExtension(directory, true), /stale/);
  buildBrowserExtension(directory);
  assert.notEqual(extensionBuildSource(directory), first);
  buildBrowserExtension(directory, true);
});
