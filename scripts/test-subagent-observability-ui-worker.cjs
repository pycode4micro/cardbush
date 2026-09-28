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
  const labelsMatch = label => `document.querySelector('.work-summary-subagent-status')?.textContent === ${JSON.stringify(label)}`;
  try {
    await window.loadFile(join(directory, 'index.html'));
    await until(labelsMatch('已完成'));
    assert.equal(await read(`document.querySelector('.work-summary-subagent-status').getBoundingClientRect().width > 0`), true);
    await read(`document.querySelector('.work-summary-subagent-task').click()`);
    assert.equal(await read('window.openedChild.task.childSessionId'), 'child');
    assert.equal(await read('window.openedChild.sessionId'), 'parent');
    assert.match(await read('window.openedChild.task.responsePrompt'), /接收端文件已生成，联调仍需父任务继续/);
    assert.equal(await read('document.querySelectorAll(".work-summary-subagent-task .spin").length'), 0);
    assert.doesNotMatch(await read('document.body.innerText'), /待父级审查|父级已接受|审查状态|契约状态/);
    writeFileSync(resolve('tmp/subagent-completed.png'), (await window.webContents.capturePage()).toPNG());
    for (const language of ['zh', 'en']) {
      for (const [status, tone, zh, en] of states) {
        const label = language === 'zh' ? zh : en;
        await read(`window.renderScenario(${JSON.stringify(status)},${JSON.stringify(language)}); void 0`);
        await until(labelsMatch(label));
        assert.equal(await read(`document.querySelector('.work-summary-subagent-state').classList.contains('${tone}')`), true);
        assert.equal(await read(`!!document.querySelector('.work-summary-subagent-task .spin')`), status === 'running',
          'a completed parent Turn must not complete a genuinely running child');
        assert.doesNotMatch(await read('document.body.innerText'), /待父级审查|父级已接受|Awaiting parent review|Accepted by parent/);
        await read(`document.querySelector('.work-summary-subagent-task').click()`);
        assert.equal(await read('window.openedChild.task.status'), status);
        if (status === 'failed') assert.equal(await read('window.openedChild.task.errorMessage'), '连接失败');
      }
    }
    await read(`window.renderScenario('running'); void 0`);
    await until(labelsMatch('运行中'));
    const turnReads = await read('window.turnReads');
    await read("window.dispatchEvent(new Event('focus'))");
    assert.equal(await read('window.turnReads'), turnReads, 'active status comes from the task, not a nonexistent committed Turn');
    await read('window.finishTask(); void 0');
    await until(labelsMatch('已完成'));
    await read(`document.querySelector('.work-summary-subagent-task').click()`);
    assert.match(await read('window.openedChild.task.responsePrompt'), /实时任务已完成/);
    await read(`window.followupTask={...window.runtimeTask,taskId:'human-followup',childTurnId:'human-turn',prompt:'用户补充',status:'running',revision:1,createdAt:'2026-09-11T14:36:00Z',updatedAt:'2026-09-11T14:36:00Z'};window.dispatchEvent(new Event('focus'));`);
    await until(labelsMatch('运行中'));
    assert.equal(await read("document.querySelectorAll('.work-summary-subagent-task').length"),1,'human continuation remains one child conversation');
    await read(`document.querySelector('.work-summary-subagent-task').click()`);
    assert.equal(await read('window.openedChild.task.requestPrompt'),'实现接收端网页','keep original assignment as conversation identity');
    assert.equal(await read('window.sessionScans'), 0, 'polling must remain scoped to this task');
    await read('window.unmountFixture(); void 0');
    assert.deepEqual(errors, []);
    console.log('Subagent summary UI passed: live Runtime facts, later parent Turns, four states, child-conversation routing and both languages.');
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
