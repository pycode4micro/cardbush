const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]); app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => app.exit(1), 40000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 980, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const read = code => win.webContents.executeJavaScript(code);
  const until = async code => { const end=Date.now()+5000; while(!await read(`Boolean(${code})`)){if(Date.now()>end)throw Error(code+'\n'+await read('document.body.innerText'));await new Promise(r=>setTimeout(r,30));} };
  const set = async (selector,value) => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  try {
    await win.loadFile(join(directory,'index.html')); await until('document.querySelector(".remote-workers > header button")');
    await read('document.querySelector(".remote-workers > header button").click()'); await until('document.querySelector(".agents-form")');
    await set('.agents-form select','direct'); await until('document.querySelector(".agents-form input[type=url]")');
    await set('.agents-form input','Rendering worker'); await set('.agents-form input[type=url]','https://worker.example'); await set('.agents-form input[type=password]','fixture-token');
    await read('document.querySelector(".agents-form").requestSubmit()'); await until('document.querySelector(".agents-form [role=alert]")');
    assert.equal(await read('records.length'),1); await read('window.fail=false;document.querySelector(".agents-form").requestSubmit()');
    await until('!document.querySelector(".agents-form")'); assert.equal(await read('records.length'),1,'retry edits the saved record');
    assert.equal(await read('saved[1].id'),'worker-1'); await until('!document.querySelector(".remote-workers article button").disabled');
    await read('document.querySelector(".remote-workers article button").click()'); assert.equal(await read('registered.agentId'),'service-1');
    await read('window.workerVersion="0.0";document.querySelectorAll(".remote-workers article button")[1].click()');
    await until('document.querySelector(".remote-workers > [role=alert]") && document.querySelector(".remote-workers article button").disabled');
    await read('window.workerVersion="0.1";window.workerProfile="unrelated-profile";document.querySelectorAll(".remote-workers article button")[1].click()');
    await until('document.querySelector(".remote-workers > [role=alert]") && document.querySelector(".remote-workers article button").disabled');
    await read('window.workerProfile="subagent-remote-proton";document.querySelectorAll(".remote-workers article button")[1].click()');
    await until('!document.querySelector(".remote-workers > [role=alert]") && !document.querySelector(".remote-workers article button").disabled');
    assert.equal(await read('document.querySelectorAll(".agent-chat, .chat-composer").length'),0);
    await read('setLanguage("zh")'); await until('document.querySelector(".remote-workers").innerText.includes("远程")');
    win.setSize(500,800); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);
    await read('document.documentElement.dataset.theme="light";setLanguage("en")'); await until('document.querySelector(".remote-workers").innerText.includes("worker")');
    console.log('Remote worker UI passed: save/retry, identity, no direct chat, languages, narrow layout and theme.');
    clearTimeout(deadline); win.destroy(); app.quit();
  } catch(error){console.error(error);clearTimeout(deadline);win.destroy();app.exit(1);}
});
