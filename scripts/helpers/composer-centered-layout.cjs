const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const close = (a, b, label) => assert.ok(Math.abs(a-b)<2, `${label}: ${a} vs ${b}`);
  window.setContentSize(1080, 820);
  await run(`
    window.placeInput=(options={})=>{
      const state=JSON.parse(localStorage.getItem(views.componentStorageKey));
      views.saveComponents({...state,welcomeLayout:{items:[{...state.welcomeLayout.items[0],...options}]}},state.revision);
    };
    void 0;
  `);
  for (const style of ['simple','standard']) for (const mode of ['keep','bottom']) {
    await run(`startFlow(${JSON.stringify(mode)},'above',${JSON.stringify('center-'+mode+style)});updateChat({language:'zh'});`);
    await pause();
    await run(`placeInput({x:1,y:180,width:62,height:700,inputStyle:${JSON.stringify(style)}})`);
    await until(`!!document.querySelector('.welcome-composer .composer-stack${style === 'simple' ? '.simple' : ':not(.simple)'}')`, 'input presentation'); await pause();
    const before = await run('layoutRect(".welcome-composer .composer-stack")');
    close(before.left+before.width/2, (await run('document.querySelector(".chat-body").clientWidth'))/2, 'welcome center');
    assert.ok(await run('document.querySelector(".welcome-slot-input").offsetHeight<300'), 'stored height creates no empty padding');
    await run('document.querySelector(".send-button").click()');
    await until('!!document.querySelector(".composer-dock .composer-stack")', 'centered send');
    await until('document.querySelector(".composer-dock").getAnimations().every(a=>a.playState!=="running")', 'vertical arrival'); await pause();
    const after = await run('layoutRect(".composer-dock .composer-stack")');
    close(after.left,before.left,'same horizontal origin'); close(after.width,before.width,'same width');
    if (mode==='keep') close(after.top,before.top,'keep actual input top');
    else {
      close(after.bottom, (await run('document.querySelector(".chat-body").clientHeight'))-20, 'shared bottom landing');
      assert.ok(after.top-before.top>=120,'meaningful vertical travel');
    }
  }
  // A nearby placement snaps already on the welcome page, before a message is sent.
  await run('startFlow("bottom","above","center-snapped")'); await pause();
  await run('placeInput({y:document.querySelector(".chat-body").clientHeight-document.querySelector(".welcome-slot-input").offsetHeight-70,width:62})'); await pause();
  const snapped = await run('layoutRect(".welcome-composer .composer-stack")');
  assert.equal(await run('document.querySelector(".welcome-slot-input").dataset.composerDocked'),'true');
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".composer-dock")','snapped send'); await pause();
  close((await run('layoutRect(".composer-dock .composer-stack")')).top,snapped.top,'snapped send does not move');
  assert.equal(await run('document.querySelector(".composer-dock").getAnimations().length'),0,'no tiny motion');

  await run(`startFlow('bottom','above','center-default');`); await pause();
  await run('(()=>{const s=JSON.parse(localStorage.getItem(views.componentStorageKey));views.saveComponents({...s,welcomeLayout:undefined},s.revision)})();'); await pause();
  const defaultInput = await run('layoutRect(".welcome-composer .composer-stack")');
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".composer-dock")','default send'); await pause();
  const defaultSent = await run('layoutRect(".composer-dock .composer-stack")');
  close(defaultSent.left,defaultInput.left,'default center remains'); close(defaultSent.width,defaultInput.width,'default width remains');
  close(defaultSent.top,defaultInput.top,'default bottom remains');

  // Actual editor, actual pointer capture at 125%, with the live Composer.
  await run(`startFlow('keep','above','center-editor');`); await pause();
  await run(`placeInput({y:160,width:62,inputStyle:'simple'});
    window.openCenteredEditor=()=>renderView(h(views.HtmlComponentContext.Provider,{value:{composer:h(views.Composer,{...chatProps,compact:true,portalCommands:true})}},
      h('section',{className:'main-stage',style:{height:'100%'}},h(views.ComponentsApp,{language:'zh'}))));openCenteredEditor();`);
  const click = text => run(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await until('!!document.querySelector(".components-app")','editor library'); await click('编辑布局');
  await until('!!document.querySelector(".welcome-layout-editor")','center editor');
  await run('Object.assign(document.querySelector(".main-stage").style,{zoom:"1.25",width:"80%",height:"80%",flex:"none"});void 0'); await pause();
  const bounds = selector => run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,bottom:r.bottom}})()`);
  const inputSelector = '.welcome-slot-input';
  const mouse = (type,x,y) => window.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),modifiers:['alt'],
    ...(type==='mouseDown'||type==='mouseUp'?{button:'left',clickCount:1}:{})});
  const drag = async (selector,dx,dy) => {
    const r=await bounds(selector), x=r.left+r.width/2,y=r.top+r.height/2;
    mouse('mouseMove',x,y);await pause(40);mouse('mouseDown',x,y);await pause(30);
    mouse('mouseMove',x+dx,y+dy);await pause(40);mouse('mouseUp',x+dx,y+dy);await pause();
  };
  const original = await bounds(inputSelector);
  await drag(inputSelector,80,65);
  const moved = await bounds(inputSelector);
  close(moved.left,original.left,'pointer horizontal lock even with Alt'); close(moved.top-original.top,65,'vertical pointer moves at 125%');
  await drag('.welcome-slot-input .welcome-layout-resize',30,45);
  const resized = await bounds(inputSelector);
  close(resized.left+resized.width/2,original.left+original.width/2,'resize center fixed');
  close(resized.width-moved.width,60,'width expands symmetrically'); close(resized.height,moved.height,'vertical resize does not add padding');
  await run('document.querySelector(".welcome-slot-input .welcome-layout-drag").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))'); await pause();
  close((await bounds(inputSelector)).left,resized.left,'keyboard cannot move horizontally');
  await run('document.querySelector(".composer-layout-settings-button").click()');
  await until('document.querySelector(".composer-layout-dialog")?.open','flow dialog');
  await run('const s=document.querySelector(".composer-layout-dialog select");s.value="bottom";s.dispatchEvent(new Event("change",{bubbles:true}));'); await pause();
  await run('document.querySelector(".composer-layout-done").click()');
  await until('!!document.querySelector(".welcome-composer-landing")','bottom landing preview'); await pause();
  fs.writeFileSync(path.join(root,'tmp','composer-centered-editor.png'),(await window.webContents.capturePage()).toPNG());
  const landing=await bounds('.welcome-composer-landing'), current=await bounds(inputSelector);
  await drag(inputSelector,50,landing.top-current.top-30);
  assert.equal(await run('document.querySelector(".welcome-composer-landing").dataset.docked'),'true','near landing snaps in editor');
  close((await bounds(inputSelector)).top,(await bounds('.welcome-composer-landing')).top,'actual bounds equal preview');
  await click('保存'); await until('!!document.querySelector(".components-app")','saved centered layout');
  const stored=await run('JSON.parse(localStorage.getItem(views.componentStorageKey)).welcomeLayout.items[0]');
  assert.equal(stored.composerDock,'bottom'); close(stored.x,(100-stored.width)/2,'saved center');
  await click('编辑布局'); await until('!!document.querySelector(".welcome-layout-editor")','reopened centered layout'); await pause();
  assert.equal(await run('document.querySelector(".welcome-slot-input").dataset.composerDocked'),'true','bottom pin survives reopen');
  window.setContentSize(1080,640); await pause();
  close((await bounds(inputSelector)).bottom,(await bounds('.welcome-layout-surface')).bottom-25,'bottom pin follows height at 125%');
  await click('取消');

  // Small windows and a default layout share the same center and bottom rules.
  window.setContentSize(480,360);
  await run('startFlow("bottom","above","center-small")'); await pause();
  await run('placeInput({y:12,width:90})'); await pause();
  assert.equal(await run('document.querySelector(".welcome-slot-input").dataset.composerDocked'),'true','small window pins bottom');
  const small = await run('layoutRect(".welcome-composer .composer-stack")');
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".composer-dock")','small send'); await pause();
  const smallSent = await run('layoutRect(".composer-dock .composer-stack")');
  close(smallSent.top,small.top,'small window stays put'); close(smallSent.width,small.width,'small window same width');
  await run('renderView(null);localStorage.removeItem(views.componentStorageKey)');
  console.log('Centered composer passed: both styles and send modes, same width/axis, actual bounds, snapping, 125% drag/resize, keyboard lock, save/reopen, bottom pin and small windows.');
};
