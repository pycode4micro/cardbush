import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'runtime-plugin-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { RuntimePluginWorkspace } from '${local('src/plugins/runtimeWorkspaces.tsx')}';
import { refreshRuntimeRendererPlugins, useRuntimeDelegationWorkspace, selectRuntimePluginChoice, prepareRuntimePluginTurn } from '${local('src/plugins/runtimeExtensions.ts')}';
import '${local('src/styles/app.css')}'; import '${local('src/styles/theme.css')}';
window.refreshPlugins = refreshRuntimeRendererPlugins;
window.selectChoice = id => selectRuntimePluginChoice('team', id);
window.prepareSelected = () => prepareRuntimePluginTurn({teamModeEnabled:true,teamId:'general'}, [{name:'read_file',description:'fixture',inputSchema:{type:'object'}}]);
function Fixture() { const state=useRuntimeDelegationWorkspace(); window.selection=state;
  return <div className="app theme-dark" style={{height:'100vh',display:'flex',flexDirection:'column'}}><output id="selected">{state.selectedId}</output><div style={{display:'flex',flex:1,minHeight:0}}><RuntimePluginWorkspace id="team" language="zh"/></div></div>;
} createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'installed-plugin-test', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__installed_plugin_fixture__.tsx')) return '\0fixture.tsx';
      if (importer?.replaceAll('\\', '/').endsWith('plugins/runtimeExtensions.ts') && id.includes('ElectronRuntimeSession')) return '\0fixture-runtime';
      if (importer?.replaceAll('\\', '/').endsWith('plugins/runtimeExtensions.ts') && id.includes('productMcp')) return '\0fixture-tools';
    },
    load(id) {
      if (id === '\0fixture.tsx') return source;
      if (id === '\0fixture-runtime') return `export function createDesktopRuntimeSession(){return {client:{command: async (cmd,decode)=>{const result=await window.cardbushDesktop.fixtureCommand(cmd);if(!result.ok)throw Error(result.error);return decode(result.value)}},dispose(){}}}`;
      if (id === '\0fixture-tools') return 'export async function synchronizeProductMcpSnapshot(){}';
    },
  }], build: { outDir: directory, emptyOutDir: true, lib: { entry: resolve('__installed_plugin_fixture__.tsx'), formats: ['es'] } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${output.filter(o => o.type === 'asset' && o.fileName.endsWith('.css')).map(o => `<link rel="stylesheet" href="${o.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${output.find(o => o.type === 'chunk' && o.isEntry).fileName}"></script></body></html>`);
  await writeFile(join(directory, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('cardbushDesktop',{
    runtimePluginRenderers:()=>ipcRenderer.invoke('fixture:renderers'),runtimePluginFile:input=>ipcRenderer.invoke('fixture:file',input),fixtureCommand:cmd=>ipcRenderer.invoke('fixture:command',cmd),onCapabilityCatalogChanged:()=>()=>{}
  });`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(createRequire(import.meta.url)('electron'), ['scripts/test-runtime-plugin-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 50000 });
  assert.equal(run.status, 0, String(run.error ?? 'Installed plugin UI failed'));
} finally { assert.ok(directory.startsWith(parent + sep + 'runtime-plugin-ui-')); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
