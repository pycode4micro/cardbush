const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
  try {
    await window.loadURL('data:text/html,<div id="root"></div>');
    for (const file of ['theme.css', 'app.css', 'themes/cyberpunk.css']) {
      await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles', file), 'utf8'));
    }
    const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/features/chatMessages/ImagePreviewDialog.tsx'), 'utf8'), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const run = code => window.webContents.executeJavaScript(code, true);
    await run(`
      const React=require(${JSON.stringify(require.resolve('react'))});
      const {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))});
      const sourceRequire=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const module={exports:{}};
      new Function('require','module','exports',${JSON.stringify(code)})(sourceRequire,module,module.exports);
      const {ImagePreviewDialog}=module.exports; const h=React.createElement;
      const image={src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#238797"/></svg>'),name:'很长的图片文件名'.repeat(20)+'.png'};
      window.closeCount=0;
      function Harness(){
        const [open,setOpen]=React.useState(false),[theme,setTheme]=React.useState('theme-dark');
        window.controls={setOpen,setTheme};
        const close=React.useCallback(()=>{window.closeCount++;setOpen(false);},[]);
        return h('div',{className:'app '+theme},h('div',{className:'message-list-item',style:{height:100,overflow:'hidden',contain:'strict',transform:'translateY(80px)'}},
          open&&h(ImagePreviewDialog,{image,language:'zh',onClose:close})));
      }
      createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Harness)));
    `);
    await pause();
    const inspect = () => run(`(()=>{
      const button=document.querySelector('.image-preview-close'),r=button.getBoundingClientRect();
      const dialog=document.querySelector('.image-preview-dialog'),app=document.querySelector('.app');
      const c=getComputedStyle(button),d=getComputedStyle(dialog);
      return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,
        inViewport:r.x>=0&&r.y>=32&&r.right<=innerWidth&&r.bottom<=innerHeight,
        reachable:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),
        themeColor:c.color,expectedColor:getComputedStyle(app).color,background:d.backgroundColor,
        inApp:document.querySelector('.image-preview-backdrop').parentElement===app,
        outsideMessage:!dialog.closest('.message-list-item')};
    })()`);
    for (const theme of ['theme-dark', 'theme-cyberpunk', 'theme-bright', '']) {
      await run(`controls.setTheme(${JSON.stringify(theme)});controls.setOpen(true)`); await pause();
      for (const [width,height] of [[1200,800],[420,340]]) {
        window.setContentSize(width,height); await pause();
        const state=await inspect();
        assert.equal(state.inApp,true); assert.equal(state.outsideMessage,true);
        assert.equal(state.inViewport,true,JSON.stringify(state));
        assert.equal(state.reachable,true,'close button is not clipped/covered: '+theme);
        assert.equal(state.width,30); assert.equal(state.height,30);
        assert.equal(state.themeColor,state.expectedColor,'button inherits current theme');
        assert.notEqual(state.background,'rgba(0, 0, 0, 0)','dialog is not transparent');
        if(theme==='theme-dark'||theme==='theme-cyberpunk') assert.notEqual(state.themeColor,'rgb(0, 0, 0)');
      }
      await run(`for(let i=0;i<20;i++) document.querySelector('[aria-label="放大图片"]').click()`); await pause();
      const state=await inspect(); assert.ok(state.inViewport&&state.reachable,'500% zoom retains close control');
      const before=await run('closeCount');
      window.webContents.sendInputEvent({type:'mouseDown',x:Math.round(state.x),y:Math.round(state.y),button:'left',clickCount:1});
      window.webContents.sendInputEvent({type:'mouseUp',x:Math.round(state.x),y:Math.round(state.y),button:'left',clickCount:1});
      await pause();
      assert.equal(await run('Boolean(document.querySelector(".image-preview-dialog"))'),false);
      assert.equal(await run('closeCount'),before+1,'native close click executes once');
    }
    await run('controls.setTheme("theme-cyberpunk");controls.setOpen(true)'); await pause();
    window.setContentSize(1200,800); await pause();
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
    fs.writeFileSync(path.join(root,'tmp/image-preview-controls.png'),(await window.webContents.capturePage()).toPNG());
    await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'); await pause();
    assert.equal(await run('Boolean(document.querySelector(".image-preview-dialog"))'),false,'Escape closes');
    await run('controls.setOpen(true)'); await pause();
    await run('document.querySelector(".image-preview-backdrop").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))'); await pause();
    assert.equal(await run('Boolean(document.querySelector(".image-preview-dialog"))'),false,'backdrop closes');
    console.log('Image preview passed: four live themes, long names, small/large windows, containment escape, 500% zoom, visible native close click, Escape and backdrop.');
  } finally { window.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
