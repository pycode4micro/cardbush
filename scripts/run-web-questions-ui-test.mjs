import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'web-questions-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
try {
  await writeFile(join(directory, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Solutions} from '${local('web/AgentWidgets.tsx')}';
import {useConversationSolutions} from '${local('web/useConversationSolutions.ts')}';
window.calls=[];window.questions=[];window.fail=false;
window.fetch=async(url,options={})=>{
 window.calls.push({url:String(url),body:options.body});
 if(window.fail)throw Error('offline');
 if(options.method==='POST'){window.answer=JSON.parse(options.body);window.questions=[];}
 return new Response(JSON.stringify(String(url).includes('/two/')?[]:window.questions));
};
function Fixture(){const[id,setId]=useState('one');window.switchSession=setId;const q=useConversationSolutions(id);return <><Solutions items={q.items??[]} refresh={q.refresh}/><span id="unavailable">{String(q.unavailable)}</span></>}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  const bundle = await build({ configFile: false, logLevel: 'warn', base: './', build: { outDir: directory, emptyOutDir: false, rollupOptions: { input: join(directory, 'entry.tsx') } } });
  const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(item => item.output);
  const entry = files.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head>${files.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = spawnSync(createRequire(import.meta.url)('electron'), ['scripts/test-web-questions-ui.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 45000 });
  assert.equal(result.status, 0, String(result.error ?? 'Questions UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'web-questions-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
