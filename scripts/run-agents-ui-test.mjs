import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'remote-workers-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
try {
  await writeFile(join(directory, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {RemoteWorkers,useWorkerConnections} from '${local('src/features/team/RemoteWorkers.tsx')}';
import '${local('src/styles/theme.css')}';import '${local('src/features/team/team-workspace.css')}';
window.saved=[];window.records=[];window.fail=true;window.calls=[];window.workerProfile='subagent-remote-proton';window.workerVersion='0.1';
window.cardbushDesktop={ssh:{list:async()=>[]},agents:{
 list:async()=>structuredClone(records),save:async input=>{saved.push(input);const item={...input,id:input.id||'worker-'+(records.length+1),hasToken:true};delete item.token;records=records.filter(row=>row.id!==item.id).concat(item);return structuredClone(records)},
 connect:async id=>{calls.push(id);if(fail)throw Error('fixture offline');const info={id:'service-1',capabilities:{delegation:true,workerInteraction:{profile:workerProfile,version:workerVersion}}};records=records.map(row=>row.id===id?{...row,agentId:'service-1',info}:row);return info},
 remove:async id=>{records=records.filter(row=>row.id!==id);return records},call:async()=>{throw Error('Registration must not open a remote chat')}
}};
function Fixture(){const data=useWorkerConnections();const[language,setLanguage]=useState('en');window.setLanguage=setLanguage;return <RemoteWorkers language={language} connections={data.connections} refresh={data.refresh} onRegister={item=>window.registered=item}/>};
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  const result = await build({ configFile: false, logLevel: 'warn', base: './', build: { outDir: directory, emptyOutDir: false, write: true, rollupOptions: { input: join(directory, 'entry.tsx') } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}<style>body{margin:0;padding:16px;background:var(--surface);color:var(--text)}button,input,select{font:inherit}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-agents-ui.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  assert.equal(run.status, 0, String(run.error ?? 'Remote worker UI failed'));
} finally { assert.ok(directory.startsWith(parent + sep + 'remote-workers-ui-')); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); }
