import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'native-team-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TeamWorkspace } from '${local('src/features/team/TeamWorkspace.tsx')}';
import { MdPresentationApp } from '${local('src/features/mdPresentation/MdPresentationApp.tsx')}';
import { BushItSidebar } from '${local('src/features/mdPresentation/BushItSidebar.tsx')}';
import * as pages from '${local('src/features/mdPresentation/bushItPageStore.ts')}';
import { useTeamWorkspace } from '${local('src/features/team/teamWorkspaceStore.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.pages=pages; window.records = { agents: [], teams: [], runs: [] }; window.calls = [];
window.fileResult=null; window.fileCalls=[]; window.cardbushDesktop={markdownFile:async input=>{fileCalls.push(input);if(input.action==='save')return {path:'D:/workflow.md',text:input.text,revision:'file-v1'};return fileResult;}};
window.command = async ({kind,payload:input}) => {
  window.calls.push({kind, input:structuredClone(input)});
  const list = kind==='runtime.agent_registry' ? records.agents : records.teams;
  if(input.action==='list') return structuredClone(kind==='runtime.agent_registry' ? list : {teams:list,runs:records.runs});
  if(input.action==='save') {
    if(window.deferSave) await new Promise(resolve=>window.finishSave=resolve);
    const prior=list.find(record=>record.definition.id===input.definition.id);
    if((prior?.revision??0)!==input.expected_revision) throw Error('Definition changed. Read its current revision before saving.');
    const receipt={revision:input.expected_revision+1,updatedAt:new Date().toISOString(),definition:structuredClone(input.definition)};
    if(prior) list.splice(list.indexOf(prior),1,receipt); else list.push(receipt);
    return structuredClone(receipt);
  }
  if(input.action==='delete') { const index=list.findIndex(record=>record.definition.id===(input.agent_id||input.team_id)); list.splice(index,1); return {deleted:true}; }
  throw Error('Unexpected command: '+JSON.stringify(input));
};
function Fixture(){ window.teamState=useTeamWorkspace(); window.pageState=pages.useBushItPages(); const [mode,setMode]=React.useState('team'); window.setApp=setMode;
  React.useEffect(()=>{const listener=event=>setMode(event.detail.id==='builtin:md-presentation'?'md':'team');window.addEventListener('cardbush-open-application',listener);return()=>window.removeEventListener('cardbush-open-application',listener);},[]);
  const practice=team=>window.practiced=structuredClone(team);
  return <div className="app theme-dark" style={{display:'flex',height:'100vh',background:'var(--surface)',overflow:'hidden','--sidebar-width':'240px'}}>{mode==='team'?<TeamWorkspace language="zh"/>:<><BushItSidebar language="zh" onBack={()=>setMode('team')}/><MdPresentationApp language="zh" onPractice={practice}/></>}</div>; }
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'native-team-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__native_team_fixture__.tsx')) return '\0native-team-fixture.tsx';
      if (id.includes('ElectronRuntimeSession') && importer?.endsWith('teamWorkspaceStore.ts')) return '\0native-team-transport';
    },
    load(id) {
      if (id === '\0native-team-fixture.tsx') return source;
      if (id === '\0native-team-transport') return 'export const createDesktopRuntimeSession=()=>({client:{command:async(input,decode)=>decode(await window.command(input))},dispose(){}});';
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__native_team_fixture__.tsx'), formats: ['iife'], name: 'NativeTeamFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${styles.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-native-team-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(run.status, 0, String(run.error ?? 'Native Team UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'native-team-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
