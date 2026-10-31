const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code, true); }
    catch (error) { throw Error(code + '\n' + errors.join('\n'), { cause: error }); }
  };
  async function waitFor(code) {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(30); }
    throw Error('Timed out: ' + code + '\n' + errors.join('\n'));
  }
  try {
    await window.loadFile(path.join(process.argv[2], 'index.html'));
    await waitFor('Boolean(window.show)');
    await run('show("process", "正在读取")');
    await waitFor('Boolean(document.querySelector(".assistant-active-transcript"))');
    assert.equal(await run('Boolean(document.querySelector(".assistant-final-answer"))'), false);

    await run('show("final")');
    await waitFor('document.querySelector(".assistant-final-answer")?.textContent.includes("最终答复第一段")');
    assert.equal(await run('document.querySelector(".assistant-completed-summary").getAttribute("aria-expanded")'), 'false');
    assert.equal(await run('Boolean(document.querySelector(".assistant-active-transcript,.assistant-completed-content,.message-actions"))'), false);
    assert.equal(await run('projected.at(-1).status'), 'streaming', 'final intent does not complete the task');
    assert.match(await run('document.querySelector(".assistant-completed-summary").textContent'), /处理中/);
    await run('window.disclosure = document.querySelector(".assistant-completed-disclosure"); show("final", "最终答复第一段，继续输出第二段")');
    await waitFor('document.querySelector(".assistant-final-answer").textContent.includes("第二段")');
    assert.equal(await run('disclosure === document.querySelector(".assistant-completed-disclosure")'), true);
    await run('document.querySelector(".assistant-completed-summary").click()');
    await waitFor('Boolean(document.querySelector(".assistant-completed-content"))');
    assert.match(await run('document.querySelector(".assistant-completed-content").textContent'), /检查习惯记录/);
    assert.doesNotMatch(await run('document.querySelector(".assistant-completed-content").textContent'), /最终答复第一段/);
    await run('document.querySelector(".assistant-completed-summary").click(); show("done", "完整最终答复")');
    await waitFor('Boolean(document.querySelector(".message-actions"))');
    assert.equal(await run('disclosure === document.querySelector(".assistant-completed-disclosure")'), true);
    assert.equal(await run('document.querySelector(".assistant-completed-summary").getAttribute("aria-expanded")'), 'false');

    await run('show("corrected", "需要补查")');
    await waitFor('Boolean(document.querySelector(".assistant-active-transcript"))');
    assert.equal(await run('Boolean(document.querySelector(".assistant-final-answer,.message-actions"))'), false);
    assert.match(await run('document.querySelector(".assistant-active-transcript").textContent'), /检查习惯记录/);

    // Voice playback streams independently of the Runtime turn. These are
    // ordinary replies even while another Agent is working in this session.
    for (const language of ['zh','en']) for (const mainTurnActive of [false,true]) {
      const options=JSON.stringify({language,mainTurnActive});
      await run(`showJournal('streaming','如果是日常交流',${options})`);
      await waitFor('document.querySelector(".assistant-final-answer")?.textContent==="如果是日常交流"');
      assert.equal(await run('Boolean(document.querySelector(".assistant-completed-disclosure,.assistant-run-header,.assistant-active-transcript,.message-actions"))'),false,
        'spoken text must be visible without processed disclosure, execution status or premature final actions');
      assert.equal(await run('projected.at(-1).status'),'streaming','display intent must not mark playback completed');
      await run(`window.spokenBody=document.querySelector('.assistant-final-answer');showJournal('streaming','如果是日常交流，这些方法基本够用。',${options})`);
      await waitFor('document.querySelector(".assistant-final-answer")?.textContent.includes("基本够用")');
      assert.equal(await run('spokenBody===document.querySelector(".assistant-final-answer")'),true,'each playback update retains the visible reply node');
      await run(`showJournal('completed','如果是日常交流，这些方法基本够用。',${options})`);
      await waitFor('Boolean(document.querySelector(".message-actions"))');
      assert.equal(await run('spokenBody===document.querySelector(".assistant-final-answer")'),true,'completion does not move the reply into another container');
      assert.equal(await run('Boolean(document.querySelector(".assistant-completed-disclosure,.assistant-run-header"))'),false);
      await run(`showJournal('interrupted','如果是日常交流',${options})`);
      await waitFor('document.querySelector(".assistant-bubble")?.textContent.includes("如果是日常交流")');
      assert.equal(await run('Boolean(document.querySelector(".assistant-completed-disclosure"))'),false,'interrupted speech remains readable outside the process history');
      await run(`showJournal('completed','如果是日常交流，这些方法基本够用。',${options})`);
      await waitFor('document.querySelector(".assistant-final-answer")?.textContent.includes("基本够用")');
    }
    await run('showJournal("completed","保留为内部通话",{internal:true})');
    await waitFor('!document.querySelector(".message-row")');
    await run('showJournal("completed","Published assistant page",{source:"page",language:"en"})');
    await waitFor('document.querySelector(".assistant-final-answer")?.textContent==="Published assistant page"');
    assert.equal(await run('Boolean(document.querySelector(".assistant-run-header,.assistant-completed-disclosure"))'),false);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Final-response UI: tool process disclosure, visible playback-paced journal replies, stable streaming/completion, interruption, background Runtime work, reload and internal visibility passed.');
  } finally { window.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
