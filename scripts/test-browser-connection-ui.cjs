const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..'), parent = path.join(root, 'tmp');
fs.mkdirSync(parent, { recursive: true });
const fixture = fs.mkdtempSync(path.join(parent, 'browser-connection-ui-'));
app.setPath('userData', path.join(fixture, 'profile'));
const preload = path.join(fixture, 'preload.cjs');
// Only this isolated renderer has a fake extension API. No real browser,
// connector, consent window or saved user pairing is opened by this test.
fs.writeFileSync(preload, `
window.fixtureMessages=[];window.fixtureClosed=false;window.fixtureExpired=false;
window.close=()=>{window.fixtureClosed=true};
window.chrome={runtime:{sendMessage:async message=>{
  window.fixtureMessages.push(message);
  if(message.action==='connection_state')return {ok:!location.search.includes('invalid'),browser:location.search.includes('edge')?'edge':'chrome',expiresAt:Date.now()+60000};
  return {ok:!window.fixtureExpired};
}}};
`);
let window;
const run = source => window.webContents.executeJavaScript(source, true);
async function until(source) {
  const deadline = Date.now() + 4000;
  while (!await run(source)) { assert.ok(Date.now() < deadline, source); await new Promise(resolve => setTimeout(resolve, 15)); }
}
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 480, height: 470, useContentSize: true,
    webPreferences: { preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const load = query => window.loadFile(path.join(root, 'assets/plugins/browser/extension/connection.html'), { query, hash: 'fixture-request' });
  await load({ browser: 'chrome' });
  await until('!document.querySelector("#allow").disabled');
  assert.equal(await run('document.querySelector("#browser-name").textContent.trim()'), 'Google Chrome');
  assert.equal(await run('document.activeElement.id'), 'cancel', 'Enter must not approve by default');
  assert.equal(await run('fixtureMessages.filter(m=>m.action==="confirm_connection").length'), 0, 'opening is never approval');
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight'), true, 'dialog content fits');
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.writeFileSync(path.join(parent, 'browser-connection-ui.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.querySelector("#allow").click();document.querySelector("#allow").click()');
  await until('fixtureClosed');
  assert.deepEqual(await run('fixtureMessages.filter(m=>m.action==="confirm_connection").map(m=>m.allow)'), [true]);

  await load({ browser: 'edge' }); await until('!document.querySelector("#allow").disabled');
  assert.equal(await run('document.querySelector("#browser-name").textContent.trim()'), 'Microsoft Edge');
  window.setContentSize(340, 470);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight'), true, 'compact dialog fits');
  fs.writeFileSync(path.join(parent, 'browser-connection-ui-compact.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))'); await until('fixtureClosed');
  assert.deepEqual(await run('fixtureMessages.filter(m=>m.action==="confirm_connection").map(m=>m.allow)'), [false]);

  await load({ invalid: 'true' }); await until('document.querySelector("#status").textContent.includes("已结束")');
  await run('document.querySelector("#allow").click()');
  assert.equal(await run('fixtureMessages.filter(m=>m.action==="confirm_connection").length'), 0);
  assert.equal(await run('document.querySelector("#allow").disabled'), true);
  await run('document.querySelector("#cancel").click()'); await until('fixtureClosed');

  await load({ browser: 'chrome' }); await until('!document.querySelector("#allow").disabled');
  await run('fixtureExpired=true;document.querySelector("#allow").click()');
  await until('document.querySelector("#status").textContent.includes("已结束")');
  assert.equal(await run('document.querySelector("#allow").disabled'), true);
  assert.equal(await run('document.querySelector("#cancel").disabled'), false);
  assert.deepEqual(errors, []);
  console.log('Browser confirmation UI passed: Chrome/Edge, single explicit confirmation, default Cancel, Escape, invalid/expired requests and compact layout.');
  console.log('Preview: tmp/browser-connection-ui.png');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
