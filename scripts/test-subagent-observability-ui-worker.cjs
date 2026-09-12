const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Subagent UI test timed out'); app.exit(1); }, 25_000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1120, height: 840,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message);
  });
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/.test(details.url);
    if (external) errors.push('Unexpected network access: ' + details.url);
    done({cancel:external});
  });
  const read = script => window.webContents.executeJavaScript(script);
  const until = async script => {
    const end = Date.now() + 6500;
    while (!(await read(script))) {
      if (Date.now() > end) throw new Error(`Timed out: ${script}; ${await read('document.body.innerText')}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const states = [
    ['completed', 'complete', '已完成', 'Completed'],
    ['running', 'running', '运行中', 'Running'],
    ['failed', 'failed', '执行失败', 'Failed'],
    ['stopped', 'stopped', '已停止', 'Stopped'],
  ];
  const labelsMatch = label => `document.querySelector('.work-summary-subagent-status')?.textContent === ${JSON.stringify(label)} && document.querySelector('.subagent-task-inspector header small')?.textContent === ${JSON.stringify(label)}`;
  try {
    await window.loadFile(join(directory, 'index.html'));
    await until(labelsMatch('已完成'));
    assert.equal(await read(`document.querySelector('.work-summary-subagent-status').getBoundingClientRect().width > 0`), true);
    assert.match(await read('document.body.innerText'), /接收端文件已生成，联调仍需父任务继续/,
      'completed execution must preserve the actual result, even when it reports remaining parent work');
    assert.equal(await read('document.querySelectorAll(".work-summary-subagent-task .spin").length'), 0);
    assert.doesNotMatch(await read('document.body.innerText'), /待父级审查|父级已接受|审查状态|契约状态/);
    writeFileSync(resolve('tmp/subagent-completed.png'), (await window.webContents.capturePage()).toPNG());
    for (const language of ['zh', 'en']) {
      for (const [status, tone, zh, en] of states) {
        const label = language === 'zh' ? zh : en;
        await read(`window.renderScenario(${JSON.stringify(status)},${JSON.stringify(language)}); void 0`);
        await until(labelsMatch(label));
        assert.equal(await read(`document.querySelector('.work-summary-subagent-state').classList.contains('${tone}')`), true);
        assert.equal(await read(`document.querySelector('.subagent-inspector-state').classList.contains('${tone}')`), true);
        assert.equal(await read(`!!document.querySelector('.work-summary-subagent-task .spin')`), status === 'running',
          'a completed parent Turn must not complete a genuinely running child');
        assert.doesNotMatch(await read('document.body.innerText'), /待父级审查|父级已接受|Awaiting parent review|Accepted by parent/);
        if (status === 'failed') assert.match(await read('document.body.innerText'), /连接失败/);
      }
    }
    await read(`window.renderScenario('running'); void 0`);
    await until(labelsMatch('运行中'));
    await read('window.finishTask(); void 0');
    await until(labelsMatch('已完成'));
    assert.match(await read('document.body.innerText'), /实时任务已完成/,
      'normal active-task refresh must settle both mounted views without reopening');
    await read('window.unmountFixture(); void 0');
    assert.deepEqual(errors, []);
    console.log('Subagent observability UI passed: persisted and live Runtime facts, later parent Turns, four states, both views and languages.');
    clearTimeout(deadline);
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    clearTimeout(deadline);
    app.exit(1);
  }
});
