const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const electron = require('electron');
const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-uninstall-worker-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename, root, process.execPath], { env, stdio: 'inherit', windowsHide: true, timeout: 45000 });
  assert.ok(root.startsWith(parent + sep + 'cardbush-uninstall-worker-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}
const { app } = electron, root = resolve(process.argv[2]), node = process.argv[3];
assert.ok(root.startsWith(parent + sep + 'cardbush-uninstall-worker-'));
mkdirSync(join(root, 'profile')); app.setPath('userData', join(root, 'profile'));
let stage = 'startup';
const deadline = setTimeout(() => { console.error('Uninstall worker fixture timed out: ' + stage); app.exit(1); }, 40000);
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

async function run() {
  await app.whenReady();
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { ElectronProductHostController } = await import('../dist-electron/productHostController.mjs');
  const { CardbushAppsConfigStore } = await import('@cardbush/product-host');
  const { loadProductPluginCatalog, installProductPlugin } = await import('../dist-electron/productPlugins.js');
  const plugins = join(root, 'plugins'), pkg = join(plugins, 'alpha'), data = join(root, 'plugin-data', 'alpha');
  const config = join(root, 'product', 'config', 'apps.json'), closed = join(root, 'closed.txt'), disposed = join(root, 'disposed.txt');
  mkdirSync(join(pkg, '.codex-plugin'), { recursive: true }); mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'settings.json'), '{}');
  writeFileSync(join(pkg, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', version: '1.0.0', description: 'fixture',
    mcpServers: { echo: { type: 'stdio', command: node, cwd: pkg, args: [join(pkg, 'server.mjs')], env: { FIXTURE_CLOSED: closed } } },
    cardbush: { runtimeExtension: { apiVersion: 1, entry: './runtime.mjs' } } }));
  writeFileSync(join(pkg, 'server.mjs'), `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
    const lines=createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
      const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});
    lines.on('close',()=>{writeFileSync(process.env.FIXTURE_CLOSED,'closed');process.exit(0)});`);
  writeFileSync(join(pkg, 'runtime.mjs'), `import {existsSync,writeFileSync} from 'node:fs';
    export const apiVersion=1;
    export default ()=>({id:'alpha',features:[],commands:{'plugin.alpha.hold':async()=>{
      writeFileSync(${JSON.stringify(join(root, 'busy'))},'busy');
      while(!existsSync(${JSON.stringify(join(root, 'release'))}))await new Promise(r=>setTimeout(r,10));return{done:true};
    }},dispose:()=>writeFileSync(${JSON.stringify(disposed)},'disposed')});`);
  const roots = [{ path: plugins, source: 'user' }];
  const store = new CardbushAppsConfigStore(config, { loadCatalog: excluded => loadProductPluginCatalog(roots, excluded) });
  await store.write(await store.read());
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  const controller = new RuntimeUtilityProcessController({ modulePath: resolve('dist-electron/runtimeHostWorker.mjs'), env: {
    ...env, CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: config,
    CARDBUSH_RUNTIME_PLUGIN_ROOTS: JSON.stringify(roots), CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_DATA_ROOT: join(root, 'plugin-data'),
  } });
  const host = new ElectronProductHostController({ dataRoot: join(root, 'product'), runtimeStateRoot: join(root, 'runtime'),
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'), bundledPluginRoot: join(root, 'bundled'), userPluginRoot: plugins, runtimeBridge: controller });
  const command = (kind, payload = {}) => controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
  const until = async check => { const end = Date.now() + 8000; while (!await check()) { assert.ok(Date.now() < end, 'Worker should settle'); await new Promise(r => setTimeout(r, 25)); } };
  let running, mutation;
  try {
    stage = 'initial MCP refresh';
    await host.refreshMcp();
    let snapshot;
    try { await until(async () => { snapshot = await command('runtime.get_mcp_snapshot'); return snapshot.result?.servers.some(server => server.id === 'plugin_alpha_echo' && server.health === 'ready'); }); }
    catch (error) { console.error(snapshot); throw error; }
    await command('runtime.get_capabilities');
    const source = join(root, 'update-alpha');
    cpSync(pkg, source, { recursive: true });
    const manifest = join(source, '.codex-plugin', 'plugin.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '2.0.0' }));
    stage = 'replace idle plugin';
    await installProductPlugin(source, plugins, (id, replace) => host.replacePlugin(id, async () => {
      assert.equal(readFileSync(closed, 'utf8'), 'closed', 'MCP with its cwd inside the plugin exits before rename');
      assert.equal(readFileSync(disposed, 'utf8'), 'disposed', 'runtime extension is disposed before rename');
      return replace();
    }));
    assert.equal((await store.read()).plugins[0].version, '2.0.0');
    assert.equal((await store.read()).plugins[0].enabled, true);
    assert.ok(existsSync(data), 'updating preserves plugin data');
    await until(async () => (await command('runtime.get_mcp_snapshot')).result?.servers.some(server => server.id === 'plugin_alpha_echo' && server.health === 'ready'));
    rmSync(closed); rmSync(disposed);
    stage = 'start busy command';
    running = command('plugin.alpha.hold'); await until(() => existsSync(join(root, 'busy')));
    stage = 'drain busy update';
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '3.0.0' }));
    let settled = false;
    mutation = installProductPlugin(source, plugins, (id, replace) => host.replacePlugin(id, replace));
    void mutation.then(() => { settled = true; }, () => { settled = true; });
    await until(() => JSON.parse(readFileSync(config, 'utf8')).plugins[0].enabled === false);
    await command('runtime.get_capabilities');
    assert.equal(settled, false, 'replacement waits for dispatched work');
    assert.equal(JSON.parse(readFileSync(join(pkg, '.codex-plugin', 'plugin.json'), 'utf8')).version, '2.0.0');
    assert.equal(existsSync(closed), false, 'the active service is retained while draining');
    assert.equal(existsSync(disposed), false, 'the active extension is retained while draining');
    writeFileSync(join(root, 'release'), 'go'); assert.equal((await running).ok, true); await mutation;
    assert.equal((await store.read()).plugins[0].version, '3.0.0');
    assert.equal((await store.read()).plugins[0].enabled, true);
    assert.ok(existsSync(data));
    await until(async () => (await command('runtime.get_mcp_snapshot')).result?.servers.some(server => server.id === 'plugin_alpha_echo' && server.health === 'ready'));
    for (const file of [closed, disposed, join(root, 'busy'), join(root, 'release')]) rmSync(file);
    running = command('plugin.alpha.hold'); await until(() => existsSync(join(root, 'busy')));
    stage = 'drain busy uninstall'; settled = false;
    mutation = host.uninstallPlugin('alpha');
    void mutation.then(() => { settled = true; }, () => { settled = true; });
    await until(() => JSON.parse(readFileSync(config, 'utf8')).plugins[0].removalPending === true);
    await command('runtime.get_capabilities');
    assert.equal(settled, false, 'uninstall waits for dispatched work');
    assert.ok(existsSync(pkg) && existsSync(data)); assert.equal(existsSync(disposed), false);
    writeFileSync(join(root, 'release'), 'go'); assert.equal((await running).ok, true);
    const result = await mutation;
    assert.equal(result.plugins.length, 0); assert.equal(existsSync(pkg), false); assert.equal(existsSync(data), false);
    assert.equal(readFileSync(closed, 'utf8'), 'closed'); assert.equal(readFileSync(disposed, 'utf8'), 'disposed');
    assert.equal((await command('runtime.get_mcp_snapshot')).result.servers.some(server => server.id === 'plugin_alpha_echo'), false);
    console.log('Real runtime update/uninstall passed: replacement drains dispatched work, stops MCP and extensions before file changes, preserves data, reconnects, and uninstall retains files until work completes.');
  } catch (error) { console.error('Uninstall worker failed during ' + stage, error); throw error; }
  finally {
    // Always release our synthetic command, including when an assertion fails.
    // Otherwise shutdown masks the actual failure behind the fixture deadline.
    writeFileSync(join(root, 'release'), 'go');
    await running?.catch(() => {});
    await mutation?.catch(() => {});
    await host.shutdown(); controller.stop(); clearTimeout(deadline);
  }
}
