const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile } = require('node:fs/promises');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Installed plugin UI timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  let win;
  try {
    const { installLocalProductPlugin } = require('../dist-electron/localPluginInstall.js');
    const { loadEnabledProductRuntimeExtensions, loadEnabledProductRuntimeRenderers } = require('../dist-electron/productPlugins.js');
    const { InMemoryRuntimeHost } = await import('@cardbush/bush-runtime');
    const { RuntimePluginState } = await import(pathToFileURL(resolve('dist-electron/runtimePluginState.mjs')).href);
    const installed = join(directory, 'installed');
    await installLocalProductPlugin(resolve('release-plugins/team-0.2.0.zip'), installed);
    const roots = [{ path: installed, source: 'user' }], configPath = join(directory, 'apps.json');
    const saveEnabled = enabled => writeFile(configPath, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'team', installed: true, enabled }] }));
    await saveEnabled(true);
    const host = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false });
    const state = new RuntimePluginState({ host, dataRoot: join(directory, 'plugin-data'), loadEnabled: () => loadEnabledProductRuntimeExtensions(roots, configPath), reportError: message => console.error(message) });
    ipcMain.handle('fixture:renderers', () => loadEnabledProductRuntimeRenderers(roots, configPath));
    ipcMain.handle('fixture:command', async (_, command) => {
      await state.refresh();
      // The real Runtime IPC sends an error envelope, not a native Electron exception stack.
      try { return { ok: true, value: await host.sendCommand(command) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('fixture:file', (_, input) => { assert.equal(input.pluginId, 'team'); return null; });
    win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Plugin fixture:', event.message); });
    const read = code => win.webContents.executeJavaScript(code);
    const until = async code => { const end = Date.now() + 8000; while (!await read(code)) { if (Date.now() > end) throw Error(code + ': ' + await read('document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await win.loadFile(join(directory, 'index.html'));
    await until('!!document.querySelector(".team-agent-editor")');
    await read('selectChoice("general"); void 0');
    await until('selection.selectedId === "general"');
    await read('prepareSelected()');
    assert.equal((await host.sendCommand({ kind: 'runtime.get_team_snapshot', payload: {} })).teamCount, 1);
    // An unchanged catalog must preserve the exact mounted DOM and unfinished input.
    await read('window.originalEditor=document.querySelector(".team-agent-editor"); window.edit=document.querySelector(".team-agent-editor textarea"); edit.focus(); edit.value="Unsaved draft"; refreshPlugins()');
    assert.equal(await read('originalEditor===document.querySelector(".team-agent-editor") && document.activeElement===edit && edit.value==="Unsaved draft"'), true);
    const receipt = await host.sendCommand({ kind: 'plugin.team.configuration', payload: { action: 'read' } });
    const original = await readFile(receipt.path, 'utf8');
    await saveEnabled(false); await state.refresh(); await read('refreshPlugins()');
    assert.equal(await read('!!document.querySelector(".team-agent-editor")'), false);
    assert.equal(host.capabilities().features.includes('product_team_snapshot'), false);
    assert.equal(await readFile(receipt.path, 'utf8'), original);
    await writeFile(receipt.path, 'invalid: ['); await saveEnabled(true); await read('refreshPlugins()');
    await until('!!document.querySelector("[role=alert]")');
    await writeFile(receipt.path, original); await read('refreshPlugins()');
    await until('!!document.querySelector(".team-agent-editor")');
    assert.equal(await read('selection.selectedId'), 'general');
    const renderer = join(installed, 'team/dist/renderer.mjs');
    await writeFile(renderer, await readFile(renderer, 'utf8') + '\n// independent UI update\n');
    await read('refreshPlugins()'); await until('!!document.querySelector(".team-agent-editor")');
    assert.equal(await read('document.querySelectorAll(".team-agent-editor").length'), 1);
    const workingRenderer = await readFile(renderer, 'utf8');
    await writeFile(renderer, 'export const apiVersion=1; export default()=>({apiVersion:1,getSnapshot(){throw Error("fixture bad selection state")},subscribe(){return ()=>{}},async load(){},select(){},mount(){return {update(){},dispose(){}}},dispose(){}})');
    await read('refreshPlugins()');
    await until('document.querySelector("[role=alert]")?.textContent.includes("fixture bad selection state")');
    assert.equal(await read('!!document.getElementById("selected")'), true, 'a plugin state error leaves the parent UI alive');
    await writeFile(renderer, workingRenderer); await read('refreshPlugins()');
    await until('!!document.querySelector(".team-agent-editor")');
    for (const width of [1100, 760]) {
      win.setSize(width, 850); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await writeFile(resolve('tmp/installed-team-plugin.png'), (await win.webContents.capturePage()).toPNG()); break; }
      catch (error) { if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    console.log('Installed Team UI passed: ZIP-owned bundle, native configuration, selection/snapshot, stable DOM and focus, disable, recovery, independent update, and narrow layout.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win?.destroy(); app.exit(1); }
});
