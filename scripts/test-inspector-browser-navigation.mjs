import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'inspector-browser-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { InspectorWebview } from '${local('src/features/inspector/InspectorWebview.tsx')}';
import { InspectorTabPages } from '${local('src/features/inspector/InspectorTabPages.tsx')}';
import { addPanel, panelRects, resizePanelSplit, swapPanels } from '${local('src/features/inspector/panelLayout.ts')}';
import { InspectorTileFrame } from '${local('src/features/inspector/InspectorTileFrame.tsx')}';
import { useInspectorTabs } from '${local('src/hooks/useInspectorTabs.ts')}';
import { BrowserStartPageSettings } from '${local('src/features/browser/BrowserSettingsPanel.tsx')}';
import { newBrowserTab } from '${local('src/features/browser/browserStartPage.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.openedLinks=[];
function Harness() {
  const tabs=useInspectorTabs(), refs=React.useRef({});
  const [navigation,setNavigation]=React.useState({});
  const [settings,setSettings]=React.useState(false);
  const [layout,setLayout]=React.useState(null);
  const [covered,setCovered]=React.useState(false);
  const open=React.useCallback(detail=>{
    window.openedLinks.push(detail.target);
    tabs.openTab({id:detail.newTab ? crypto.randomUUID() : detail.target,kind:'resource',detail});
  },[tabs.openTab]);
  const update=React.useCallback((id,state)=>setNavigation(current=>({...current,[id]:state})),[]);
  window.browserFixture={...tabs,open,navigation,layout,setLayout,addPanel,resizePanelSplit,swapPanels,setCovered};
  const active=navigation[tabs.activeId];
  return <div className="app theme-bright" style={{height:'100vh','--window-frame-height':'0px'}}>
    <main className={'desktop-shell sidebar-is-collapsed'+(covered?' inspector-covered':'')} style={{'--conversation-pane-min-width':'0px'}}>
    <section className="main-stage"/>
    <aside className="right-inspector" style={{'--right-inspector-width':'820px'}}>
    <div className="right-inspector-viewport"><div className="right-inspector-content">
      <header>{tabs.tabs.map(tab=><button key={tab.id} data-tab={tab.id} onClick={()=>tabs.activateTab(tab.id)}>{navigation[tab.id]?.title||tab.id}</button>)}</header>
      <nav><button id="new-tab" onClick={async()=>{setSettings(false);open(await newBrowserTab());}}>新标签页</button>
      <button id="browser-settings" onClick={()=>setSettings(value=>!value)}>浏览器设置</button>
      <button id="back" disabled={!active?.canGoBack} onClick={()=>refs.current[tabs.activeId]?.goBack()}>后退</button>
      <button id="forward" disabled={!active?.canGoForward} onClick={()=>refs.current[tabs.activeId]?.goForward()}>前进</button>
      <button id="external" onClick={()=>window.cardbushDesktop.openExternal(active?.url||tabs.tabs.find(tab=>tab.id===tabs.activeId)?.detail.target)}>外部打开</button>
      <output id="address">{active?.url}</output></nav>
      {settings && <div className="settings-stack" style={{padding:24}}><BrowserStartPageSettings language="zh"/></div>}
      <div className="right-inspector-body" style={{display:settings?'none':undefined}}><InspectorTabPages tabs={tabs.tabs} activeId={tabs.activeId} layout={layout} language="zh"
        onActivate={tabs.activateTab}
        onResize={(path,ratio)=>setLayout(current=>resizePanelSplit(current,path,ratio))}
        renderFrame={tab=><InspectorTileFrame tab={tab} language="zh" navigation={navigation[tab.id]} handle={refs.current[tab.id]} onSwap={(from,x,y)=>{
          const bounds=document.querySelector('.right-inspector-tab-pages').getBoundingClientRect();
          const px=(x-bounds.left)/bounds.width,py=(y-bounds.top)/bounds.height;
          const to=Object.entries(panelRects(layout)).find(([id,r])=>id!==from&&px>=r.x&&px<=r.x+r.width&&py>=r.y&&py<=r.y+r.height)?.[0];
          if(to)setLayout(current=>swapPanels(current,from,to));
        }}/>}>{tab=>
        <InspectorWebview ref={value=>{refs.current[tab.id]=value;}} identity={tab.id} target={tab.detail.target} source={tab.detail.target}
          language="zh" onOpenTarget={open} onNavigationStateChange={update} onActivate={id=>{if(layout)tabs.activateTab(id);}}/>
      }</InspectorTabPages></div>
    </div></div>
    </aside>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{
    name: 'inspector-browser-fixture', enforce: 'pre',
    resolveId(id) { if (id.endsWith('__inspector_browser__.tsx')) return '\0inspector-browser.tsx'; },
    load(id) { if (id === '\0inspector-browser.tsx') return source; },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__inspector_browser__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  assert.ok(entry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-inspector-browser-navigation.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 45_000 });
  assert.equal(run.status, 0, String(run.error ?? 'Browser navigation regression failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'inspector-browser-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
