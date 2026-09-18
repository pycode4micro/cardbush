const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { windowMenuContext, executeWindowMenuAction } = require('../dist-electron/windowMenu.js');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 50000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const calls = [];
  ipcMain.handle('window:menu-context', event => windowMenuContext(event, win));
  ipcMain.handle('window:menu-action', (event, action, target) => {
    calls.push(action);
    return executeWindowMenuAction(event, win, action, target, () => calls.push('quit-request'));
  });
  const run = code => win.webContents.executeJavaScript(code, true);
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const until = async (code, label = code) => { const end = Date.now() + 4500; while (!await run(code)) {
    if (Date.now() > end) throw Error('Timed out: ' + label + '\n' + JSON.stringify(await run(`({mode:document.querySelector('.window-frame')?.dataset.menuInput,active:document.activeElement?.dataset.menuItem,focused:document.hasFocus(),focusMatch:document.activeElement?.matches(':focus'),background:getComputedStyle(document.activeElement).backgroundColor})`)));
    await pause();
  } };
  const move = async selector => {
    const rect = await run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});const r=node.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...rect});
    await pause();
    return rect;
  };
  const click = async selector => {
    const rect = await move(selector);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...rect});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...rect});
    await pause();
  };
  const key = (value, options = {}) => run(`(document.activeElement??document.body).dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({key:value,bubbles:true,cancelable:true,...options})}))`);
  const menu = async id => { await click(`[data-menu-trigger="${id}"]`); await until(`Boolean(document.querySelector('[role="menu"]'))`); };
  const item = async id => { await click(`[data-menu-item="${id}"]`); await until(`!document.querySelector('[role="menu"]')`); };
  try {
    await win.loadFile(path.join(directory, 'ui', 'index.html'));
    await until(`document.querySelectorAll('[data-menu-trigger]').length===4`);
    // Exercise :focus styling without raising a test window on the user's desktop.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    assert.equal(await run(`document.querySelector('.cache-chip')===null`), true);
    assert.equal(await run(`document.querySelector('[data-history-action="back"]').disabled`), true);
    // Opening with the mouse must not choose the first row, even after typing.
    await run(`document.querySelector('#editor').focus()`);
    await menu('file');
    assert.equal(await run(`document.activeElement.getAttribute('role')`), 'menu');
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-menu-item="newConversation"]')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    await key('ArrowDown');
    assert.equal(await run(`document.activeElement.dataset.menuItem`), 'newConversation');
    await until(`getComputedStyle(document.activeElement).backgroundColor!=='rgba(0, 0, 0, 0)'`);
    await key('ArrowDown');
    assert.equal(await run(`document.activeElement.dataset.menuItem`), 'openProject');
    await move('[data-menu-item="openFiles"]');
    await until(`document.querySelector('.window-frame').dataset.menuInput==='pointer'`);
    await until(`getComputedStyle(document.querySelector('[data-menu-item="openProject"]')).backgroundColor==='rgba(0, 0, 0, 0)'`);
    await until(`getComputedStyle(document.querySelector('[data-menu-item="openFiles"]')).backgroundColor!=='rgba(0, 0, 0, 0)'`);
    win.webContents.sendInputEvent({type:'mouseMove',x:900,y:500});
    await until(`getComputedStyle(document.querySelector('[data-menu-item="openFiles"]')).backgroundColor==='rgba(0, 0, 0, 0)'`);
    assert.equal(await run(`document.activeElement.getAttribute('role')`), 'menu', 'moving off the rows clears the action target too');
    await key('Escape');
    await menu('file'); await key('ArrowUp');
    assert.equal(await run(`document.activeElement.dataset.menuItem`), 'quit');
    await key('Escape');
    await menu('view'); await move('[data-menu-item="browser"]');
    await until(`document.querySelectorAll('[role="menu"]').length===2`);
    assert.equal(await run(`getComputedStyle(document.querySelector('[data-menu-item="openBrowser"]')).backgroundColor`), 'rgba(0, 0, 0, 0)');
    assert.equal(await run(`document.activeElement.dataset.menuItem`), 'browser');
    await key('ArrowRight');
    await until(`document.activeElement.dataset.menuItem==='openBrowser'`);
    await key('Escape'); await key('Escape');
    await click('[data-chat="b"]'); await click('[data-chat="c"]');
    await click('[data-history-action="back"]'); await until(`document.querySelector('#active').textContent==='b'`);
    await key(']', {ctrlKey:true}); await until(`document.querySelector('#active').textContent==='c'`);
    await key('Tab', {ctrlKey:true}); await until(`document.querySelector('#active').textContent==='b'`);
    await key('Tab', {ctrlKey:true,repeat:true}); assert.equal(await run(`document.querySelector('#active').textContent`), 'b');
    await key('Tab', {ctrlKey:true}); await until(`document.querySelector('#active').textContent==='c'`);
    await run(`fixture.setConversations([{id:'a'},{id:'c'}])`); await pause();
    await key('Tab', {ctrlKey:true}); await until(`document.querySelector('#active').textContent==='a'`);

    await menu('file'); await item('newConversation'); await until(`calls.includes('new')`);
    await menu('file'); await item('openProject'); await until(`calls.includes('folder')`);
    await key('p', {ctrlKey:true}); await until(`calls.includes('files')`);
    await key('t', {ctrlKey:true}); await until(`calls.includes('browser')`);
    await key('G', {ctrlKey:true,shiftKey:true}); await until(`calls.includes('review')`);
    await key('b', {ctrlKey:true}); await until(`document.querySelector('#sidebar').textContent==='false'`);
    await run(`saveKeyboardShortcuts({toggleSidebar:{key:'b',ctrl:true,shift:true}})`); await pause();
    await key('b',{ctrlKey:true}); assert.equal(await run(`document.querySelector('#sidebar').textContent`),'false');
    await key('b',{ctrlKey:true,shiftKey:true}); await until(`document.querySelector('#sidebar').textContent==='true'`);
    await menu('view');
    assert.equal(await run(`document.querySelector('[data-menu-item="toggleSidebar"] kbd').textContent`),'Ctrl + Shift + B');
    assert.equal(await run(`document.querySelector('[data-menu-item="toggleSidebar"]').getAttribute('aria-checked')`),'true');
    await run(`document.querySelector('[data-menu-item="browser"]').focus()`); await key('ArrowRight');
    await until(`document.querySelectorAll('[role="menu"]').length===2`);
    assert.equal(await run(`document.querySelector('[data-menu-item="reloadBrowser"]').disabled`),true);
    await key('Escape'); await until(`document.querySelectorAll('[role="menu"]').length===1`);
    assert.equal(await run(`document.activeElement.dataset.menuItem`),'browser');
    await key('Escape'); await run(`fixture.setPreview(true)`); await pause();
    await run(`nativeKey({key:'r',code:'KeyR',ctrlKey:true,metaKey:false,altKey:false,shiftKey:false})`);
    await until(`calls.includes('reload')`);

    // The actual Electron edit operation must target the selection from before opening the menu.
    await run(`document.querySelector('#editor').focus();document.querySelector('#editor').setSelectionRange(5,14)`);
    await menu('edit'); await item('delete');
    await until(`document.querySelector('#editor').value==='keep text'`);
    assert.equal(await run(`document.activeElement.id`),'editor');
    await menu('edit'); await item('undo'); await until(`document.querySelector('#editor').value==='keep selected text'`);
    await menu('edit'); await item('redo'); await until(`document.querySelector('#editor').value==='keep text'`);
    await menu('edit'); await item('selectAll');
    await until(`document.querySelector('#editor').selectionEnd===9&&document.querySelector('#editor').selectionStart===0`);
    await run(`(()=>{const editor=document.querySelector('#rich-editor');editor.focus();const range=document.createRange();range.setStart(editor.firstChild,6);range.setEnd(editor.firstChild,11);const sel=getSelection();sel.removeAllRanges();sel.addRange(range)})()`);
    await menu('edit'); await item('delete'); await until(`document.querySelector('#rich-editor').textContent==='alpha gamma'`);
    await run(`document.querySelector('#editor').focus();document.querySelector('#editor').setSelectionRange(1,3)`);
    await menu('file'); await key('Escape');
    assert.deepEqual(await run(`[document.activeElement.id,document.querySelector('#editor').selectionStart,document.querySelector('#editor').selectionEnd]`),['editor',1,3]);

    const beforeZoom = win.webContents.getZoomLevel();
    await menu('view'); await item('zoomIn'); assert.equal(win.webContents.getZoomLevel(),beforeZoom+0.5);
    await key('0',{ctrlKey:true}); await pause(); assert.equal(win.webContents.getZoomLevel(),0);
    await run(`fixture.setModal(true)`); await until(`Boolean(document.querySelector('#modal-input'))`);
    await run(`document.querySelector('#modal-input').focus()`); const previousCalls=await run('calls.length');
    await key('n',{ctrlKey:true}); await key('+',{ctrlKey:true});
    assert.equal(await run('calls.length'),previousCalls); assert.equal(win.webContents.getZoomLevel(),0);
    await run(`fixture.setModal(false);fixture.setLanguage('en')`); await pause();
    await menu('help'); assert.equal(await run(`document.querySelector('[data-menu-item="diagnostics"]').textContent.trim()`),'Diagnostics and about');
    await item('diagnostics'); await until(`calls.includes('diagnostics')`);

    // Review real menu geometry at small window sizes and in both themes.
    await run(`fixture.setLanguage('zh')`); await pause();
    for (const theme of ['dark','bright']) {
      await run(`fixture.setTheme('${theme}')`); await pause(); await menu('view');
      await run(`document.querySelector('[data-menu-item="browser"]').focus()`); await key('ArrowRight');
      await until(`document.querySelectorAll('[role="menu"]').length===2`);
      const rects=await run(`Array.from(document.querySelectorAll('[role="menu"]')).map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})`);
      for(const r of rects){assert.ok(r.left>=0&&r.right<=1180);assert.ok(r.top>=36&&r.bottom<=760);}
      await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await new Promise(resolve=>setTimeout(resolve,180));
      fs.writeFileSync(path.resolve('tmp', 'window-menu-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      await key('Escape'); await key('Escape');
    }
    win.setSize(620,480); await pause(); await menu('view');
    const bounds=await run(`(()=>{const n=document.querySelector('[role="menu"]');const r=n.getBoundingClientRect();return {bottom:r.bottom,height:r.height,scroll:n.scrollHeight,client:n.clientHeight,viewport:innerHeight}})()`);
    assert.ok(bounds.bottom<=bounds.viewport); assert.ok(bounds.scroll>bounds.client,'long menus scroll in short windows');
    await key('End'); assert.equal(await run(`document.activeElement.dataset.menuItem`),'toggleFullscreen');
    await key('Escape');

    const sender={sender:win.webContents,senderFrame:win.webContents.mainFrame};
    const foreign=new BrowserWindow({show:false});
    assert.throws(()=>executeWindowMenuAction(sender,win,'delete',foreign.webContents.id,()=>{}),/original editor/);
    assert.throws(()=>executeWindowMenuAction({...sender,senderFrame:{}},win,'quit',undefined,()=>{}),/Only the main/);
    assert.throws(()=>executeWindowMenuAction(sender,win,'executeJavaScript',undefined,()=>{}),/Unknown/);
    foreign.destroy();
    assert.deepEqual(await run('errors'),[]);
    assert.ok(calls.includes('delete')&&calls.includes('undo')&&calls.includes('redo')&&calls.includes('selectAll'));
    console.log('Window menus passed: actions, real native edits and selection restore, keyboard/submenu navigation, history pruning, shortcut overrides, reload routing, modal isolation, zoom, light/dark layout and IPC boundaries.');
  } finally { win.destroy(); clearTimeout(deadline); }
}).then(()=>app.exit(0),error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
