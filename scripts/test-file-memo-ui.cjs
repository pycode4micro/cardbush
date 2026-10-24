const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-memo-ui-'));
  const html = path.join(dir, 'index.html'); fs.writeFileSync(html, '<div id="root"></div>');
  const imagePath = path.join(dir, 'image.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const window = new BrowserWindow({ show: false, width: 700, height: 450, webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  let navigations = 0;
  try {
    await window.loadFile(html); window.webContents.on('will-navigate', () => { navigations++; });
    const initialUrl = window.webContents.getURL();
    const sources = Object.fromEntries([
      ['memo', 'src/features/chatMessages/FileMemoReference.tsx'], ['link', 'src/features/chatMessages/LocalFileReferenceLink.tsx'], ['paths', 'src/shared/localPaths.ts'],
      ['memoScope', 'src/features/chatMessages/FileMemoScope.tsx'],
      ['memoProtocol', 'packages/bush-protocol/src/fileMemo.ts'], ['messageImages', 'src/features/chatMessages/MessageImageGalleryFrame.tsx'],
      ['presentation', 'src/features/chatMessages/mediaPresentation.tsx'], ['scope', 'src/features/conversationScope.ts'], ['workspace', 'src/features/conversationWorkspace.ts'],
    ].map(([name, file]) => [name, compile(file)]));
    const run = code => window.webContents.executeJavaScript(code, true);
    await run(`
      const React = require(${JSON.stringify(require.resolve('react'))});
      const {createRoot} = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const originalRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const sources = ${JSON.stringify(sources)}, modules = {};
      window.opens = []; window.errors = []; window.menus = [];
      const conversationHost = {ConversationHostContext:React.createContext(null)}, imageGallery = {ImageGalleryContext:React.createContext(null)};
      function loadModule(name) {
        if (modules[name]) return modules[name].exports;
        const module = modules[name] = {exports:{}};
        new Function('require','module','exports',sources[name])(id => {
          if(id==='@cardbush/bush-protocol')return loadModule('memoProtocol');
          if(id.endsWith('.css'))return {};
          if(id.endsWith('/conversationHost'))return conversationHost;
          if(id==='./ConversationFileReference')return {ConversationFileReference:()=>{throw Error('Unexpected remote host');}};
          if(id==='./InlineMedia')return {};
          if(id==='./MessageImageGalleryFrame')return loadModule('messageImages');
          if(id==='./ImageGalleryContext')return imageGallery;
          if(id==='./imageGallery')return {isGalleryImage:()=>true,galleryImage:p=>({path:p})};
          if(id==='./ImagePreviewDialog')return {ImagePreviewDialog:props=>React.createElement('button',{'data-testid':'image-viewer',onClick:props.onClose},'Close image viewer')};
          if(id.endsWith('/windowScrollDiagnostics'))return {recordWindowScrollDiagnostic:()=>{}};
          if(id.endsWith('/localPaths'))return loadModule('paths');
          if(id==='./LocalFileReferenceLink')return loadModule('link');
          // This fixture exercises image references; HTML uses the real webview suite.
          if(id==='./InlineHtmlPreview')return {isHtmlPreviewPath:()=>false,InlineHtmlPreview:()=>{throw Error('Unexpected HTML in the image fixture');}};
          if(id==='./mediaPresentation')return loadModule('presentation');
          if(id==='./FileMemoScope')return loadModule('memoScope');
          if(id.endsWith('/conversationScope'))return loadModule('scope');
          if(id==='./conversationWorkspace')return loadModule('workspace');
          if(id==='./FileTypeIcon')return {FileTypeIcon:()=>null};
          if(id.endsWith('/fileMemo'))return {fetchFileMemo:()=>{throw Error('Unexpected live IPC');}};
          if(id.endsWith('/fileContextMenu'))return {openFileContextMenu:(event,p)=>{event.preventDefault();window.menus.push(p);}};
          if(id.endsWith('/showUiError'))return {showUiError:async(...args)=>window.errors.push(args)};
          if(id.endsWith('/inspectorEvents'))return {openInspector:p=>window.opens.push(p)};
          return originalRequire(id);
        },module,module.exports);
        return module.exports;
      }
      const Component = loadModule('memo').FileMemoReference;
      const filePath = ${JSON.stringify(imagePath)};
      const result = status => ({status,memo:{protocol:'bush.file_memo.v1',id:'file_'+ '0'.repeat(32),reference:'ref',
        file:{path:filePath,name:'image.png',size:1,mtimeMs:1},note:{purpose:'Model observation',points:[]}}});
      window.state = 'available'; window.lookups=[]; let releaseSlow;
      const load = async (ref, signal, scope) => {window.lookups.push({ref,...scope});if(ref==='slow')await new Promise(resolve=>{releaseSlow=resolve;});if(window.state==='error')throw Error('RuntimeRemoteError: internal message');if(window.state==='unresolved')return {status:'unresolved',reason:'reference_not_found'};return result(window.state);};
      function Harness(){ const [props,setProps]=React.useState({reference:'cardbush-memo:1',inline:true,children:'打开或下载 image.png',sessionId:'session-a',turnId:'turn-a'}); window.setProps=setProps;
        return React.createElement(loadModule('memoScope').FileMemoScope,{sessionId:props.sessionId,turnId:props.turnId},React.createElement(Component,{...props,load})); }
      createRoot(document.getElementById('root')).render(React.createElement(Harness));
      window.releaseSlow=()=>releaseSlow?.();
      undefined;
    `);
    await pause();
    assert.equal(await run('Boolean(document.querySelector("img"))'), true);
    assert.deepEqual(await run('lookups[0]'), {ref:'cardbush-memo:1',sessionId:'session-a',turnId:'turn-a',fileName:undefined});
    const lookupCount = await run('lookups.length');
    await run('setProps(p=>({...p,children:"查看图片"}))'); await pause();
    assert.equal(await run('lookups.length'), lookupCount, 'changing a caption does not reload a short memo identity');
    assert.equal(await run('document.querySelector("img").alt'), '查看图片');
    await run('document.querySelector("img").click()');
    assert.equal(await run('opens.length'), 1);
    await run('document.querySelector("img").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    assert.equal(await run('menus.length'), 1);
    await run('state="changed";window.dispatchEvent(new Event("focus"))'); await pause();
    assert.equal(await run('Boolean(document.querySelector("img"))'), false);
    assert.match(await run('document.body.textContent'), /文件已变化/);
    await run('document.querySelector("a").click()');
    await pause();
    assert.equal(await run('Boolean(document.querySelector("[data-testid=image-viewer]"))'), true, 'changed image opens its current viewer');
    await run('state="unavailable";window.dispatchEvent(new Event("focus"))'); await pause();
    assert.match(await run('document.body.textContent'), /文件不可访问/);
    assert.equal(await run('Boolean(document.querySelector("a"))'), false);
    await run('state="error";window.dispatchEvent(new Event("focus"))'); await pause();
    assert.match(await run('document.body.textContent'), /暂时无法读取/);
    assert.doesNotMatch(await run('document.body.textContent'), /RuntimeRemoteError|internal message/);
    await run('state="available"');
    await run('document.querySelector("button").click()');
    await pause();
    assert.equal(await run('errors.length'), 0, 'retry never opens a native error dialog');
    assert.equal(await run('Boolean(document.querySelector("img"))'), true, 'retry restores the file in place');
    await run('state="unresolved";window.dispatchEvent(new Event("focus"))'); await pause();
    assert.match(await run('document.body.textContent'), /链接未找到对应文件记录/);
    await run('setProps({reference:"image",inline:true,children:"image.png",language:"en",sessionId:"session-b",turnId:"turn-b"})'); await pause();
    assert.match(await run('document.body.textContent'), /No file record matches/);
    assert.equal(await run('lookups.at(-1).sessionId'), 'session-b', 'same reference reloads against the originating message scope');
    await run('state="available";setProps({reference:"slow",inline:true,children:"Slow image"})'); await pause();
    await run('setProps({reference:"fast",inline:true,children:"Fast image"})'); await pause();
    await run('releaseSlow()'); await pause();
    assert.equal(await run('document.querySelector("img").alt'), 'Fast image');
    await run('document.querySelector("img").dispatchEvent(new Event("error"))'); await pause();
    assert.match(await run('document.body.textContent'), /无法预览/);
    assert.equal(await run('Boolean(document.querySelector("a"))'), true);
    assert.equal(window.webContents.getURL(), initialUrl);
    assert.equal(navigations, 0);
    console.log('File memo UI passed: inline media, existing inspector, context menu, changed/missing/error states, focus refresh, stale response rejection, zero navigation/reload.');
  } finally {
    window.destroy(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, {recursive:true,force:true});
  }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
