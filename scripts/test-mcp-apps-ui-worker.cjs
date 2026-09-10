const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]); app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('MCP Apps UI timed out'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 880, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  require('../dist-electron/sandboxFrameGuard.js').installSandboxFrameNavigationGuard(win.webContents);
  const read = script => win.webContents.executeJavaScript(script);
  const until = async script => { const end = Date.now() + 5000; while (!await read(script)) { if (Date.now() > end) throw Error(`Timed out: ${script}; ` + await read('JSON.stringify(fixtureReports) + document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 25)); } };
  const click = label => read(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const send = action => read(`document.querySelector('iframe').contentWindow.postMessage({fixture:${JSON.stringify(action)}},'*')`);
  try {
    await win.loadFile(join(directory, 'index.html')); await click('打开插件界面');
    await until('fixtureReports.result && fixtureReports.isolated && fixtureReports.networkBlocked');
    assert.equal(await read('document.querySelector("iframe").getAttribute("sandbox")'), 'allow-scripts');
    assert.equal(await read('fixtureReports.result._meta.uiOnly'), true);
    assert.equal(await read('document.querySelector("iframe").srcdoc.includes("opaque-host-token")'), false);
    await read(`window.postMessage({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'save',arguments:{}}},'*')`);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await read('operations.filter(x=>x.action==="call").length'), 0, 'foreign window cannot invoke bridge');
    await send('call'); await until('document.body.innerText.includes("允许本次")'); assert.equal(await read('saved'), 0);
    await click('拒绝'); await until('fixtureReports.denied'); assert.equal(await read('saved'), 0);
    await send('navigate'); await new Promise(resolve => setTimeout(resolve, 100));
    await send('legacy'); await until('document.body.innerText.includes("允许本次")'); await click('允许本次');
    await until('fixtureReports.legacy && context'); assert.equal(await read('saved'), 1); assert.equal(await read('context.structuredContent.widgetState.page'), 2);
    await send('message'); await until('document.body.innerText.includes("发送到会话")'); await click('发送到会话'); await until('fixtureReports.message'); assert.equal(await read('followup'), 'Continue fixture');
    await win.setContentSize(540, 640); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await read('document.documentElement.scrollWidth <= innerWidth'), true);
    writeFileSync(resolve('tmp/mcp-app-interface.png'), (await win.webContents.capturePage()).toPNG());
    await send('blank'); await until('!document.querySelector("iframe")'); assert.equal(await read('operations.at(-1).action'), 'close', 'document replacement revokes the original interface');
    console.log('MCP Apps UI passed: sandbox/origin/CSP, protocol handshake, private metadata, permission denial/approval, OpenAI aliases, follow-up, context, narrow layout and disposal.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
