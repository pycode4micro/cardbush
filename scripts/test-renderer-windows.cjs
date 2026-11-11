// Mount the actual split production entry, isolated from the product profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const parent = path.resolve('tmp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'renderer-windows-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  try {
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], {
      env, windowsHide: true, stdio: 'inherit', timeout: 60000,
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    assert.ok(directory.startsWith(parent + path.sep + 'renderer-windows-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} else {
  void run().catch(error => { console.error(error); electron.app.exit(1); });
}

async function run() {
  const { app, BrowserWindow, ipcMain, session } = electron;
  app.setPath('userData', path.join(path.resolve(process.argv[2]), 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 50000);
  await app.whenReady();
  // No provider or external website is involved in this loading test.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file|data|blob):/.test(details.url) });
  });
  const errors = [];
  ipcMain.handle('window:is-visible', () => true);
  ipcMain.handle('debug:append-log', (_event, _category, payload) => { errors.push(payload); return ''; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const [mode, selector] of [
    ['main', '.app'], ['shadow', '.shadow-window-shell'],
  ]) {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    const failures = [];
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error' && /Uncaught|ReferenceError|SyntaxError|TypeError|Minified React error/.test(message)) failures.push(message);
    });
    try {
      await win.loadFile(path.resolve('dist/index.html'), { query: { window: mode } });
      const end = Date.now() + 8000;
      while (!await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
        assert.deepEqual(failures, []);
        if (Date.now() >= end) throw Error(`Timed out mounting ${mode}: ${await win.webContents.executeJavaScript('document.body.innerText')}`);
        await pause(25);
      }
      await pause(100);
      if (mode === 'main') {
        const read = code => win.webContents.executeJavaScript(code).catch(cause => {
          throw new Error(`Production window script failed: ${code}; renderer errors: ${failures.join('\n')}`, { cause });
        });
        const until = async code => { const end = Date.now() + 6000; while (!await read(code)) { if (Date.now() >= end) throw Error('Assistant event integration timed out: ' + code); await pause(25); } };
        await read(`localStorage.setItem('cardbush_personal_assistant_v1', JSON.stringify({name:'Existing assistant',persona:'Existing persona'}));
          localStorage.setItem('cardbush_your_friends_v1', JSON.stringify({version:2, introduction:{confirmedAt:'2026-11-01T01:00:00Z', answers:{context:'Migrated routine'}},
            delegation:{beforeExecution:'ask',report:'always'},events:[{id:'previous-note',text:'Original evidence',createdAt:'2026-11-01T01:00:00Z',archived:false}]}));void 0`);
        await win.loadFile(path.resolve('dist/index.html'), { query: { window: mode } });
        await until('document.querySelector("[data-nav-section=assistant]")');
        const migrated = await read('JSON.parse(localStorage.getItem("cardbush_personal_assistant_v1"))');
        assert.equal(migrated.name, 'Existing assistant'); assert.equal(migrated.persona, 'Existing persona');
        assert.equal(migrated.proactive.recognition.context, 'Migrated routine'); assert.equal(migrated.proactive.report, 'always');
        assert.equal(await read('!!document.querySelector("[data-nav-section=your-friends]")'), false);
        await read('document.querySelector("[data-nav-section=assistant]").click();void 0');
        await until('document.querySelector("[data-profile-action=events]")');
        await read(`window.eventActions=[];window.testEvents=['first','second'].map(id=>({id,title:'Reminder '+id,status:'watching',subscription:id==='first',inputs:[]}));
          testEvents[0].recurrence={unit:'week',interval:1,startLocal:'2026-11-09T09:00',timeZone:'Asia/Shanghai'};
          window.cardbushDesktop={...window.cardbushDesktop,runtime:{command:async request=>{
            const {kind,payload}=request.command;
            if(kind!=='runtime.friends')throw Error('No fixture for '+kind);
            if(payload.action==='delete'){eventActions.push(payload);testEvents=testEvents.filter(event=>event.id!==payload.eventId);}
            return {protocol:request.protocol,operationId:request.operationId,type:'command_response',ok:true,
              result:{configured:true,events:testEvents,detections:testEvents.filter(e=>e.recurrence).map(e=>({id:'timer',eventId:e.id,at:'2026-11-09T01:00:00Z'})),permissions:[],solutions:[]}};
          }}};
          document.querySelector('.profile-trigger').click();document.querySelector('[data-profile-action=events]').click();void 0`);
        await until('document.querySelector(".assistant-events-dialog[open]")');
        assert.ok(await read('!!document.querySelector(".assistant-events-dialog textarea")'));
        assert.ok(await read('document.querySelector(".assistant-events-dialog details").textContent.includes("Original evidence")'));
        const picker = '.assistant-events-dialog [role=combobox]';
        await until(`document.querySelector('${picker}')`);
        await read(`document.querySelector('${picker}').click();void 0`);
        await read(`Array.from(document.querySelectorAll('.assistant-events-dialog [role=option]')).find(node=>node.textContent.includes('Reminder first')).click();void 0`);
        await until('document.querySelector(".event-overview h3")?.textContent==="Reminder first"');
        const subscriptionLabel = await read('document.querySelector(".friends-event-details .friends-aside").textContent');
        assert.ok(/长期订阅|Ongoing subscription/.test(subscriptionLabel), subscriptionLabel);
        const nextTrigger = await read('document.querySelector(".friends-event-details .friends-aside:nth-of-type(2)").textContent');
        assert.match(nextTrigger, /9:00/);
        assert.match(nextTrigger, /Asia\/Shanghai/);
        await read('document.querySelector(".event-actions [data-action=delete]").click();void 0');
        await until('document.querySelector(".confirm-action-dialog[open]")?.textContent.includes("Reminder first")');
        assert.deepEqual(await read('eventActions'), []);
        await read('document.querySelector(".confirm-action-dialog .danger").click();void 0');
        await until('!document.querySelector(".event-overview") && eventActions.length===1');
        assert.deepEqual(await read('eventActions'), [{ action: 'delete', eventId: 'first' }]);
        assert.deepEqual(await read('testEvents.map(event=>event.id)'), ['second']);
        await read('document.querySelector(".assistant-events-dialog .settings-dialog-header button").click();void 0');
        await until('!document.querySelector(".assistant-events-dialog")');
        assert.ok(await read('!!document.querySelector("[data-profile-action=events]")'));
      }
      assert.deepEqual(failures, [], `${mode} must evaluate its split chunks without runtime errors`);
    } finally {
      win.destroy();
    }
  }
  assert.deepEqual(errors, []);
  clearTimeout(deadline);
  console.log('Production window entries passed: workspace, Assistant event entry and return, and Shadow.');
  app.exit(0);
}
