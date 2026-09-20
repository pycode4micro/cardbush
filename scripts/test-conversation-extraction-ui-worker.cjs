const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const directory = path.resolve(process.argv[2]); app.setPath('userData', path.join(directory, 'profile'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const { SessionStore } = await import(pathToFileURL(path.resolve('packages/bush-runtime/dist/sessionStore.js')).href);
  const { extractSessionSource } = await import(pathToFileURL(path.resolve('packages/bush-runtime/dist/sessionExtraction.js')).href);
  const { ConversationExtractStore } = await import(pathToFileURL(path.resolve('dist-electron/conversationExtracts.mjs')).href);
  const sessions = new SessionStore(), now = new Date().toISOString(); sessions.ensureSession('source', { title: '构建和验证记录' });
  for (let i = 1; i <= 7; i++) sessions.commitTurn('source', { turnId: `t${i}`, turnSequence: i, createdAt: now, completedAt: now, status: 'completed', reason: 'stop', usage: {},
    messages: [{ role: 'user', content: `请求 ${i}：检查构建并保留操作结论。` }, { role: 'assistant', content: `回复 ${i}：构建已完成，可以在其他会话继续。`, toolCalls: [] }]
      .map((message, index) => ({ messageId: `t${i}-${index}`, turnId: `t${i}`, turnSequence: i, messageIndex: index, createdAt: now, message })) });
  sessions.summarizeTurns({ sessionId: 'source', expectedRevision: sessions.snapshot('source').revision, summaries: [{ turnId: 't7', summary: '第七轮后台总结：文件已修改，构建和测试通过。仍需用户复核部署。' }] });
  sessions.ensureSession('other'); sessions.fork('source', 'other');
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  let clock = Date.now(), forks = 0;
  const errors = [], dialogs = [];
  const extracts = new ConversationExtractStore(path.join(directory, 'extracts'), async (id, keys) => extractSessionSource(sessions.snapshot(id), keys),
    { now: () => clock, notify: () => { if (!window.isDestroyed()) window.webContents.send('changed'); } });
  ipcMain.handle('extract', async (_, input) => {
    if (input.action === 'error') { dialogs.push(input.message); return; }
    if (input.action === 'expire') { clock += 30001; extracts.expire(); window.webContents.send('changed'); return; }
    if (input.action === 'fork') { const id = `fork-${++forks}`; sessions.ensureSession(id, { title: 'Fork 会话' }); sessions.fork(input.sessionId, id); return { id, title: 'Fork 会话', preview: '', updatedAt: now }; }
    if (input.action === 'preview') return extracts.preview(input.selection);
    if (input.action === 'list') return extracts.list();
    if (input.action === 'save') return extracts.save(input.selection, input.kind);
    if (input.action === 'consume') return extracts.consume(input.id);
    if (input.action === 'resolve') return extracts.resolve(input.id, input.contextWindowTokens);
    if (input.action === 'export') return extracts.export(input.selection, async () => path.join(directory, 'export.md'));
  });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = code => window.webContents.executeJavaScript(code, true).catch(error => { throw new Error(`${error.message}\nScript: ${code}\n${errors.join('\n')}`); });
  const waitFor = async (code, label) => { for (let i = 0; i < 100; i++) { if (await run(`Boolean(${code})`)) return; await pause(40); } throw Error('Timed out: ' + label + '\n' + errors.join('\n') + '\n' + await run('document.body.innerText')); };
  const click = text => run(`Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === ${JSON.stringify(text)} || (item.classList.contains('sidebar-menu-button') && item.querySelector('span')?.textContent.trim() === ${JSON.stringify(text)})).click()`);
  const change = (selector, value) => run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', {bubbles:true})); node.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const contextMenu = () => run(`document.querySelector('.conversation-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:170}))`);
  try {
    await window.loadFile(path.join(directory, 'index.html'));
    await waitFor('document.querySelectorAll(".conversation-row").length === 2 && window.extractContext', 'sidebar');
    await contextMenu(); await click('提取对话');
    await waitFor('document.querySelector(".extract-budget")?.textContent.includes("已选 10 条")', 'default five turns');
    assert.equal(await run(`Array.from(document.querySelectorAll('.extract-dialog button')).find(item=>item.textContent === '永久保存').disabled`), true);
    await change('.extract-dialog input', '构建与验证'); await change('.extract-dialog textarea', '供其他 Agent 继续工作的背景');
    await waitFor(`!Array.from(document.querySelectorAll('.extract-dialog button')).find(item=>item.textContent === '永久保存').disabled`, 'permanent enabled');
    await pause(150);
    fs.writeFileSync(path.resolve('tmp/conversation-extraction-dialog.png'), (await window.webContents.capturePage()).toPNG());
    await change('.extract-dialog select', 'select');
    await waitFor('document.querySelectorAll(".extract-circle").length === 14 && !document.querySelector(".extract-dialog")', 'selection mode');
    assert.equal(await run('document.querySelectorAll(".extract-circle[aria-checked=true]").length'), 10);
    assert.equal(await run('document.querySelector(".extract-summary-note").textContent'), '使用后台总结');
    await pause(100);
    fs.writeFileSync(path.resolve('tmp/conversation-extraction-selection.png'), (await window.webContents.capturePage()).toPNG());
    await run('document.querySelector("[data-message-id=t3-0] .extract-circle").click()');
    assert.equal(await run('document.querySelectorAll(".extract-circle[aria-checked=true]").length'), 9);
    await click('完成选择'); await click('永久保存');
    await waitFor('!document.querySelector(".extract-dialog") && window.extractContext.permanent.length === 1', 'saved reference');
    await change('[data-composer-input]', '@构建');
    await waitFor('document.querySelector(".composer-command-menu") || document.body.textContent.includes("供其他 Agent 继续工作的背景")', '@ picker');
    const refButton = await run(`Array.from(document.querySelectorAll('button')).find(item=>item.textContent.includes('供其他 Agent 继续工作的背景'))?.textContent`);
    assert.ok(refButton);
    await run(`Array.from(document.querySelectorAll('button')).find(item=>item.textContent.includes('供其他 Agent 继续工作的背景')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
    await waitFor('document.querySelector("[data-context-reference]")', 'reference chip');
    await run('document.querySelector("[data-context-reference] span").click()');
    await waitFor('window.openRequests.length === 1', 'click opens MD');
    assert.match(fs.readFileSync(await run('window.openRequests[0].target'), 'utf8'), /第七轮后台总结/);
    await run('window.setDraft("")'); await pause(30);
    await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true,shiftKey:true,bubbles:true}))`);
    await waitFor('document.querySelector(".extract-dialog") && !document.querySelector(".extract-dialog select").disabled', 'shortcut opens');
    await click('临时保存 · 30 秒'); await waitFor('document.querySelector(".extract-bulb")', 'pending bulb');
    await run(`Array.from(document.querySelectorAll('.conversation-row')).find(item=>item.textContent.includes('另一个会话')).click()`);
    await waitFor('window.activeSession === "other" && document.querySelector(".extract-bulb")', 'bulb across sessions');
    await run('document.querySelector(".extract-bulb").click()');
    await waitFor('!document.querySelector(".extract-bulb") && document.querySelector("[data-context-reference]")', 'temporary consumed');
    await run('window.setDraft(""); window.extractContext.open("source")');
    await waitFor('document.querySelector(".extract-dialog") && !document.querySelector(".extract-dialog select").disabled', 'second temporary');
    await click('临时保存 · 30 秒'); await waitFor('document.querySelector(".extract-bulb")', 'second bulb');
    await run('window.testExtract.expire()'); await waitFor('!document.querySelector(".extract-bulb")', 'expiry removes bulb');
    await run(`(() => { const data = new DataTransfer(); document.querySelector('.conversation-row').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));
      document.querySelector('main').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()`);
    await waitFor('document.querySelector("[data-context-reference]")', 'drag into conversation');
    await run(`window.setDraft(''); Array.from(document.querySelectorAll('.conversation-row')).find(item=>item.textContent.includes('构建和验证记录')).click()`);
    await pause(30);
    await run(`(() => { const data = new DataTransfer(); document.querySelector('.conversation-row').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data})); document.querySelector('main').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()`);
    await waitFor('document.querySelector("[data-context-reference]")', 'self reference');
    await contextMenu(); await click('Fork 会话'); await waitFor('window.activeSession === "fork-1"', 'fork opens');
    assert.equal(sessions.snapshot('fork-1').turns.length, 7);
    await run('window.extractContext.open("source")');
    await waitFor('document.querySelector(".extract-dialog") && !document.querySelector(".extract-dialog select").disabled', 'export dialog');
    await click('另存为 Markdown'); await waitFor('!document.querySelector(".extract-dialog")', 'export finished');
    assert.match(fs.readFileSync(path.join(directory, 'export.md'), 'utf8'), /第七轮后台总结/);
    await run('window.setModelTokens(1600)'); await pause(20); await run('window.extractContext.open("source")');
    await waitFor('document.querySelector(".extract-dialog") && !document.querySelector(".extract-dialog select").disabled', 'small model');
    await change('.extract-dialog select', 'select'); await waitFor('document.querySelector(".extract-selection-bar")', 'small model selection');
    await run('document.querySelectorAll(".extract-circle[aria-checked=false]").forEach(button => button.click())');
    await waitFor('document.querySelector(".extract-selection-bar .extract-error")', 'selection limit enforced');
    assert.ok(await run('window.extractContext.draft.preview.source.units.filter(unit=>window.extractContext.draft.keys.includes(unit.key)).reduce((n, unit)=>n+unit.tokens, window.extractContext.draft.preview.overheadTokens) <= 400'));
    await click('完成选择');
    await run('document.querySelector(".app").classList.replace("theme-dark", "theme-bright")');
    window.setSize(850, 650); await pause(150);
    const bounds = await run('(() => { const r = document.querySelector(".extract-dialog").getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight}; })()');
    assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.w && bounds.bottom <= bounds.h);
    fs.writeFileSync(path.resolve('tmp/conversation-extraction-light.png'), (await window.webContents.capturePage()).toPNG());
    assert.deepEqual(dialogs, []); assert.deepEqual(errors.filter(item => !/React DevTools/.test(item)), []);
    console.log('Conversation extraction UI passed: context menu, shortcut, selection, @, MD preview, temporary consume/expiry, drag/self reference, fork.');
  } catch (error) {
    fs.writeFileSync(path.resolve('tmp/conversation-extraction-ui-failure.png'), (await window.webContents.capturePage()).toPNG());
    console.error(error); process.exitCode = 1;
  } finally { extracts.close(); window.destroy(); app.exit(process.exitCode || 0); }
}).catch(error => { console.error(error); app.exit(1); });
