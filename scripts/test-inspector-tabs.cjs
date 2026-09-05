// Isolated Chromium regression test: no product profile, network or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compile = (file) => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pause = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (/passive event listener|ResizeObserver loop|Maximum update depth/.test(event.message)) errors.push(event.message);
  });
  try {
    await window.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8'));
    await window.webContents.executeJavaScript(`
      const React = require(${JSON.stringify(require.resolve('react'))});
      const {createRoot} = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const {createPortal} = require(${JSON.stringify(require.resolve('react-dom'))});
      const sourceRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const load = source => { const module = {exports:{}}; new Function('require','module','exports',source)(sourceRequire,module,module.exports); return module.exports; };
      const {useInspectorTabStrip} = load(${JSON.stringify(compile('src/hooks/useInspectorTabStrip.ts'))});
      const {useSoftPanelPresence} = load(${JSON.stringify(compile('src/hooks/useSoftPanelPresence.ts'))});
      const h = React.createElement;
      function Harness() {
        const [open,setOpen] = React.useState(false);
        const [count,setCount] = React.useState(12);
        const [active,setActive] = React.useState('11');
        const [width,setWidth] = React.useState(420);
        const presence = useSoftPanelPresence(open);
        const strip = useInspectorTabStrip(active,count);
        window.controls = {setOpen,setCount,setActive,setWidth,state:strip.state};
        return h('div',{className:'app',style:{height:'100vh'}}, presence.mounted && h('aside',{
          className:'right-inspector', style:{position:'absolute',left:650,top:50,width,overflow:'hidden',transform:'translateX(0)'}
        },h('div',{className:'right-inspector-tab-strip',style:{width}},
          strip.state.overflow && h('button',{className:'right-inspector-tab-scroll'},'<'),
          h('div',{className:'right-inspector-tabs',ref:strip.ref}, Array.from({length:count},(_,i)=>h('div',{
            key:i,'data-inspector-tab-id':String(i),style:{flex:'0 0 120px',height:40}
          },'Tab '+i))),
          strip.state.overflow && h('button',{className:'right-inspector-tab-scroll'},'>')
        ), createPortal(h('div',{className:'right-inspector-tab-context-menu',style:{left:720,top:85}},'Menu'),document.querySelector('.app') ?? document.body)));
      }
      createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Harness)));
    `);
    const run = (code) => window.webContents.executeJavaScript(code);
    await pause();
    await run('controls.setOpen(true)');
    await pause(400);
    const snapshot = () => run(`(()=>{
      const strip=document.querySelector('.right-inspector-tabs');
      const active=strip.querySelector('[data-inspector-tab-id="'+Array.from(strip.children).at(-1).dataset.inspectorTabId+'"]');
      const v=strip.getBoundingClientRect(), a=active.getBoundingClientRect();
      return {state:controls.state, left:strip.scrollLeft, activeVisible:a.left>=v.left-1&&a.right<=v.right+1};
    })()`);
    assert.equal((await snapshot()).state.overflow, true, 'first delayed mount measures overflow');
    assert.equal((await snapshot()).activeVisible, true, 'first delayed mount reveals active tab');
    const menu = await run(`(()=>{const r=document.querySelector('.right-inspector-tab-context-menu').getBoundingClientRect();return {x:r.x,y:r.y,visible:document.elementFromPoint(r.x+3,r.y+3)?.className};})()`);
    assert.equal(menu.x,720); assert.equal(menu.y,85);
    assert.equal(menu.visible,'right-inspector-tab-context-menu','portal is not clipped by transformed inspector');
    await run("document.querySelector('.right-inspector-tabs').scrollLeft=0");
    const wheel = await run(`(()=>{const el=document.querySelector('.right-inspector-tabs');const e=new WheelEvent('wheel',{deltaY:70,bubbles:true,cancelable:true});el.dispatchEvent(e);return {cancelled:e.defaultPrevented,left:el.scrollLeft};})()`);
    assert.deepEqual(wheel,{cancelled:true,left:70},'wheel scrolls exactly once and cancels default');
    assert.equal(await run(`(()=>{const e=new WheelEvent('wheel',{deltaY:70,ctrlKey:true,bubbles:true,cancelable:true});document.querySelector('.right-inspector-tabs').dispatchEvent(e);return e.defaultPrevented;})()`),false,'Ctrl wheel remains available for zoom');
    await run('controls.setOpen(false)'); await pause(400);
    await run('controls.setOpen(true)'); await pause(400);
    const reopened = await snapshot();
    assert.equal(reopened.activeVisible,true,'reopen reattaches and reveals retained active tab: '+JSON.stringify(reopened));
    await run('controls.setCount(13);controls.setActive("12")'); await pause();
    assert.equal((await snapshot()).activeVisible,true,'new active tab becomes visible');
    await run('controls.setCount(3);controls.setActive("2");controls.setWidth(350)'); await pause();
    assert.equal((await snapshot()).state.overflow,true);
    await run('controls.setWidth(390)'); await pause();
    assert.equal((await snapshot()).state.overflow,false,'arrows disappear even when their old slots would cause overflow');
    assert.equal(await run('document.documentElement.scrollLeft'),0,'tab reveal never scrolls app ancestors');
    assert.deepEqual(errors,[]);
    console.log('Inspector behavior: delayed mount, reopen, active reveal, portal, wheel, zoom, resize and ancestor isolation passed.');
  } finally { window.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
