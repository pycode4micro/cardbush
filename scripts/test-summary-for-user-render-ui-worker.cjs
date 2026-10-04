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
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Final-response UI: collapse during streaming, expandable history, stable completion and resumed tools passed.');
  } finally { window.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
