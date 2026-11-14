const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => app.exit(1), 35000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 430, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const read = code => win.webContents.executeJavaScript(code);
  const until = async code => { const end = Date.now() + 9000; while (!await read(`Boolean(${code})`)) { if (Date.now() > end) throw Error(code + '\n' + await read('document.body.innerText')); await new Promise(r => setTimeout(r, 50)); } };
  try {
    await win.loadFile(join(directory, 'index.html')); await until('window.calls?.length');
    await read(`window.questions=[{selectionId:'remote_solution_test',sessionId:'one',turnId:'turn-child',toolCallId:'ask',createdAt:new Date().toISOString(),blocking:true,prompt:'Generation was rejected. Should the original task stay blocked without any paid retry?',options:[]}];undefined`);
    // No SSE, no status transition and no full transcript refresh.
    await until("document.querySelector('.solution-selection-card textarea')");
    assert.ok(await read("document.body.textContent.includes('Generation was rejected.')"));
    await read(`(()=>{const n=document.querySelector('.solution-selection-card textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'Keep blocked; do not retry.');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until("!document.querySelector('.solution-selection-card button[type=submit]').disabled");
    await read("document.querySelector('.solution-selection-card form').requestSubmit();undefined");
    await until("!document.querySelector('.solution-selection-card') && window.answer");
    assert.equal(await read('window.answer.text'), 'Keep blocked; do not retry.');
    assert.equal(await read('window.calls.filter(c=>c.body).length'), 1);
    await read("window.questions=[{selectionId:'remote_solution_second',sessionId:'one',turnId:'turn-child',toolCallId:'ask',createdAt:new Date().toISOString(),prompt:'Another question',options:['A','B']}];window.dispatchEvent(new Event('focus'));undefined");
    await until("document.body.textContent.includes('Another question')");
    await read("window.switchSession('two');undefined");
    await until("!document.querySelector('.solution-selection-card')");
    await read("window.fail=true;window.dispatchEvent(new Event('focus'));undefined");
    await until("document.querySelector('#unavailable').textContent==='true'");
    await read("window.fail=false;window.switchSession('one');undefined");
    await until("document.body.textContent.includes('Another question') && document.querySelector('#unavailable').textContent==='false'");
    assert.ok(await read("window.calls.every(c=>c.url.endsWith('/solutions'))"));
    console.log('Questions UI passed: idle-stream arrival, free-text answer once, session isolation and reconnect.');
  } finally { clearTimeout(deadline); win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
