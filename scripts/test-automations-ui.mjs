import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'automations-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {AutomationPanel} from '${local('src/features/automations/AutomationPanel.tsx')}';
import '${local('src/styles/app.css')}'; import '${local('src/styles/themes/cyberpunk.css')}';
window.listeners=new Set(); window.calls=[]; window.opened=[]; window.failSave=false;
window.state={available:true,jobs:[],sessions:[{id:'session',title:'构建与导出检查',model:'Fixture'}]};
window.notify=()=>{for(const listener of listeners)listener()};
window.cardbushDesktop={onAutomationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},automationCommand:async command=>{
 calls.push(command); if(command.action==='list')return structuredClone(state);
 if(failSave)throw Error('Automation changed. Refresh before saving.');
 let job=state.jobs.find(job=>job.id===command.id);
 if(command.action==='create'){job={...command.definition,id:'job-'+state.jobs.length,revision:1,state:'active',createdAt:new Date().toISOString(),runs:[]};state.jobs.push(job);}
 else if(command.action==='update')Object.assign(job,command.definition,{revision:job.revision+1});
 else if(command.action==='pause')job.state='paused'; else if(command.action==='resume')job.state='active';
 else if(command.action==='run')job.runs.push({id:'run',turnId:'turn',queuedAt:new Date().toISOString(),status:'running',reason:'manual'});
 else if(command.action==='stop'){job.state='paused';job.runs.at(-1).status='stopped';}
 else if(command.action==='delete')state.jobs=state.jobs.filter(job=>job.id!==command.id);
 notify();return structuredClone(job);
}};
createRoot(document.getElementById('root')).render(<div className="app theme-cyberpunk" style={{minWidth:0,width:'100%',height:'100vh',overflow:'auto'}}><AutomationPanel language="zh" onOpenConversation={id=>opened.push(id)}/></div>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'automation-fixture', resolveId(id) { if (id.endsWith('__automation_fixture__.tsx')) return '\0automation-fixture.tsx'; },
    load(id) { if (id === '\0automation-fixture.tsx') return source; },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__automation_fixture__.tsx'), formats: ['iife'], name: 'AutomationFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-automations-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  assert.equal(run.status, 0, String(run.error ?? 'Automation UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'automations-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
