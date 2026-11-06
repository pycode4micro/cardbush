const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Native Team UI timed out'); app.exit(1); }, 55000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors=[]; win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  const read = script => win.webContents.executeJavaScript(script).catch(error=>{throw Error(error.message+'; script='+script.slice(0,600)+'; errors='+errors.join('\n'))});
  const frame = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const capture = async () => {
    for (let attempt=0;attempt<3;attempt++) {
      try { const image=await win.webContents.capturePage(); assert.ok(!image.isEmpty()); return image; }
      catch (error) { if (!String(error).includes('UnknownVizError') || attempt===2) throw error; await frame(); await new Promise(resolve=>setTimeout(resolve,100)); }
    }
  };
  const key = async (keyCode,modifiers=[])=>{keyCode=keyCode.replace(/^Arrow/,'');win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame()};
  const until = async script => {
    const end = Date.now() + 4000;
    while (!(await read(script))) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '; ' + await read('document.body.innerText') + '; editor=' + await read('JSON.stringify(window.bodyEditor?.editor && {focus:bodyEditor.editor.isFocused, composing:bodyEditor.editor.view.composing, selection:bodyEditor.editor.state.selection.toJSON(),parent:bodyEditor.editor.state.selection.$from.parent.textContent})'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const click = async text => {
    if (['添加任务','添加章节'].includes(text)) {
      await read('document.querySelector("[aria-label=插入内容]").click()'); await frame();
      text = text === '添加任务' ? 'Team 任务' : '可引用章节';
    }
    if (!(await read(`[...document.querySelectorAll('button')].some(button=>button.textContent.replace(/Ctrl\\+N/g,'').trim()===${JSON.stringify(text)})`))) await action('页面菜单');
    await read(`[...document.querySelectorAll('button')].find(button=>button.textContent.replace(/Ctrl\\+N/g,'').trim()===${JSON.stringify(text)}).click()`); await frame();
  };
  const action = async label => {
    if (!(await read(`!!document.querySelector('[aria-label="${label}"]')`))) { assert.notEqual(label,'页面菜单','page menu is available'); await action('页面菜单'); }
    await read(`document.querySelector('[aria-label="${label}"]').click()`); await frame();
  };
  const pointerClick = async selector => {
    if (!(await read(`!!document.querySelector(${JSON.stringify(selector)})`))) { assert.notEqual(selector,'[aria-label="页面菜单"]','page menu is available'); await pointerClick('[aria-label="页面菜单"]'); }
    const point = await read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const rect=element.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await frame();
  };
  const fill = async (name, value, scope = '.native-team-editor') => {
    await read(`(()=>{ const label=[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(label=>label.firstChild.textContent.trim()===${JSON.stringify(name)});
      const input=label.querySelector('input,textarea,select'); const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`); await frame();
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    // Hidden windows otherwise suppress focusin/blur, masking real multi-editor interactions.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await require('./helpers/team-flow-workspace.cjs')({read,until,frame,click,action,fill,key,pointerClick,capture,win});
    console.log('Native Team UI passed: registry, workflow editing/runs, composer, revisions, themes and Canvas handoff.');

    assert.deepEqual(errors, []);
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); if (errors.length) console.error(errors.join('\n')); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
