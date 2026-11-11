import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildBrowserExtension, extensionBuildSource, extensionRoot } from '../../../scripts/build-browser-extension.mjs';

const popupSource = fs.readFileSync(path.join(extensionRoot, 'i18n.js'), 'utf8') + '\n' + fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function popup(initialState, build = 'current-build') {
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
  const actions = ['pair', 'reconnect', 'request_local_connection', 'copy_tab', 'disconnect', 'disable_connector'];
  const buttons = actions.map(action => Object.assign(element(action), { dataset: { action } }));
  let state = initialState, reloads = 0, tick;
  const messages = [];
  const context = vm.createContext({
    CARDBUSH_CONNECTOR_BUILD: build,
    document: { documentElement: { lang: 'zh-CN' }, querySelector: element, querySelectorAll: () => buttons },
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
  assert.match(f.element('#connection').textContent, /恢复已保存的连接/);
  assert.equal(f.element('reconnect').textContent, '重试已保存的连接');
  assert.equal(f.element('#pairing-details').open, false);
  assert.match(f.element('#site-access').textContent, /连接已授权全部网站/);
  await f.reload();
  assert.equal(f.reloads, 0);
  assert.match(f.element('#connection-help').textContent, /已保存的连接.*每 30 秒自动重连/);
  assert.match(f.element('#connection-help').textContent, /首次注册连续失败 3 轮后停止/);
  f.context.document.documentElement.lang = 'en-US'; await f.refresh();
  assert.match(f.element('#connection-help').textContent, /saved connections retry every 30 seconds without another approval/);
  f.context.document.documentElement.lang = 'xx'; await f.refresh();
  assert.match(f.element('#connection-help').textContent, /saved connections retry every 30 seconds/);
});

test('the two published 1.5.2 popup designs recognize the same worker and retain tab copying', async () => {
  const workerBuild = '307e351a1cab7a55ff6498be5eb6c5614ac9ffa5983347ce6baa6a9411be18a8';
  for (const runtimeBuild of [
    'f42287e7b305968d75b24dd074669afc7f93d3f8d29092016ed8a9fdfcba3892',
    'a9c3fcd125d6a678a92a101012db86fe52b84e28974a7c735c5fcdfc6c906b64',
  ]) {
    const state = { ...offline, runtimeBuild, nativeConnected: true, controlledTabCount: 1,
      activeScope: { id: 'current' }, origin: 'https://example.org' };
    const f = await popup(state, workerBuild);
    assert.match(f.element('#connection').textContent, /正在控制 1 个标签页/);
    assert.equal(f.element('#extension-update').hidden, true);
    assert.equal(f.element('copy_tab').disabled, false);
    await f.reload();
    assert.equal(f.reloads, 0);
    const newer = await popup(state, 'changed-worker');
    assert.equal(newer.element('#extension-update').hidden, false);
    assert.equal(newer.element('copy_tab').disabled, true);
    assert.match(newer.element('#connection').textContent, /正在控制 1 个标签页/);
  }
});

test('reload rechecks live connection state instead of interrupting a newly established connection', async () => {
  const f = await popup({ ...offline, runtimeBuild: 'old-build' });
  f.setState({ ...offline, nativeConnected: true });
  await f.reload();
  assert.equal(f.reloads, 0);
  assert.equal(f.element('#reload-extension').disabled, true);
  assert.match(f.element('#connection').textContent, /已连接 CardBush/);
  assert.equal(f.element('#extension-update').hidden, false);
  assert.match(f.element('#extension-update-message').textContent, /更新/);
  f.setState({ ...offline, controlledTabCount: 1 });
  await f.refresh();
  assert.equal(f.element('#reload-extension').disabled, true);
});

test('offline recovery describes the saved connection and leaves re-pairing in collapsed advanced settings', async () => {
  const f = await popup({ ...offline, runtimeBuild:'current-build', reconnectWaiting:true, nextRetryAt:Date.now()+30000 });
  assert.match(f.element('#connection').textContent, /无需再次授权/);
  assert.equal(f.element('#pairing-details').open, false);
  assert.equal(f.element('request_local_connection').textContent, '重新配对本机连接');
  assert.match(f.element('#local-connection-repair-help').textContent, /普通退出、重启/);
  for (const [phase, text] of [['opening','已保存'],['handshake','校验'],['authentication','身份已验证']]) {
    f.setState({ ...offline, runtimeBuild:'current-build', nativeConnecting:true, connectionDiagnostic:{phase} });
    await f.refresh();
    assert.match(f.element('#connection').textContent, new RegExp(text));
    assert.equal(f.element('reconnect').disabled, true);
    assert.equal(f.element('request_local_connection').disabled, true);
  }
  f.context.document.documentElement.lang='en-US';
  await f.refresh();
  assert.match(f.element('#connection').textContent, /identity verified/);
  assert.match(f.element('reconnect').textContent, /Retry saved connection/);
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
  fs.cpSync(extensionRoot, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 1;\n');
  buildBrowserExtension(directory);
  const first = extensionBuildSource(directory);
  buildBrowserExtension(directory, true);
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 1;\r\n');
  assert.equal(extensionBuildSource(directory), first);
  for (const name of ['popup.css', 'popup.html', 'popup.js', 'connection.js', 'i18n.js']) {
    fs.appendFileSync(path.join(directory, name), '\n/* updated view */\n');
    assert.equal(extensionBuildSource(directory), first, name);
  }
  const worker = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8');
  const imports = [...worker.matchAll(/importScripts\(([^)]*)\)/g)].flatMap(match =>
    [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(file => file[1]));
  for (const name of ['manifest.json', ...imports.filter(name => !['build-info.js', 'i18n.js'].includes(name))]) {
    const file = path.join(directory, name), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n ');
    assert.notEqual(extensionBuildSource(directory), first, name);
    fs.writeFileSync(file, original);
  }
  buildBrowserExtension(directory);
  fs.writeFileSync(path.join(directory, 'background.js'), 'const a = 2;\n');
  assert.throws(() => buildBrowserExtension(directory, true), /stale/);
  buildBrowserExtension(directory);
  assert.notEqual(extensionBuildSource(directory), first);
  buildBrowserExtension(directory, true);
});
