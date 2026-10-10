const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Agent registration UI timed out'); app.exit(1); }, 35000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1160, height: 950, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const read = script => win.webContents.executeJavaScript(script);
  const frame = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const until = async script => {
    const end = Date.now() + 5000;
    while (!(await read(script))) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '; ' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const click = async selector => { await read(`document.querySelector(${JSON.stringify(selector)}).click()`); await frame(); };
  const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until('document.querySelectorAll(".loop-registration-preview").length===4');
    assert.deepEqual(await read('[...document.querySelectorAll(".loop-registration-preview strong")].map(node=>node.textContent)'), ['策划','关键词分析师','编辑','品牌宣传团队']);
    assert.equal(await read('document.querySelectorAll(".loop-subagent-preview, .work-summary-subagents").length'), 0);
    assert.equal(await read('document.querySelectorAll(".loop-employee-registration-previews .lucide-contact-round").length'), 4);
    assert.equal(await read('document.querySelectorAll(".loop-registration-preview:disabled").length'), 0);
    assert.deepEqual(await read('[reads.length,taskReads,detailReads]'), [0,0,0], 'history summary is sufficient; no configuration or task scans');
    await click('.loop-employee-registration-previews .loop-registration-preview');
    await until('document.querySelector(".agent-definition-inspector dd")?.textContent === "employee-0"');
    assert.equal(await read('openedTab.kind'), 'agent-definition');
    assert.deepEqual(await read('reads[0]'), {kind:'runtime.agent_registry',payload:{action:'get',agent_id:'employee-0'}});
    assert.equal(await read('document.querySelector(".agent-definition-inspector details").open'), false);
    await click('.agent-definition-inspector details summary');
    assert.match(await read('document.querySelector(".agent-definition-inspector").innerText'), /PRIVATE_ROLE_PROMPT/);
    await click('.work-summary-team-registrations button');
    await until('document.querySelectorAll(".agent-definition-nodes .md-article-section").length===3');
    assert.equal(await read('opened.entity'), 'team');
    assert.equal(await read('document.querySelector(".md-presentation-body").dataset.mode'),'document');
    assert.deepEqual(await read('[...document.querySelectorAll("[data-document-section=step-2] .md-section-execution button")].map(button=>button.textContent)'),['step-0','step-1']);
    assert.equal(await read('document.querySelectorAll(".md-section-heading button,.md-section-actions button,.md-node-editor").length'),0,'Team details present a read-only article');
    for (const theme of ['dark', 'light']) {
      await read(`document.querySelector('.fixture-app').className='app theme-${theme} fixture-app'`); await frame();
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
      writeFileSync(resolve(`tmp/agent-registration-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setSize(540,1000); await frame();
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true,'Team article fits a narrow inspector');
    assert.equal(await read('getComputedStyle(document.querySelector(".md-node-list")).display'),'none');
    await click('.agent-definition-nodes > details summary');
    await click('.agent-definition-nodes > details button');
    await until('document.querySelector(".agent-definition-inspector dd")?.textContent === "employee-0"');
    assert.equal(await read('disposals'), 0, 'definition inspectors borrow the current host runtime');
    await read('setMode("mixed")');
    await until('document.querySelectorAll(".loop-employee-previews .loop-subagent-preview:not(:disabled)").length===1');
    await until('document.querySelectorAll(".work-summary-employee-runs button").length===1');
    assert.equal(await read('document.querySelectorAll(".work-summary-subagents .work-summary-subagent-task").length'), 1);
    await click('.loop-employee-previews .loop-subagent-preview');
    assert.equal(await read('opened.kind'), 'subagent-task');
    assert.equal(await read('opened.task.agentName'), '策划');
    await read('setMode("failed")'); await frame();
    assert.equal(await read('document.querySelectorAll(".loop-registration-preview:disabled").length'), 1);
    assert.equal(await read('currentRegistrations.length'), 4, 'failed registration never joins the registered inventory');
    await read('window.missing=true'); await click('.work-summary-employee-registrations button');
    await until('document.querySelector(".agent-definition-inspector [role=alert]")');
    assert.equal(await read('document.querySelectorAll(".agent-definition-inspector dd").length'), 0);
    await read('window.missing=false'); await click('.agent-definition-inspector header button');
    await until('document.querySelector(".agent-definition-inspector dd")?.textContent === "employee-0"');
    await read('setMode("live")'); await frame();
    assert.equal(await read('document.querySelectorAll(".loop-registration-preview").length'), 4, 'live and reloaded cards agree');
    win.setSize(540, 1000); await frame();
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, 'narrow details and cards do not overflow');
    writeFileSync(resolve('tmp/agent-registration-narrow.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('Agent registration UI passed: history/live identity, separate summary groups, employee icons, clickable host-scoped definition/team/member details, actual runs, failed/deleted definitions, themes and narrow layout.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error, errors); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
