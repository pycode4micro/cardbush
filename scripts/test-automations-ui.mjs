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
import {AutomationCalendar} from '${local('src/features/automations/AutomationCalendar.tsx')}';
import {themeClassNames} from '${local('src/features/appearance/themeRuntime.ts')}';
import chinaCalendar from '${local('assets/calendars/china.json')}';
import usCalendar from '${local('assets/calendars/us.json')}';
import {importedThemeStyleVariables} from '${local('src/features/appearance/importedThemeStyle.ts')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}'; import '${local('src/styles/appearance.css')}';
window.listeners=new Set(); window.calls=[];
window.runtimeStatus={phase:'ready',attempt:1,startedAt:''};window.runtimeListeners=new Set();window.emitRuntime=phase=>{runtimeStatus={...runtimeStatus,phase};for(const listener of runtimeListeners)listener(runtimeStatus)};
window.failList=false;window.failCalendars=false;
window.pickerThemeTokens=[];window.pickerTheme=theme=>{const app=document.querySelector('.app');for(const token of pickerThemeTokens)app.style.removeProperty(token);app.className='app '+themeClassNames(theme==='custom'?'dark':theme);pickerThemeTokens=[];if(theme==='custom'){const tokens=importedThemeStyleVariables({protocol:'cardbush.appearance_style.v1',name:'测试导入配色',base:'dark',colors:{surface:'#201b2c',surfaceRaised:'#31273f',border:'#675679',text:'#f3eafc',textMuted:'#cec1db',accent:'#d2a9f4'}});for(const [token,value]of Object.entries(tokens))app.style.setProperty(token,value);pickerThemeTokens=Object.keys(tokens)}};
window.state={available:true,jobs:[],sessions:[{id:'session',title:'构建与导出检查',model:'Fixture'}]};
window.notify=()=>{for(const listener of listeners)listener()};
window.calendarState={datasets:[chinaCalendar,usCalendar].map(calendar=>({calendar,enabled:false,builtin:true})),chineseLunar:false};window.calendarCalls=[];window.calendarListeners=new Set();window.importCalendar=undefined;
window.cardbushDesktop={runtimeStartupStatus:async()=>runtimeStatus,onRuntimeStartupStatus:fn=>{runtimeListeners.add(fn);return()=>runtimeListeners.delete(fn)},onCalendarChanged:fn=>{calendarListeners.add(fn);return()=>calendarListeners.delete(fn)},calendarCommand:async command=>{
 if(failCalendars)throw Error('Fixture calendar source unavailable');
 calendarCalls.push(command);if(command.action==='import'&&importCalendar){calendarState.datasets=calendarState.datasets.filter(item=>item.calendar.id!==importCalendar.id);calendarState.datasets.push({calendar:structuredClone(importCalendar),enabled:true})}
 if(command.action==='lunar')calendarState.chineseLunar=command.enabled;
 if(command.action==='enabled')calendarState.datasets.find(item=>item.calendar.id===command.id).enabled=command.enabled;
 calendarState.chineseLunar=calendarState.datasets.find(item=>item.calendar.id==='cardbush.chinese').enabled;
 if(command.action==='remove')calendarState.datasets=calendarState.datasets.filter(item=>item.calendar.id!==command.id);
 return {state:structuredClone(calendarState),...(command.action==='import'&&importCalendar?{imported:importCalendar.name}:{})};
},onAutomationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},automationCommand:async command=>{
 calls.push(command); if(command.action==='list'){if(failList)throw Error('Fixture Runtime unavailable');return structuredClone(state);}
 throw Error('Unexpected scheduler mutation from the event calendar');
}};
const root=createRoot(document.getElementById('root'));
window.renderCalendarWidgets=(language='zh',count=1)=>root.render(<div className="app theme-dark" style={{display:'flex',minWidth:0,width:'100%',height:'100vh',overflow:'hidden'}}>{Array.from({length:count},(_,i)=><div className="widget-fixture" key={i} style={{width:300,height:310,overflow:'hidden',margin:20,flex:'none'}}><AutomationCalendar language={language}/></div>)}</div>);
window.renderCalendarWidgets("zh", 0);
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
  const run = spawnSync(require('electron'), ['scripts/test-automations-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(run.status, 0, String(run.error ?? 'Automation UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'automations-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
