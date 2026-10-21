import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, cp, access } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { packageAgent, verifyAgentPackage } from './package-agent.mjs';

const base = resolve('tmp/agent-package-tests');
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')), source = join(root, 'source');
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  for (const path of ['package.json', 'package-lock.json', 'dist-electron/agentServiceCli.mjs', 'dist-electron/agentService.mjs',
    'dist-electron/agentBundledAssets.mjs', 'dist-electron/agentDesktopProbe.mjs', 'dist-electron/runtimeHostWorker.mjs', 'packages/bush-runtime/package.json', 'packages/bush-runtime/dist/processResourceGuard.js',
    'dist-electron/agentInteractiveDesktopCli.mjs', 'dist-electron/agentDesktopBridge.mjs', 'dist-electron/desktopMcpServer.mjs', 'deploy/agent/install-windows-desktop.ps1',
    'dist-electron/agentBrowserConnector.mjs', 'dist-electron/chromeConnectorBroker.js', 'dist-electron/chromeConnectorFiles.js', 'dist-electron/chromeConnectorWebSocket.js', 'dist-electron/chromeConnectorConstants.js',
    'scripts/agent-desktop/worker.py','scripts/agent-desktop/computer.py','scripts/agent-desktop/browser.py',
    'packages/cardbush-platform/package.json', 'packages/cardbush-platform/dist/index.js', 'packages/cardbush-platform/dist-cjs/index.js', 'assets/fixture.txt']) {
    await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), '{}');
  }
  for (const name of ['cardbush-apps-mcp', 'cardbush-chrome-mcp']) {
    await mkdir(join(source, 'packages', name, 'dist'), { recursive: true });
    await writeFile(join(source, 'packages', name, 'package.json'), '{}');
    await writeFile(join(source, 'packages', name, 'dist/index.js'), '');
  }
  const browserEntry = join(source, 'assets/plugins/chrome/runtime/chrome-devtools-mcp/build/src/bin');
  await mkdir(browserEntry, { recursive: true }); await writeFile(join(browserEntry, 'chrome-devtools-mcp.js'), '');
  await mkdir(join(source,'assets/skills'),{recursive:true});
  await mkdir(join(source,'assets/plugins/fixture/.codex-plugin'),{recursive:true});
  await writeFile(join(source,'assets/plugins/marketplace.json'),JSON.stringify({plugins:[{name:'fixture',source:{source:'local',path:'./fixture'},policy:{installation:'AVAILABLE'}}]}));
  await writeFile(join(source,'assets/plugins/fixture/.codex-plugin/plugin.json'),JSON.stringify({name:'fixture',version:'1.0.0',description:'Fixture'}));
  return { root, source, output: join(root, 'output') };
}
test('Linux Agent packaging retains runtime and CommonJS dependencies without requiring Windows helpers', async t => {
  const f = await fixture(t); await packageAgent(f.source, f.output, 'linux');
  await verifyAgentPackage(f.output, 'linux');
  await access(join(f.output, 'packages/cardbush-platform/dist-cjs/index.js'));
  await assert.rejects(packageAgent(f.source, f.output, 'linux'), { code: 'EEXIST' });
  await assert.rejects(packageAgent(f.source, f.root, 'linux'), /must not contain/);
});
test('Agent packaging checks declared bundled plugins in both source and staged releases', async t => {
  const f=await fixture(t);
  const manifest='assets/plugins/fixture/.codex-plugin/plugin.json';
  const original=await readFile(join(f.source,manifest));
  await rm(join(f.source,manifest));
  await assert.rejects(packageAgent(f.source,f.output,'linux'),/bundled plugin is missing/);
  await assert.rejects(access(f.output),{code:'ENOENT'});
  await writeFile(join(f.source,manifest),original);
  await packageAgent(f.source,f.output,'linux');
  await rm(join(f.output,manifest));
  await assert.rejects(verifyAgentPackage(f.output,'linux'),/bundled plugin is missing/);
});

test('Agent packaging includes the actual desktop/browser MCP entry points, not only their manifests', async t => {
  const f = await fixture(t);
  await packageAgent(f.source, f.output, 'linux');
  const entry = join(f.output, 'packages/cardbush-chrome-mcp/dist/index.js');
  await access(entry); await rm(entry);
  await assert.rejects(verifyAgentPackage(f.output, 'linux'), /ENOENT|MCP entry is missing/);
});
test('Windows packaging cannot omit the manifest or executable and checks the staged output', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(packageAgent(f.source, f.output, 'win32'), { code: 'ENOENT' });
  await assert.rejects(access(f.output), { code: 'ENOENT' });
  const native = join(f.source, 'dist-native/process-guard'); await mkdir(native, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve('dist-native/process-guard/current.json'), 'utf8'));
  await cp(resolve('dist-native/process-guard/current.json'), join(native, 'current.json'));
  await assert.rejects(verifyAgentPackage(f.source, 'win32'), { code: 'ENOENT' });
  await cp(resolve('dist-native/process-guard', manifest.fileName), join(native, manifest.fileName));
  await assert.rejects(verifyAgentPackage(f.source, 'win32'), { code: 'ENOENT' });
  await cp(resolve('dist-native/chrome-connector'), join(f.source, 'dist-native/chrome-connector'), { recursive: true });
  await packageAgent(f.source, f.output, 'win32');
  await verifyAgentPackage(f.output, 'win32');
  const connector = join(f.output, 'dist-native/chrome-connector/CardBushBrowserHost.exe');
  await access(connector); await rm(connector);
  await assert.rejects(verifyAgentPackage(f.output, 'win32'), { code: 'ENOENT' });
  await cp(resolve('dist-native/chrome-connector/CardBushBrowserHost.exe'), connector);
  await writeFile(join(f.output, 'dist-native/process-guard', manifest.fileName), 'broken');
  await assert.rejects(verifyAgentPackage(f.output, 'win32'), { code: 'resource_protection_unavailable' });
});
