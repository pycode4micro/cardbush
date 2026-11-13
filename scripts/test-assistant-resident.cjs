// Exercise the real main process, renderer, worker and tray with an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const electron = require('electron');
const project = path.resolve(__dirname, '..');
if (typeof electron === 'string') {
  const base = path.join(project, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'assistant-resident-'));
  const modes = process.argv.includes('--profile') ? ['workspace'] : ['workspace', 'resident'];
  for (const mode of modes) {
    const profile = path.join(root, mode);
    fs.mkdirSync(profile);
    const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, USERPROFILE: profile, HOME: profile,
      CARDBUSH_DEVELOPMENT_RUNTIME: '1', CARDBUSH_ELECTRON_DEV_SERVER_URL: '' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = spawnSync(electron, [__filename, profile, mode], { cwd: project, env, windowsHide: true, stdio: 'inherit', timeout: 120_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, mode);
  }
  const stats = Object.fromEntries(modes.map(k => [k, JSON.parse(fs.readFileSync(path.join(root, k, 'metrics.json'), 'utf8'))]));
  console.log(JSON.stringify(stats)); console.log(root);
} else {
  run().catch(error => { console.error(error); electron.app.exit(1); });
}
async function run() {
  const { app, BrowserWindow, Notification, Tray } = electron;
  const root = process.argv[2], resident = process.argv[3] === 'resident';
  const badgeByWindow = new Map();
  if (process.platform === 'win32') {
    const apply = BrowserWindow.prototype.setOverlayIcon;
    BrowserWindow.prototype.setOverlayIcon = function(image, description) {
      const previous = badgeByWindow.get(this.id);
      badgeByWindow.set(this.id, { pixels: image?.toPNG(), description, calls: (previous?.calls ?? 0) + 1 });
      return apply.call(this, image, description);
    };
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => {
    const end = Date.now() + 55_000;
    while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(150); }
    throw Error('Timed out: ' + label);
  };
  app.setPath('appData', root); app.setPath('userData', root); app.setAppPath(project);
  for (const key of ['desktop','documents','downloads','pictures']) {
    const directory=path.join(root,key); fs.mkdirSync(directory,{recursive:true}); app.setPath(key,directory);
  }
  // Persisted selection works without CLI flags and without opening a renderer first.
  fs.writeFileSync(path.join(root, 'assistant-resident.json'), JSON.stringify({ enabled: resident, language: 'en' }));
  const library = require('../assets/skills/cardbush-docs/scripts/home-library.cjs').openLibrary(root);
  library.publish({id:'fixture', title:'Fixture card', html:'<p>Local content</p>'});
  library.close();
  const at = new Date(Date.now() + 28_000).toISOString();
  const friends = path.join(root, 'runtime-state', 'friends');
  fs.mkdirSync(friends, { recursive: true });
  fs.writeFileSync(path.join(friends, 'events.json'), JSON.stringify({ version: 1,
    configuration: { assistant: { name: 'Fixture' }, profile: { name: 'Fixture', timeZone: 'UTC', language: 'en', recognition: {}, confirmedAt: at },
      parent: { protocol: 'bush.session_turn_request.v1', sessionId: 'personal-assistant', turnId: 'fixture', requestId: 'fixture',
        model: 'fixture', tools: [], inputMessages: [], prefixMessages: [], metadata: {}, permissionMode: 'task_free' } },
    events: [{ id: 'reminder', logicalKey: 'test', origin: 'user', title: 'Test', intent: 'Test', inputs: [], status: 'watching',
      reminderText: 'Resident reminder', archived: false, revision: 1, createdAt: at, updatedAt: at }],
    signals: [], detections: [{ id: 'tick', eventId: 'reminder', at }] }));
  let tray, menu;
  const setMenu = Tray.prototype.setContextMenu;
  Tray.prototype.setContextMenu = function (next) { tray = this; menu = next; return setMenu.call(this, next); };
  const notices = [];
  // Capture system notification requests and exercise the real activation handler without displaying test toasts.
  Notification.prototype.show = function () { notices.push(this); };
  function processTree() {
    if (process.platform !== 'win32') return {};
    // Include stdio MCP servers and helper children that app.getAppMetrics() omits.
    // Exclude this measurement process and its descendants.
    const script = `$rows = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CommandLine -ErrorAction Stop
      $ids = @(${process.pid})
      $bytes = [double]0
      $supervisors = 0
      while ($ids.Count) {
        $level = @($rows | Where-Object { $_.ProcessId -in $ids })
        $bytes += [double](($level | Measure-Object WorkingSetSize -Sum).Sum)
        $supervisors += @($level | Where-Object { $_.CommandLine -like '*stdioProcessEntry.js*' -and $_.CommandLine -notlike '*--lease*' }).Count
        $ids = @($rows | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId })
      }
      @{processTreeMiB = [math]::Round($bytes / 1MB); stdioSupervisors = $supervisors} | ConvertTo-Json -Compress`;
    const sample = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    assert.equal(sample.status, 0, sample.stderr); return JSON.parse(sample.stdout);
  }
  const take = () => {
    const metrics = app.getAppMetrics();
    return { windows: BrowserWindow.getAllWindows().length, renderers: metrics.filter(p => p.type === 'Tab').length,
      workingSetMiB: Math.round(metrics.reduce((n, p) => n + p.memory.workingSetSize, 0) / 1024), ...processTree() };
  };
  // Hold the real call before audio capture so the test exercises voice controls without a microphone.
  const ipc=electron.ipcMain, handle=ipc.handle;
  let audioGate;
  let floatingLibraryReads = 0;
  ipc.handle=function(channel,listener) {
    if (channel === 'home-components:library') return handle.call(this,channel,(event,...args) => {
      if (event.sender.getURL().includes('window=assistant')) floatingLibraryReads++;
      return listener(event,...args);
    });
    if (channel !== 'voice:settings') return handle.call(this,channel,listener);
    return handle.call(this,channel,async (...args)=>{ await audioGate; return listener(...args); });
  };
  require(path.join(project, 'dist-electron', 'bootstrap.js'));
  ipc.handle=handle;
  const holdAudioSettings = () => {
    let release;
    audioGate=new Promise(resolve=>{release=resolve;});
    return ()=>{release();audioGate=undefined;};
  };
  await wait(() => tray && menu, 'tray');
  assert.deepEqual(menu.items.map(item => item.type), ['normal', 'checkbox', 'separator', 'normal'], 'tray groups Home and the floating Assistant separately from Quit');
  for (const item of [menu.items[0], menu.items.at(-1)]) {
    const icon = typeof item.icon === 'string' ? electron.nativeImage.createFromPath(item.icon) : item.icon;
    assert.deepEqual(icon.getSize(), {width:16,height:16}, 'action icons occupy the native checkmark column');
  }
  assert.ok(!menu.items[1].icon, 'the checkbox uses just the native state indicator');
  assert.equal(menu.items[1].checked, false);
  const stats = {};
  if (resident) {
    await sleep(1500); stats.idle = take();
    assert.equal(stats.idle.windows, 0); assert.equal(stats.idle.renderers, 0);
    await wait(() => app.getAppMetrics().some(p => p.name === 'CardBush Runtime Host'), 'resident Runtime starts without opening a window');
    const notice = await wait(() => notices.find(n => n.body === 'Resident reminder'), 'cold-start reminder without renderer');
    stats.delivered = take(); assert.equal(stats.delivered.windows, 0);
    assert.equal(stats.delivered.windows, 0, 'the built-in catalog warms without opening a window');
    notice.emit('click');
    const win = await wait(() => BrowserWindow.getAllWindows()[0], 'notification opened Assistant');
    await wait(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".resident-assistant .floating-capsule"))'), 'floating Assistant');
    assert.equal(win.isAlwaysOnTop(), true);
    assert.equal(menu.items[1].checked, true);
    assert.deepEqual(await win.webContents.executeJavaScript('window.cardbushDesktop.assistantHomeComponentCatalog()'), [{id:'fixture', title:'Fixture card'}]);
    await win.webContents.executeJavaScript("for(let i=0;i<4;i++) window.dispatchEvent(new Event('focus'))");
    await wait(() => win.webContents.executeJavaScript('document.querySelector(".capsule-replies")?.innerText.includes("Resident reminder")'), 'same journal');
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("[data-nav-section]")'), false);
    await sleep(1500); stats.open = take();
    await win.webContents.executeJavaScript("document.querySelector('[data-action=compose]').click()");
    await wait(()=>win.webContents.executeJavaScript("!!document.querySelector('.capsule-form input')"), 'inline editor');
    await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.capsule-form input'); if (!n) throw Error('missing composer');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'Unsent fixture draft'); n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const popup = electron.Menu.prototype.popup;
    let usedContextMenu = false;
    electron.Menu.prototype.popup = function (options) {
      const close = this.getMenuItemById('close-floating-assistant');
      if (!close) return popup.call(this, options);
      assert.deepEqual(this.items.slice(0, 3).map(item => item.role), ['cut', 'copy', 'paste']);
      usedContextMenu = true;
      options.callback(); close.click();
    };
    try {
      await sleep(150);
      const point = await win.webContents.executeJavaScript("(()=>{const b=document.querySelector('.capsule-form input').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()");
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'right',clickCount:1,...point});
      await wait(()=>usedContextMenu && !win.isVisible(), 'right-click closes the capsule');
    } finally { electron.Menu.prototype.popup = popup; }
    assert.ok(!win.isDestroyed(), 'closing retains the draft');
    assert.equal(menu.items[1].checked, false);
    const openDraft = async target => {
      await wait(() => target.webContents.executeJavaScript("!!document.querySelector('[data-action=compose]')"), 'draft collapsed to toolbar');
      await target.webContents.executeJavaScript("document.querySelector('[data-action=compose]').click()");
      return wait(() => target.webContents.executeJavaScript("document.querySelector('.capsule-form input')?.value"), 'retained draft in editor');
    };
    menu.items[1].click(); assert.equal(await openDraft(win), 'Unsent fixture draft');
    await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('.capsule-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,''); n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(150);
    win.close(); await wait(() => win.isDestroyed(), 'release floating renderer');
    await wait(() => !app.getAppMetrics().some(p => p.type === 'Tab'), 'release renderer process');
    stats.closed = take();
    menu.items[1].click();
    await wait(() => BrowserWindow.getAllWindows()[0]?.isVisible(), 'tray restores the floating Assistant');
    const reopened = BrowserWindow.getAllWindows()[0];
    await wait(() => reopened.webContents.executeJavaScript('Boolean(document.querySelector(".resident-assistant"))'), 'reopened UI');
    // Exercise the first tool request after the local reminder and renderer teardown.
    const readCatalog = win => win.webContents.executeJavaScript(`window.cardbushDesktop.runtime.command({
      protocol:'bush.runtime_ipc.v1', type:'command', operationId:crypto.randomUUID(),
      command:{kind:'runtime.get_mcp_snapshot',payload:{}}
    })`);
    const catalog = await readCatalog(reopened);
    assert.equal(catalog.ok, true, JSON.stringify(catalog.error));
    assert.ok(catalog.result.servers.some(s => s.id === 'plugin_xlsx_documents' && s.tools.length), 'on-demand document tools are usable');
    stats.withTools = take();
    reopened.close();
    await wait(() => reopened.isDestroyed(), 'release window after tool discovery');
    if (process.platform === 'win32') {
      await sleep(35_000);
      stats.afterTools = await wait(() => {
        const sample = take();
        return sample.stdioSupervisors >= stats.withTools.stdioSupervisors && sample.stdioSupervisors > 0 && !sample.renderers && sample;
      }, 'keep document tools resident after closing the capsule');
      menu.items[1].click();
      const next = await wait(() => BrowserWindow.getAllWindows()[0], 'restore Assistant after cleanup');
      await wait(() => next.webContents.executeJavaScript('Boolean(document.querySelector(".resident-assistant"))'), 'restored UI');
      const restored = await readCatalog(next);
      assert.ok(restored.ok && restored.result.servers.some(s => s.id === 'plugin_xlsx_documents' && s.tools.length), 'document tools remain available after idle');
    }
    if (!menu.items[1].checked) menu.items[1].click();
    const capsule = await wait(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('window=assistant')), 'resident capsule');
    await wait(() => capsule.webContents.executeJavaScript("!!document.querySelector('[data-action=compose]')"), 'resident toolbar');
    await capsule.webContents.executeJavaScript("document.querySelector('[data-action=compose]').click()");
    await wait(() => capsule.webContents.executeJavaScript("!!document.querySelector('.capsule-form input')"), 'resident editor');
    await capsule.webContents.executeJavaScript(`const input=document.querySelector('.capsule-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Keep this draft');input.dispatchEvent(new Event('input',{bubbles:true}));`);
    tray.emit('click');
    const workspace = await wait(() => BrowserWindow.getAllWindows().find(w => w!==capsule && w.isVisible()), 'tray creates Home with a pending capsule draft');
    await wait(() => workspace.webContents.executeJavaScript("!!document.querySelector('[data-desktop-page=overview]')"), 'Home after resident launch');
    assert.ok(capsule.isVisible());
    capsule.focus();
    assert.equal(await openDraft(capsule), 'Keep this draft');
  } else {
    const win = await wait(() => BrowserWindow.getAllWindows()[0], 'workspace');
    await wait(() => win.webContents.executeJavaScript('!!document.querySelector("[data-nav-section=assistant]")'), 'workspace ready');
    await wait(() => win.webContents.executeJavaScript('window.cardbushDesktop.runtimeStartupStatus().then(s=>s.phase==="ready")'), 'runtime ready');
    await sleep(1500); stats.open = take(); win.close(); await sleep(1500); stats.idle = take();
    assert.equal(stats.idle.windows, 1);
    assert.ok(!win.isVisible(), 'closing the workspace hides it in the tray');
    tray.emit('click');
    await wait(() => win.isVisible(), 'tray Open restores the same workspace');
    await require('./helpers/personal-profile.cjs')({ win, BrowserWindow, openHome: () => tray.emit('click'),
      openAssistant: () => menu.items[1].click(), wait, root, project, holdAudioSettings });
    for (const other of BrowserWindow.getAllWindows()) if (other !== win && other.webContents.getURL().includes('window=assistant')) other.hide();
    win.show(); win.focus();
    await wait(() => win.isFocused(), 'workspace is foreground on Projects');
    for (const id of ['selected-reply','newer-reply']) {
      const entry = {id, createdAt:new Date().toISOString(), content:id, role:'assistant', source:'text', visibility:'conversation'};
      const request = {protocol:'bush.runtime_ipc.v1', type:'command', operationId:crypto.randomUUID(),
        command:{kind:'runtime.assistant_conversation',payload:{action:'append',sessionId:'personal-assistant',entry}}};
      assert.ok((await win.webContents.executeJavaScript(`window.cardbushDesktop.runtime.command(${JSON.stringify(request)})`)).ok);
    }
    const selectedNotice = await wait(() => notices.find(item => item.body === 'selected-reply'), 'foreground Projects receives the Assistant toast');
    if (process.platform === 'win32') {
      const { taskbarBadge } = require(path.join(project, 'dist-electron', 'taskbarBadge.js'));
      const pixels = count => taskbarBadge(project, count).toPNG();
      assert.equal(taskbarBadge(project, 0), null);
      assert.notDeepEqual(pixels(1), pixels(2));
      assert.notDeepEqual(pixels(99), pixels(100));
      assert.deepEqual(pixels(100), pixels(101), 'overflow shows 99+');
      await wait(() => badgeByWindow.get(win.id)?.pixels?.equals(pixels(2)), 'two unread Assistant replies on the real taskbar button');
      win.hide();
      const previous = badgeByWindow.get(win.id).calls;
      win.show();
      await wait(() => badgeByWindow.get(win.id).calls > previous && badgeByWindow.get(win.id).pixels?.equals(pixels(2)), 'restoring the workspace reapplies unread without marking it read');
    }
    selectedNotice.emit('click');
    await wait(() => win.webContents.executeJavaScript(`document.querySelector('[data-message-id="selected-reply"] article')?.checkVisibility() && document.querySelector('[data-message-id="selected-reply"] article') === document.activeElement`), 'notice opens and focuses the specific Assistant reply');
    if (process.platform === 'win32') await wait(() => badgeByWindow.get(win.id)?.pixels === undefined, 'reading Assistant removes the taskbar overlay');
  }
  assert.equal(floatingLibraryReads, 0, 'the floating window never requests the full home component library');
  fs.writeFileSync(path.join(root, 'metrics.json'), JSON.stringify(stats, null, 2));
  menu.items.at(-1).click();
}
