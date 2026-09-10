const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Automation UI timed out'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const read = script => win.webContents.executeJavaScript(script);
  const until = async script => { const end = Date.now() + 5000; while (!await read(script)) { if (Date.now() > end) throw Error('Timed out: '+script+'; '+await read('document.body.innerText')); await new Promise(r=>setTimeout(r,25)); } };
  const click = label => read(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&b.checkVisibility()).click()`);
  const field = (label, value) => read(`(()=>{const input=Array.from(document.querySelectorAll('label')).find(e=>e.textContent.startsWith(${JSON.stringify(label)})).querySelector('input,textarea,select');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  const capture = async name => { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); writeFileSync(resolve('tmp',name),(await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadFile(join(directory,'index.html')); await until('document.body.innerText.includes("还没有自动化")');
    await click('新建自动化'); await field('名称','每日项目检查'); await field('执行提示词','检查项目构建和导出结果，将需要处理的问题整理到此会话。');
    await field('触发方式','interval'); await field('每隔多少分钟','1440');
    await capture('automations-form.png'); await click('保存自动化'); await until('document.querySelectorAll(".automation-card").length===1');
    assert.equal(await read('state.jobs[0].trigger.seconds'),86400); assert.match(await read('state.jobs[0].trigger.at'),/Z$/);
    await click('暂停'); await until('document.querySelector(".automation-state").textContent==="已暂停"');
    await click('立即执行'); await until('document.querySelector(".automation-state").textContent==="执行中"');
    assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="编辑").disabled'),true);
    await click('停止'); await until('document.querySelector("summary").textContent.includes("已停止")');
    await click('打开会话'); assert.deepEqual(await read('opened'),['session']);
    await click('编辑'); await field('触发方式','event'); await field('事件','PostToolUseFailure'); await field('工具名称','terminal_exec');
    await read('failSave=true'); await click('保存自动化'); await until('!!document.querySelector("[role=alert]")');
    assert.ok(await read('!!document.querySelector(".automation-form")'),'failed save retains the draft');
    await read('failSave=false'); await click('保存自动化'); await until('!document.querySelector(".automation-form")');
    assert.equal(await read('state.jobs[0].trigger.event'),'PostToolUseFailure');
    assert.equal(await read('calls.filter(c=>c.action==="update").at(-1).expectedRevision'),1);
    await read('state.jobs[0].runs.at(-1).status="completed";notify()'); await until('document.querySelector("summary").textContent.includes("已完成")');
    await capture('automations-list.png'); win.setSize(420,820); await capture('automations-narrow.png');
    assert.ok(await read('document.documentElement.scrollWidth<=window.innerWidth'),'no horizontal overflow');
    await click('删除'); await until('document.querySelectorAll(".automation-card").length===0');
    console.log('Automation UI passed: create, time zone, pause/run/stop, conversation, conflict retention, event editing, notifications and narrow layout.');
  } finally { clearTimeout(deadline); win.destroy(); }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
