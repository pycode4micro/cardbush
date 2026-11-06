import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'web-admin-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
try {
  await writeFile(join(directory, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ModelAdmin} from '${local('web/ModelAdmin.tsx')}';
import {OrganizationAdmin} from '${local('web/OrganizationAdmin.tsx')}';
import {WebLanguage} from '${local('web/Language.tsx')}';
import '${local('web/styles.css')}';
localStorage.setItem('cardbush-web-language','en');
window.calls=[];window.failNext=false;
const model={id:'first',name:'<img src=x onerror=alert(1)> — a long model display name',model:'fixture-model',baseURL:'https://provider.example/v1',apiProtocol:'openai_responses',enabled:true,maxContextTokens:530000,maxOutputTokens:128000,reasoningEffort:'medium',hasApiKey:true};
let settings={revision:1,defaultModelId:'first',models:[model],imageModel:{model:'fixture-image',hasApiKey:true}};
window.fetch=async(url,options={})=>{
 const input=options.body?JSON.parse(options.body):null;window.calls.push({url:String(url),input});
 if(window.failNext){window.failNext=false;return new Response(JSON.stringify({error:'fixture conflict'}),{status:409});}
 if(String(url).endsWith('/admin/models')){
  if(input){settings.revision++;if(input.action==='save'){settings.models=settings.models.filter(m=>m.id!==input.model.id).concat({...input.model,hasApiKey:true});delete settings.models.at(-1).apiKey;}if(input.action==='image')settings.imageModel={model:input.model,hasApiKey:true};}
  return new Response(JSON.stringify(settings));
 }
 if(String(url).endsWith('/admin/organization'))return new Response(JSON.stringify({companies:[],departments:[]}));
 if(String(url).includes('/admin/users'))return new Response(JSON.stringify([{id:'alice',username:'alice',display_name:'Alice',role:'admin',is_active:true,department_id:null}]));
 if(String(url).endsWith('/admin/remote-agents'))return new Response(JSON.stringify({revision:1,agents:[]}));
 if(String(url).endsWith('/admin/plugins'))return new Response(JSON.stringify({installed:false,enabled:false,grants:[]}));
 throw Error('Unexpected endpoint: '+url);
};
function Fixture(){const [organization,setOrganization]=useState(false);window.showOrganization=()=>setOrganization(true);return <WebLanguage>{organization?<OrganizationAdmin currentUserId="alice"/>:<ModelAdmin/>}</WebLanguage>}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  const result = await build({ configFile: false, logLevel: 'warn', base: './', build: { outDir: directory, emptyOutDir: false, rollupOptions: { input: join(directory, 'entry.tsx') } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = output.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8">${output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const resultCode = spawnSync(require('electron'), ['scripts/test-web-admin-ui.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(resultCode.status, 0, String(resultCode.error ?? 'Web admin UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'web-admin-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
