import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'mcp-apps-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const html = `<h1>Interactive fixture</h1><div id="state">Starting</div><script>
let seq=0;const pending=new Map();
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
const report=(key,value)=>parent.postMessage({fixtureReport:key,value},'*');
addEventListener('message',async e=>{if(e.source!==parent)return;const d=e.data;const p=pending.get(d.id);if(p){pending.delete(d.id);d.error?p.reject(Error(d.error.message)):p.resolve(d.result)}
if(d.method==='ui/notifications/tool-result'){document.getElementById('state').textContent='Ready';report('result',d.params);}
if(d.fixture==='call'){try{const result=await rpc('tools/call',{name:'save',arguments:{value:42}});report('called',result)}catch(error){report('denied',error.message)}}
if(d.fixture==='legacy'){report('legacy',await window.openai.callTool('save',{value:43}));await window.openai.setWidgetState({page:2});}
if(d.fixture==='message'){await window.openai.sendFollowUpMessage({prompt:'Continue fixture'});report('message',true)}
if(d.fixture==='navigate'){location.href='https://example.invalid/escape'}
if(d.fixture==='blank'){location.href='about:blank'}
});
(async()=>{await rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{}});parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
try{parent.document.body;report('escaped',true)}catch{report('isolated',true)}
try{await fetch('https://example.invalid/blocked');report('networkAllowed',true)}catch{report('networkBlocked',true)}
})();</script>`;
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{McpAppPanel}from'${local('src/features/tools/McpAppPanel.tsx')}';
window.fixtureReports={};window.operations=[];window.awaiting=null;window.saved=0;window.context=null;
addEventListener('message',e=>{if(e.data?.fixtureReport)fixtureReports[e.data.fixtureReport]=e.data.value});
addEventListener('cardbush:mcp-app-message',e=>{window.followup=e.detail.text;e.detail.resolve()});
window.cardbushDesktop={openExternal:async()=>{}};
const view={token:'opaque-host-token',html:${JSON.stringify(html)},meta:{},tool:{name:'save',inputSchema:{type:'object'}},input:{original:true},result:{content:[],structuredContent:{value:1},_meta:{uiOnly:true}}};
window.fixtureCommand=async input=>{operations.push(input);if(input.action==='open')return view;if(input.action==='status')return{permission:awaiting?{permissionId:'p',reason:'Confirm fixture change',targets:[{value:'demo'}],capabilityIds:['write']}:null};if(input.action==='call')return new Promise((resolve,reject)=>{awaiting={resolve,reject}});if(input.action==='answer'){const p=awaiting;awaiting=null;if(input.decision==='deny')p.reject(Error('User denied'));else{saved++;p.resolve({content:[],structuredContent:{saved}})}return{}};if(input.action==='context'){window.context=input.context;return{}};if(input.action==='close'){awaiting?.reject(Error('Closed'));awaiting=null;return{}};throw Error(input.action)};
createRoot(document.getElementById('root')).render(<McpAppPanel sessionId="s" turnId="t" toolCallId="tool" language="zh"/>);`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'mcp-app-fixture', enforce: 'pre', resolveId(id, importer) { if (id.endsWith('__mcp_app_fixture__.tsx')) return '\0mcp-app-fixture.tsx'; if (id.includes('runtime-client/ElectronRuntimeSession') && importer?.endsWith('McpAppPanel.tsx')) return '\0runtime-fixture'; },
    load(id) { if (id === '\0mcp-app-fixture.tsx') return source; if (id === '\0runtime-fixture') return 'export function createDesktopRuntimeSession(){return{dispose(){},client:{command:async({payload},decode)=>decode(await window.fixtureCommand(payload))}}}'; },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__mcp_app_fixture__.tsx'), formats: ['iife'], name: 'McpAppFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output), entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item => item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-mcp-apps-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  assert.equal(run.status, 0, String(run.error ?? 'MCP App UI fixture failed'));
} finally { assert.ok(directory.startsWith(parent + sep + 'mcp-apps-ui-')); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
