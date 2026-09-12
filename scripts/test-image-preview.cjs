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
    const shared = Object.fromEntries(['localPaths', 'showUiError', 'fileContextMenu'].map(name => [name, ts.transpileModule(fs.readFileSync(path.join(root, 'src/shared', name + '.ts'), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText]));
    const run = code => window.webContents.executeJavaScript(code, true);
    await run(`
      const React=require(${JSON.stringify(require.resolve('react'))});
      const {flushSync}=require(${JSON.stringify(require.resolve('react-dom'))});
      const {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))});
      const sourceRequire=require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const sharedSources=${JSON.stringify(shared)},sharedModules={};
      function loadShared(name){if(sharedModules[name])return sharedModules[name].exports;const mod=sharedModules[name]={exports:{}};new Function('require','module','exports',sharedSources[name])(id=>loadShared(id.slice(2)),mod,mod.exports);return mod.exports;}
      const module={exports:{}};
      new Function('require','module','exports',${JSON.stringify(code)})(id=>id==='../../shared/fileContextMenu'?loadShared('fileContextMenu'):sourceRequire(id),module,module.exports);
      const {ImagePreviewDialog}=module.exports; const h=React.createElement;
      const image={src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#238797"/></svg>'),name:'很长的图片文件名'.repeat(20)+'.png',naturalWidth:1600,naturalHeight:900};
      window.closeCount=0;
      function Harness(){
        const [open,setOpen]=React.useState(false),[theme,setTheme]=React.useState('theme-dark'),[currentImage,setImage]=React.useState(image);
        window.controls={setOpen,setTheme,setImage};
        const close=React.useCallback(()=>{window.closeCount++;setOpen(false);},[]);
        return h('div',{className:'app '+theme},h('div',{className:'message-list-item',style:{height:100,overflow:'hidden',contain:'strict',transform:'translateY(80px)'}},
          open&&h(ImagePreviewDialog,{image:currentImage,language:'zh',onClose:close})));
      }
      createRoot(document.getElementById('root')).render(h(React.StrictMode,null,h(Harness)));
    `);
    await pause();
    await run('new Promise((resolve,reject)=>{const thumbnail=new Image();thumbnail.onload=()=>thumbnail.decode().then(resolve,reject);thumbnail.onerror=reject;thumbnail.src=image.src})');
    const sampleOpening = (source, width, height) => run(`new Promise(resolve=>{
      flushSync(()=>{controls.setImage(${source});controls.setOpen(true)});
      const frames=[];
      const sample=()=>{
        const stage=document.querySelector('.image-preview-stage'),canvas=document.querySelector('.image-preview-canvas'),img=canvas.querySelector('img');
        const rect=img.getBoundingClientRect(),fit=Math.min(1,(stage.clientWidth-32)/${width},(stage.clientHeight-32)/${height});
        frames.push({visible:getComputedStyle(canvas).visibility==='visible',width:rect.width,height:rect.height,
          expectedWidth:Math.round(${width}*fit),expectedHeight:Math.round(${height}*fit),busy:stage.getAttribute('aria-busy'),zoom:document.querySelector('.image-preview-zoom-value').textContent});
        if(frames.length<8)requestAnimationFrame(sample);else resolve(frames);
      };sample();
    })`);
    const assertStableFit = frames => {
      assert.ok(frames.some(frame=>frame.visible),'the image becomes visible');
      for(const frame of frames.filter(frame=>frame.visible)){
        assert.ok(Math.abs(frame.width-frame.expectedWidth)<=1&&Math.abs(frame.height-frame.expectedHeight)<=1,'every visible frame is already fitted: '+JSON.stringify(frame));
        assert.equal(frame.busy,'false');assert.equal(frame.zoom,'100%');
      }
    };
    for(let reopen=0;reopen<3;reopen++){
      const frames=await sampleOpening('image',1600,900);
      assertStableFit(frames);assert.equal(frames[0].visible,true,'a decoded thumbnail opens fitted before the first paint');
      await run('flushSync(()=>controls.setOpen(false))');
    }
    await sampleOpening('image',1600,900);
    await run('document.querySelector("[aria-label=放大图片]").click()');await pause();
    const portrait = {src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="2400"><rect width="900" height="2400" fill="#a88037"/></svg>'),name:'portrait.svg'};
    const coldFrames=await sampleOpening(JSON.stringify(portrait),900,2400);
    assertStableFit(coldFrames);
    assert.equal(coldFrames[0].visible,false,'a new unmeasured source cannot flash at the previous image size');
    await run('flushSync(()=>controls.setImage({src:"data:image/png;base64,invalid",name:"missing.png"}))');await pause();
    assert.equal(await run('document.querySelector(".image-preview-status")?.textContent'),'图片无法预览');
    assert.equal(await run('document.querySelector(".image-preview-stage").getAttribute("aria-busy")'),'false','failed images leave the loading state');
    await run('flushSync(()=>{controls.setOpen(false);controls.setImage(image)})');
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
    console.log('Image preview passed: fitted first paint, warm-cache reopens, cold source/zoom reset, error state, four themes, long names, narrow windows, containment escape, 500% zoom, native close, Escape and backdrop.');
  } finally { window.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
