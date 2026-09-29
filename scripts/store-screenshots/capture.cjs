const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const directory = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
app.disableHardwareAcceleration();
app.setPath('userData', path.join(directory, 'isolated-profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  console.log('Store screenshot renderer ready');
  const report = { packageVersion: '1.0.5.0', resolution: '1920x1080', method: 'Unmodified product React views with synthetic, bilingual display data; no model or desktop tasks executed.', screenshots: [] };
  const captions = {
    'conversation': ['把会议记录整理成行动清单，在同一个工作空间里持续推进任务。', 'Turn meeting notes into a clear action list and keep work organized in one workspace.'],
    'app-center': ['从应用中心打开插件、自动化和设置，并整理个人网页快捷方式。', 'Open plugins, automations and settings from App Center, alongside your own web shortcuts.'],
    'browser-use': ['分别管理 Chrome 和 Edge 连接，选择默认浏览器，并随时撤销配对。', 'Manage Chrome and Edge connections, choose a default browser and revoke pairings at any time.'],
    'automations': ['在日历中查看定时安排与任务详情，管理每天的自动化工作。', 'View scheduled tasks and their details in a calendar, and manage daily automations.'],
  };
  for (const language of ['zh', 'en']) {
    const locale = language === 'zh' ? 'zh-CN' : 'en-US';
    await fs.mkdir(path.join(output, locale), { recursive: true });
    for (const [index, scene] of ['conversation', 'app-center', 'browser-use', 'automations'].entries()) {
      const win = new BrowserWindow({ show: false, width: 1600, height: 900, useContentSize: true, frame: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
          partition: `store-screenshot-${locale}-${scene}` } });
      win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) }));
      const read = async code => {
        try { return await win.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`${error.message}\nScreenshot script: ${code}`); }
      };
      const until = async (code) => {
        const end = Date.now() + 12000;
        while (!await read(code)) {
          if (Date.now() > end) throw Error(`Timed out: ${code}\n${await read('JSON.stringify(screenshotErrors)')}\n${await read('document.body.innerText')}`);
          await pause(50);
        }
      };
      try {
        console.log(`Rendering ${locale}/${scene}`);
        await win.loadFile(path.join(directory, 'index.html'), { query: { language, scene } });
        win.webContents.debugger.attach('1.3');
        // Render at the target pixel density; do not upscale an existing bitmap.
        // An offscreen virtual viewport avoids Windows work-area height clamping.
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 1600, height: 900, deviceScaleFactor: 1.2, mobile: false,
        });
        await until('document.querySelector(".app") !== null');
        if (scene === 'browser-use') {
          await until('document.querySelectorAll(".browser-connection-row").length === 2');
          await read('document.querySelector(".core-capability-settings").scrollIntoView({block:"start"});void 0');
        } else if (scene === 'automations') {
          await until('document.querySelectorAll(".automation-calendar-date").length > 0');
          await read(`document.querySelector(${JSON.stringify('[data-date="2026-09-29"]')}).click();void 0`);
          await until('document.querySelector(".automation-plan-toggle") !== null');
          await read('document.querySelector(".automation-plan-toggle").click();void 0');
        } else {
          await until('document.querySelectorAll(".markdown-body table").length > 0 || document.querySelectorAll("table").length > 0');
          if (scene === 'app-center') {
            await read('openScreenshotAppCenter();void 0');
            await until('document.querySelector(".app-center-drawer:modal") !== null');
          }
        }
        await read('document.fonts.ready');
        await pause(900);
        await read('document.activeElement?.blur();void 0');
        const errors = await read('screenshotErrors');
        assert.deepEqual(errors, [], `${locale}/${scene} must have no renderer errors`);
        const text = await read('document.body.innerText');
        assert.ok(!/fixture|CB2\.|sk-[A-Za-z0-9]|C:\\Users\\EDY/i.test(text), 'no credentials, test plumbing or personal paths');
        if (language === 'en') assert.ok(!/[\u3400-\u9fff]/.test(text), 'English screenshot must have no Chinese text');
        const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1600, height: 900, scale: 1 },
        });
        const buffer = Buffer.from(image.data, 'base64');
        assert.deepEqual({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }, { width: 1920, height: 1080 });
        const name = `${String(index + 1).padStart(2, '0')}-${scene}.png`;
        await fs.writeFile(path.join(output, locale, name), buffer);
        await fs.writeFile(path.join(directory, `${locale}-${scene}.txt`), text);
        report.screenshots.push({ file: `${locale}/${name}`, language: locale, caption: captions[scene][language === 'zh' ? 0 : 1], bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
        console.log(`Captured ${locale}/${name}: ${buffer.length} bytes`);
      } finally { win.destroy(); }
    }
  }
  assert.equal(report.screenshots.length, 8);
  await fs.writeFile(path.join(output, 'screenshots.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'captions.tsv'), 'language\tfile\tcaption\n' + report.screenshots.map(item => `${item.language}\t${item.file}\t${item.caption}`).join('\n') + '\n');
  console.log(JSON.stringify({ output, screenshots: 8, rendererErrors: 0, network: 'blocked', profile: 'isolated' }));
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
