const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Run status UI timed out'); app.exit(1); }, 20_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 780, height: 330,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error('Renderer:', event.message);
  });
  const read = script => window.webContents.executeJavaScript(script);
  const until = async script => {
    const end = Date.now() + 6000;
    while (!(await read(script))) {
      if (Date.now() > end) throw new Error(`Condition timed out: ${script}; body=${await read('document.body.innerText')}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  try {
    await window.loadFile(join(directory, 'index.html'));
    await until('document.body.innerText.includes("待确认 1 项")');
    assert.equal(await read('window.checks'), 0, 'active Turn must not poll MCP activation');
    const text = await read('document.body.innerText');
    assert.match(text, /工具执行中 1 项/);
    assert.match(text, /1 个最近报告仍在运行/);
    assert.match(text, /正在后台连接或等待工具生效/);
    assert.ok(await read('document.documentElement.scrollWidth <= window.innerWidth'), 'status text must wrap inside a narrow conversation');
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(resolve('tmp/run-status-active.png'), (await window.webContents.capturePage()).toPNG());
    await read('window.renderFixture(false)');
    await until('document.body.innerText.includes("已连接，工具列表已获取")');
    assert.equal(await read('window.checks'), 2, 'bounded observation follows pending to connection after Turn end');
    assert.equal(await read('document.querySelector(".assistant-run-activity")'), null);
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(resolve('tmp/run-status-connected.png'), (await window.webContents.capturePage()).toPNG());
    // A queued retry must be cancelled on unmount.
    await read('window.renderFixture(true)');
    await until('document.body.innerText.includes("正在后台连接或等待工具生效")');
    await read('window.fixtureSnapshot = () => ({protocol:"bush.mcp_snapshot_result.v1",snapshotId:"fixture",revision:1,pendingRevision:2,applicationState:"pending",servers:[]}); window.renderFixture(false)');
    await until('window.checks === 3');
    await read('window.unmountFixture()');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await read('window.checks'), 3, 'unmount cancels queued observation');
    assert.ok(await read('window.aborts > 0'));
    console.log('Run status UI passed: concurrent states, idle-only MCP verification and cleanup.');
    clearTimeout(deadline); window.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); window.destroy(); app.exit(1); }
});
