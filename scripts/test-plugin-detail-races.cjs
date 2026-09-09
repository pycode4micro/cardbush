const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const wait=async code=>{for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out '+code);};
 try {
 await win.loadURL('data:text/html,<div id="root"></div>');
 await run(`
 const React=require(${JSON.stringify(require.resolve('react'))});
 const {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))});
 const nativeRequire=require('node:module').createRequire(${JSON.stringify(path.join(root,'package.json'))});
 const h=React.createElement;window.reads=[];window.listeners=new Set();
 window.cardbushDesktop={onCapabilityCatalogChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
 const skills=['alpha','beta'].map(name=>({name,description:name+' summary'}));
 const api={fetchCardbushAppsConfiguration:async()=>({serviceEnabled:true,plugins:[]}),fetchMcpConnectionOverview:async()=>({revision:1,servers:[],snapshot:null})};
 const load=(source)=>{const module={exports:{}};new Function('require','module','exports',source)(name=>{
 if(name.endsWith('.css'))return{};if(name==='../../backend/api')return api;
 if(name==='../../shared/localPaths')return{fileUrl:value=>value};
 if(name==='../skills/SkillIcon')return{SkillIcon:()=>null};
 if(name==='../../hooks/useCapabilityCatalogRefresh')return refresh;
 if(name==='../../backend/mcpConnectionOverview')return mcpOverview;
 if(name==='./pluginConnections')return connections;
 if(name==='./PluginMarketplacePanel')return{PluginMarketplacePanel:()=>null};
 return nativeRequire(name);},module,module.exports);return module.exports;};
 const refresh=load(${JSON.stringify(compile('src/hooks/useCapabilityCatalogRefresh.ts'))});
 const mcpOverview=load(${JSON.stringify(compile('src/backend/mcpConnectionOverview.ts'))});
 const connections=load(${JSON.stringify(compile('src/features/plugins/pluginConnections.ts'))});
 const {PluginManagementPanel}=load(${JSON.stringify(compile('src/features/plugins/PluginManagementPanel.tsx'))});
 const props={language:'en',initialTab:'skills',skills,disabledSkillNames:new Set(),onToggleSkill:()=>{},onReloadSkills:async()=>skills,
 onLoadSkillDetail:name=>new Promise((resolve,reject)=>reads.push({name,resolve,reject})),onOpenMcp:()=>{},onNotify:()=>{}};
 window.openCard=name=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(name+' summary')).click();
 createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(PluginManagementPanel,props)));
 `);
 await wait('document.body.textContent.includes("alpha summary")');
 await run('openCard("alpha")');await wait('reads.some(r=>r.name==="alpha")');
 await run('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")?.includes("Back")||b.textContent.includes("Back")).click()');
 await wait('document.body.textContent.includes("beta summary")');
 await run('openCard("beta")');await wait('reads.some(r=>r.name==="beta")');
 await run('reads.filter(r=>r.name==="beta").forEach(r=>r.resolve({name:"beta",description:"CURRENT B",content:"CURRENT B"}))');
 await wait('document.body.textContent.includes("CURRENT B")');
 await run('reads.filter(r=>r.name==="alpha").forEach(r=>r.resolve({name:"alpha",description:"STALE A",content:"STALE A"}))');
 await new Promise(r=>setTimeout(r,80));
 assert.equal(await run('document.body.textContent.includes("STALE A")'),false,'late first skill must not replace selected detail');
 assert.equal(await run('document.body.textContent.includes("CURRENT B")'),true);
 await run('for(const listener of listeners)listener()');await wait('reads.filter(r=>r.name==="beta").length>=2');
 await run('reads.at(-1).resolve({name:"beta",description:"REFRESHED B",content:"REFRESHED B"})');
 await wait('document.body.textContent.includes("REFRESHED B")');
 await run('for(const listener of listeners)listener()');await wait('reads.filter(r=>r.name==="beta").length>=3');
 await run('reads.at(-1).reject(new Error("Skill file unavailable"))');
 await wait('document.querySelector("[role=alert]")?.textContent.includes("Skill file unavailable")');
 assert.equal(await run('document.body.textContent.includes("REFRESHED B")'),true,'refresh error retains last readable detail');
 console.log('Plugin detail races passed: delayed alpha cannot overwrite beta; live refresh updates selected detail.');
 }finally{win.destroy();}
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
