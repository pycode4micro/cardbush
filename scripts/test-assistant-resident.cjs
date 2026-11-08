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
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (read, label) => {
    const end = Date.now() + 55_000;
    while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(150); }
    throw Error('Timed out: ' + label);
  };
  app.setPath('appData', root); app.setPath('userData', root); app.setAppPath(project);
  // Persisted selection works without CLI flags and without opening a renderer first.
  fs.writeFileSync(path.join(root, 'assistant-resident.json'), JSON.stringify({ enabled: resident, language: 'en' }));
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
  require(path.join(project, 'dist-electron', 'bootstrap.js'));
  await wait(() => tray && menu, 'tray');
  const stats = {};
  if (resident) {
    await sleep(1500); stats.idle = take();
    assert.equal(stats.idle.windows, 0); assert.equal(stats.idle.renderers, 0);
    assert.ok(!app.getAppMetrics().some(p => p.name === 'CardBush Runtime Host'), 'a future event does not need a worker at launch');
    const notice = await wait(() => notices.find(n => n.body === 'Resident reminder'), 'cold-start reminder without renderer');
    stats.delivered = take(); assert.equal(stats.delivered.windows, 0);
    if (process.platform === 'win32') assert.equal(stats.delivered.stdioSupervisors, 0, 'local reminders do not start stdio tool processes');
    notice.emit('click');
    const win = await wait(() => BrowserWindow.getAllWindows()[0], 'notification opened Assistant');
    await wait(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".resident-assistant .profile-trigger"))'), 'floating Assistant');
    assert.equal(win.isAlwaysOnTop(), true);
    await wait(() => win.webContents.executeJavaScript('document.querySelector(".assistant-messages")?.innerText.includes("Resident reminder")'), 'same journal');
    assert.equal(await win.webContents.executeJavaScript('!!document.querySelector("[data-nav-section]")'), false);
    await sleep(1500); stats.open = take();
    await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('textarea'); if (!n) throw Error('missing composer');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,'Unsent fixture draft'); n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(150); win.close(); await sleep(150); assert.ok(!win.isDestroyed() && !win.isVisible());
    tray.emit('double-click'); assert.equal(await win.webContents.executeJavaScript('document.querySelector("textarea").value'), 'Unsent fixture draft');
    await win.webContents.executeJavaScript(`(() => { const n = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,''); n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(150);
    win.close(); await wait(() => win.isDestroyed(), 'release floating renderer');
    await wait(() => !app.getAppMetrics().some(p => p.type === 'Tab'), 'release renderer process');
    stats.closed = take();
    tray.emit('double-click');
    await wait(() => BrowserWindow.getAllWindows()[0]?.isVisible(), 'reopen floating Assistant');
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
        return sample.stdioSupervisors === 1 && !sample.renderers && sample;
      }, 'retire idle document tools and retain desktop safety state');
      tray.emit('double-click');
      const next = await wait(() => BrowserWindow.getAllWindows()[0], 'restore Assistant after cleanup');
      await wait(() => next.webContents.executeJavaScript('Boolean(document.querySelector(".resident-assistant"))'), 'restored UI');
      const restored = await readCatalog(next);
      assert.ok(restored.ok && restored.result.servers.some(s => s.id === 'plugin_xlsx_documents' && s.tools.length), 'document tools reconnect after cleanup');
    }
  } else {
    const win = await wait(() => BrowserWindow.getAllWindows()[0], 'workspace');
    await wait(() => win.webContents.executeJavaScript('!!document.querySelector("[data-nav-section=assistant]")'), 'workspace ready');
    await wait(() => win.webContents.executeJavaScript('window.cardbushDesktop.runtimeStartupStatus().then(s=>s.phase==="ready")'), 'runtime ready');
    await sleep(1500); stats.open = take(); win.close(); await sleep(1500); stats.idle = take();
    assert.equal(stats.idle.windows, 1);
    win.show();
    await require('./helpers/personal-profile.cjs')({ win, BrowserWindow, tray, wait, root, project });
  }
  fs.writeFileSync(path.join(root, 'metrics.json'), JSON.stringify(stats, null, 2));
  menu.items.at(-1).click();
}
