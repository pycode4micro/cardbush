const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root,'src/features/automations/calendarSurface.css'),'utf8'));
  window.setContentSize(1180, 760);
  await run(`(()=>{const state=JSON.parse(localStorage.getItem('cardbush.html_components.v1'));
    views.saveComponents({...state,welcomeLayout:{items:[
      {componentId:'system-input',x:11,y:0,width:78,height:52,inputStyle:'simple',composerFlow:{afterSend:'bottom',output:'above'}},
      {componentId:'system-digital-clock',x:10,y:200,width:36,height:120},
      {componentId:'system-calendar',x:60,y:70,width:32,height:260}
    ]}},state.revision);showWelcomeLibrary();})()`);
  await until('!!document.querySelector(".components-app")', 'controls library');
  await run('[...document.querySelectorAll("button")].find(button=>button.textContent==="编辑布局").click()');
  await until('!!document.querySelector(".welcome-layout-editor")', 'controls editor');
  const saved = await run('localStorage.getItem("cardbush.html_components.v1")');
  const bounds = selector => run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})()`);
  const component = '.welcome-slot-input';
  const showHandles = async selector => {
    const box = await bounds(selector);
    window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(box.left+12),y:Math.round(Math.max(box.top+8, (await bounds('.welcome-layout-surface')).top+8))});
    await pause();
  };
  const visible = async selector => {
    const controls = await bounds(selector+' .welcome-layout-handles'), canvas = await bounds('.welcome-layout-surface');
    assert.ok(controls.top >= canvas.top && controls.bottom <= canvas.bottom && controls.left >= canvas.left && controls.right <= canvas.right,
      'the entire component action bar stays inside the visible canvas: '+JSON.stringify({controls,canvas}));
    assert.equal(await run(`(()=>{const group=document.querySelector(${JSON.stringify(selector+' .welcome-layout-handles')});return [...group.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();return button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});})()`),true,'all action buttons remain hit-testable');
  };
  await showHandles(component); await visible(component);
  const original = await bounds(component);
  assert.ok((await bounds(component+' .welcome-layout-handles')).top >= original.bottom, 'top-edge controls flip below the input');
  assert.equal(await run(`(()=>{const b=document.querySelector('.welcome-layout-toolbar').getBoundingClientRect();return [...document.querySelectorAll('[data-welcome-component]')].every(slot=>{const r=slot.getBoundingClientRect();return b.right<=r.left||b.left>=r.right||b.bottom<=r.top||b.top>=r.bottom;});})()`),true,'automatic toolbar uses free space');
  fs.writeFileSync(path.join(root,'tmp','welcome-layout-controls-top.png'),(await window.webContents.capturePage()).toPNG());
  const button = await bounds('.composer-layout-settings-button');
  const point = {x:Math.round(button.left+button.width/2),y:Math.round(button.top+button.height/2)};
  for (const type of ['mouseMove','mouseDown','mouseUp']) window.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});
  await until('document.querySelector(".composer-layout-dialog")?.open', 'native click opens clipped-before settings');
  await run('document.querySelector(".composer-layout-done").click()');
  await run('Object.assign(document.querySelector(".main-stage").style,{zoom:"1.25",width:"80%",height:"80%",flex:"none"});void 0');
  await pause(); await showHandles(component); await visible(component);
  window.setContentSize(500,760); await pause(); await showHandles(component); await visible(component);
  fs.writeFileSync(path.join(root,'tmp','welcome-layout-controls-narrow.png'),(await window.webContents.capturePage()).toPNG());
  window.setContentSize(1180,760);
  await run('Object.assign(document.querySelector(".main-stage").style,{zoom:"1",width:"",height:"100%",flex:""});void 0'); await pause();
  const restored = await bounds(component);
  assert.ok(Math.abs(original.top-restored.top)<1 && Math.abs(original.width-restored.width)<1,'overlay placement does not move or resize components');
  await run('document.querySelector(".welcome-layout-canvas").style.minHeight="1200px";document.querySelector(".welcome-layout-surface").scrollTop=80'); await pause();
  await showHandles('.welcome-slot-calendar'); await visible('.welcome-slot-calendar');
  assert.equal(await run('localStorage.getItem("cardbush.html_components.v1")'),saved,'viewport/scroll changes do not alter the saved layout');
  await run('[...document.querySelectorAll(".welcome-layout-toolbar button")].find(button=>button.textContent==="取消").click()');
  console.log('Layout controls passed: top edge, native settings click, 125% zoom, narrow windows, scroll clipping, toolbar avoidance and unchanged component placement.');
};
