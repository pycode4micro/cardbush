const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root,'src/features/inspector/inspectorWorkspace.css'),'utf8'));
  await window.webContents.insertCSS('.app { width:100%!important; --window-frame-height:46px; }');
  await run(`
    window.coverSent=[];window.coverStops=0;
    function CoverFixture(){
      const [covered,setCovered]=React.useState(false),[input,setInput]=React.useState(false),[target,setTarget]=React.useState(null),[width,setWidth]=React.useState(500);
      const [tiled,setTiled]=React.useState(true);
      const tabs=[{id:'first',kind:'resource',detail:{target:'https://first.example/'}},{id:'second',kind:'resource',detail:{target:'https://second.example/'}}];
      window.coverLayout=setTiled;
      const [props,setProps]=React.useState({...chatProps,language:'zh',activeConversationId:'cover-session',loading:false,draft:'keep draft',
        messages:[{id:'user',role:'user',content:'Cover fixture',createdAt:'2026-09-30T00:00:00Z'}],availableModels:[{id:'fixture',provider:'fixture',modelName:'fixture',enabled:true}]});
      window.coverUpdate=patch=>setProps(current=>({...current,...patch}));
      return h(React.Fragment,null,h('div',{style:{height:46}},'Native action bar'),
        h('main',{className:'desktop-shell sidebar-is-collapsed'+(covered?' inspector-covered':'')},
          h('section',{className:'main-stage',inert:covered},h(views.ComposerPortalContext.Provider,{value:input?target:null},h(views.ChatPanel,{...props,
            onDraftChange:draft=>setProps(current=>({...current,draft})),onSend:async text=>{coverSent.push(text);setProps(current=>({...current,draft:'',sending:true,activeTurnId:'cover-turn'}));},onCancel:async()=>{coverStops++;setProps(current=>({...current,sending:false,activeTurnId:''}));}}))),
          h('aside',{className:'right-inspector',style:{'--right-inspector-width':width+'px'}},
            h(views.RightInspectorResizer,{width,windowMaximized:false,onWidthChange:setWidth,onExpand:()=>setCovered(true),label:'Expand workspace'}),
            h('div',{className:'right-inspector-viewport'},h('div',{className:'right-inspector-content'},
              h('header',{className:'right-inspector-toolbar'},'Browser tabs'),
              h('div',{className:'right-inspector-body'},h(views.InspectorTabPages,{tabs,activeId:'first',layout:tiled?views.addPanel(views.addPanel(null,'first'),'second'):null,
                renderFrame:tab=>h(views.InspectorTileFrame,{tab,language:'zh',onSwap:()=>{}})},tab=>h('div',null,tab.detail.target)))))),
          covered&&h('div',{className:'inspector-cover-controls'},input&&h('div',{className:'inspector-quick-input',ref:setTarget}),h('div',{className:'inspector-cover-capsule'},
            h('button',{id:'cover-back',onClick:()=>{setInput(false);setCovered(false);}},'返回'),h('button',{id:'cover-input',onClick:()=>setInput(value=>!value)},'输入')))));
    }
    renderView(h(CoverFixture));
  `);
  await until('!!document.querySelector(".right-inspector-resizer")','inspector resizer');
  const point=await run('(()=>{const r=document.querySelector(".right-inspector-resizer").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+100)};})()');
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:4,y:point.y});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:4,y:point.y});
  await until('!!document.querySelector(".inspector-covered")','drag boundary to cover');
  const bounds=await run('(()=>{const r=document.querySelector(".right-inspector").getBoundingClientRect(),s=document.querySelector(".desktop-shell").getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,shellWidth:s.width};})()');
  assert.ok(bounds.left<3 && bounds.top>=46 && Math.abs(bounds.width-bounds.shellWidth)<3,'cover fits content and keeps native bar');
  const assertContentWidth=async tiled=>{
    const sizes=await run(`(()=>{const width=s=>document.querySelector(s).getBoundingClientRect().width;return {
      outer:width('.right-inspector'),inner:width('.right-inspector-content'),pages:width('.right-inspector-tab-pages'),
      tile:width('.right-inspector-tab-page.active')};})()`);
    assert.ok(Math.abs(sizes.inner-sizes.outer)<3,`inner content must fill cover: ${JSON.stringify(sizes)}`);
    assert.ok(Math.abs(sizes.pages-sizes.inner)<2,'pages fill inner container');
    assert.ok(Math.abs(sizes.tile-sizes.pages/(tiled?2:1))<2,'visible page fills its share');
  };
  await assertContentWidth(true);
  await run('coverLayout(false)'); await pause(); await assertContentWidth(false);
  await run('coverLayout(true)'); await pause();
  const originalSize=window.getSize();
  window.setSize(1000,800); await pause(); await assertContentWidth(true);
  window.webContents.setZoomFactor(1.25); await pause(); await assertContentWidth(true);
  window.webContents.setZoomFactor(1); window.setSize(640,800); await pause(); await assertContentWidth(true);
  assert.equal(await run('Array.from(document.querySelectorAll(".inspector-tile-drag")).every(handle=>handle.getBoundingClientRect().width>0)'),true,'narrow layouts keep drag handles visible');
  window.setSize(...originalSize); await pause();
  await run('document.querySelector("#cover-input").click()');
  await until('!!document.querySelector(".inspector-quick-input textarea[data-composer-input]")','real composer portalled into capsule');
  await until('document.activeElement===document.querySelector(".inspector-quick-input textarea")','quick input receives focus');
  assert.equal(await run('document.querySelectorAll("[data-composer-input]").length'),1,'single composer');
  assert.equal(await run('document.querySelector(".inspector-quick-input textarea").value'),'keep draft');
  assert.equal(await run('getComputedStyle(document.querySelector(".composer-tools")).display'),'none');
  await run('document.querySelector("textarea[data-composer-input]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true}));void 0');
  assert.deepEqual(await run('coverSent'),[],'IME confirmation does not send');
  await run('(()=>{const node=document.querySelector("textarea[data-composer-input]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(node,"/");node.setSelectionRange(1,1);node.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await until('!!document.querySelector(".composer-command-list")','slash commands in quick input');
  await run('(()=>{const node=document.querySelector("textarea[data-composer-input]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(node,"quick message");node.setSelectionRange(13,13);node.dispatchEvent(new Event("input",{bubbles:true}));})()');await pause();
  await run('document.querySelector("textarea[data-composer-input]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));void 0');
  await until('coverSent.length===1','quick input submits through original sender');
  await until('!!document.querySelector(".inspector-quick-input .send-button svg.lucide-square")','running turn shows stop');
  await run('document.querySelector(".inspector-quick-input .send-button").click()');
  await until('coverStops===1','original stop callback');
  fs.writeFileSync(path.join(root,'tmp','inspector-cover-quick-input.png'),(await window.webContents.capturePage()).toPNG());
  await run('coverUpdate({draft:"return draft"});document.querySelector("#cover-back").click()');
  await until('!document.querySelector(".inspector-covered") && !!document.querySelector(".main-stage textarea[data-composer-input]")','Back returns composer to conversation');
  assert.equal(await run('document.querySelector(".main-stage textarea[data-composer-input]").value'),'return draft');
  assert.ok(Math.abs(await run('document.querySelector(".right-inspector-content").getBoundingClientRect().width')-499)<2,'Back restores the original inspector width');
  assert.equal(await run('document.body.classList.contains("right-inspector-resizing")'),false);
  console.log('Inspector cover passed: real pointer drag, full inner/tile widths, single/multi-page, window resize and 125% renderer zoom, narrow drag handles, native bar retained, Composer and original-width restoration.');
};
