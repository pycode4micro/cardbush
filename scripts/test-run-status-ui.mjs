import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'run-status-ui-'));
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantActivityDetails } from '${resolve('src/features/chatMessages/AssistantActivityDetails.tsx').replaceAll('\\', '/')}';
import { McpActivationStatus } from '${resolve('src/features/chatMessages/McpActivationStatus.tsx').replaceAll('\\', '/')}';
import '${resolve('src/styles/app.css').replaceAll('\\', '/')}';
import '${resolve('src/styles/themes/cyberpunk.css').replaceAll('\\', '/')}';
const initial = {protocol:'bush.mcp_snapshot_result.v1',snapshotId:'fixture',revision:1,pendingRevision:2,applicationState:'pending',servers:[]};
const target = {serverId:'blender',snapshotId:'fixture',revision:2,initial};
window.checks=0; window.aborts=0;
window.fixtureSnapshot = () => window.checks < 2 ? initial : {...initial,revision:2,pendingRevision:undefined,applicationState:'applied',servers:[{id:'blender',health:'ready',tools:[]}]};
const root = createRoot(document.getElementById('root'));
const executions = [
 {id:'download', name:'terminal_exec', state:'completed',summary:'下载素材',createdAt:'2026-09-08T13:01:30Z',metadata:{nativeResult:{terminalSessionId:'terminal',state:'running'}}},
 {id:'permission',name:'configure_mcp_server',state:'awaiting_permission',summary:'配置 Blender MCP',createdAt:'2026-09-08T13:01:31Z',metadata:{}},
 {id:'verify',name:'terminal_exec',state:'running',summary:'检查已下载文件',createdAt:'2026-09-08T13:01:32Z',metadata:{}}
];
window.renderFixture = active => root.render(<div className="app theme-cyberpunk" style={{minWidth:0,width:'100%'}}><main style={{padding:32,width:'100%',maxWidth:760,boxSizing:'border-box'}}>
 <div className="assistant-run-header"><span className="assistant-run-label">{active?'处理中 12m 5s':'已处理 12m 5s'}</span><div className="assistant-run-divider"/>
 {active && <AssistantActivityDetails executions={executions} language="zh"/>}</div>
 <McpActivationStatus target={target} isActive={active} language="zh"/>
 </main></div>);
window.unmountFixture = () => root.unmount();
window.renderFixture(true);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'run-status-fixture',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('__run_status_fixture__.tsx')) return '\0run-status-fixture.tsx';
      if (id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0run-status-runtime';
    },
    load(id) {
      if (id === '\0run-status-fixture.tsx') return source;
      if (id === '\0run-status-runtime') return `export function createDesktopRuntimeSession(){return {dispose(){},client:{getMcpSnapshot(signal){window.checks++; signal.addEventListener('abort',()=>window.aborts++,{once:true}); return Promise.resolve(window.fixtureSnapshot());}}};}`;
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false,
    lib: { entry: resolve('__run_status_fixture__.tsx'), formats: ['iife'], name: 'RunStatusFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-run-status-ui-worker.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 25_000,
  });
  assert.equal(run.status, 0, String(run.error ?? 'UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'run-status-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
