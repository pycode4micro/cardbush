const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const browserPreview = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#143a3f;color:#fff;font:16px system-ui;padding:24px;height:100vh;overflow:hidden}
    h1{font-size:24px;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;height:calc(100% - 45px)}
    article{border-radius:18px;padding:20px;background:linear-gradient(135deg,#376b77,#304655);display:flex;align-items:end}
    article:nth-child(3n+2){background:linear-gradient(120deg,#a78561,#714e53)}article:nth-child(3n){background:linear-gradient(135deg,#798c78,#374b54)}
    button{position:fixed;bottom:24px;left:24px;border:1px solid #ffffff50;border-radius:14px;background:#173a40;color:white;padding:12px;font:inherit}
    </style></head><body><h1>Browser preview</h1><div class="grid">${Array.from({length:9},(_,index)=>`<article>Page content ${index+1}</article>`).join('')}</div>
    <button onclick="window.pageClicks=(window.pageClicks||0)+1">Page action</button></body></html>`);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root,'src/features/inspector/inspectorWorkspace.css'),'utf8'));
  await window.webContents.insertCSS('.app { width:100%!important; --window-frame-height:46px; }');
  await run(`
    window.coverSent=[];window.coverStops=0;
    localStorage.setItem('cardbush.inspector_width','500');
    localStorage.removeItem('cardbush.inspector_split_width');
    window.CoverFixture=function CoverFixture({startSidebarCollapsed=true}={}){
      const [target,setTarget]=React.useState(null),[sidebarCollapsed,setSidebarCollapsed]=React.useState(startSidebarCollapsed);
      const [section,setSection]=React.useState('chat'),[inspectorOpen,setInspectorOpen]=React.useState(true);
      const [windowMaximized,setWindowMaximized]=React.useState(false);
      const [tiled,setTiled]=React.useState(true);
      const [tabs]=React.useState([{id:'first',kind:'resource',detail:{target:'https://first.example/'}},{id:'second',kind:'resource',detail:{target:'https://second.example/'}}]);
      const workspace=views.useInspectorWorkspace({language:'zh',windowMaximized,compactLayout:false,
        section,setSection,sidebarCollapsed,sidebarWidth:280,setSidebarCollapsed,inspectorOpen,setInspectorOpen,
        inspectorTabs:tabs,activeInspectorTab:tabs[0],openInspectorTab:()=>{},setInspectorAddMenuOpen:()=>{},setInspectorTabsMenuOpen:()=>{}});
      const {inspectorCover:covered,inspectorControlsVisible,conversationCovered,mainStageRef,inspectorWidth:width,setInspectorWidth:setWidth,quickInputOpen:input,setQuickInputOpen:setInput}=workspace;
      const presence=views.useSoftPanelPresence(inspectorOpen,240,{keepMounted:true});
      window.coverWorkspace={...workspace,setSidebarCollapsed,setInspectorOpen,inspectorOpen,setSection,section,setWindowMaximized};
      window.coverLayout=setTiled;
      const [props,setProps]=React.useState({...chatProps,language:'zh',activeConversationId:'cover-session',loading:false,draft:'keep draft',
        messages:[{id:'user',role:'user',content:'Cover fixture',createdAt:'2026-09-30T00:00:00Z'}],availableModels:[{id:'fixture',provider:'fixture',modelName:'fixture',enabled:true}]});
      window.coverUpdate=patch=>setProps(current=>({...current,...patch}));
      return h(React.Fragment,null,h('div',{style:{height:46}},h(views.WindowSidebarToggle,{language:'zh',collapsed:sidebarCollapsed,onToggle:()=>setSidebarCollapsed(value=>!value)})),
        h('main',{className:'desktop-shell'+(windowMaximized?' window-maximized':' window-restored')+(sidebarCollapsed?' sidebar-is-collapsed':'')+(covered?' inspector-covered':conversationCovered?' inspector-conversation-covered':''),style:{'--sidebar-width':'280px'}},
          h(views.CompactSidebarBackdrop,{visible:covered&&!sidebarCollapsed,language:'zh',onClose:()=>setSidebarCollapsed(true)}),
          h('aside',{className:'sidebar'+(sidebarCollapsed?' soft-panel-hidden':'')},h('button',{id:'sidebar-conversation',onClick:()=>{workspace.revealConversation();setSection('assistant');}},'Conversation list')),
          !sidebarCollapsed&&h('div',{className:'sidebar-resizer'}),
          h('section',{className:'main-stage',ref:mainStageRef,inert:inspectorControlsVisible},h(views.ComposerPortalContext.Provider,{value:input?target:null},h(views.ChatPanel,{...props,
            onDraftChange:draft=>setProps(current=>({...current,draft})),onSend:async text=>{coverSent.push(text);setProps(current=>({...current,draft:'',sending:true,activeTurnId:'cover-turn',messages:[...current.messages,{id:'sent',role:'user',content:text,turnId:'cover-turn',createdAt:new Date().toISOString()}]}));},onCancel:async()=>{coverStops++;setProps(current=>({...current,sending:false,activeTurnId:''}));}}))),
          presence.mounted&&h('aside',{className:'right-inspector soft-panel-motion'+(presence.visible?' soft-panel-visible':' soft-panel-hidden'),inert:!presence.visible||covered&&!sidebarCollapsed,style:{'--right-inspector-width':width+'px'}},
            h(views.RightInspectorResizer,{width,windowMaximized,onWidthChange:setWidth,onExpand:workspace.enterInspectorCover,softVisible:presence.visible,label:'Expand workspace'}),
            h('div',{className:'right-inspector-viewport'},h('div',{className:'right-inspector-content'},
              h('header',{className:'right-inspector-toolbar'},'Browser tabs'),
              h('div',{className:'right-inspector-body'},h(views.InspectorTabPages,{tabs,activeId:'first',layout:tiled?views.addPanel(views.addPanel(null,'first'),'second'):null,
                renderFrame:tab=>h(views.InspectorTileFrame,{tab,language:'zh',onSwap:()=>{}})},tab=>h('webview',{src:${JSON.stringify(browserPreview)},
                  style:{width:'100%',height:'100%'},webpreferences:'contextIsolation=yes,nodeIntegration=no,sandbox=yes'})))))),
          inspectorControlsVisible&&h('div',{className:'inspector-cover-controls',inert:covered&&!sidebarCollapsed},input&&h('div',{className:'inspector-quick-input',ref:setTarget}),h('div',{className:'inspector-cover-capsule'},
            h('button',{id:'cover-back',onClick:workspace.leaveInspectorCover},'返回'),h('button',{id:'cover-input',onClick:()=>setInput(value=>!value)},'输入')))));
    };
    renderView(h(CoverFixture));
  `);
  await until('!!document.querySelector(".right-inspector-resizer")','inspector resizer');
  await pause(300);
  await run('coverWorkspace.setInspectorWidth(document.querySelector(".desktop-shell").clientWidth-160)');
  await until('coverWorkspace.conversationCovered && document.querySelector(".main-stage").clientWidth===0','a 160px conversation collapses completely');
  await run('coverWorkspace.setInspectorWidth(document.querySelector(".desktop-shell").clientWidth-330)'); await pause(300);
  assert.equal(await run('coverWorkspace.conversationCovered'),true,'small boundary changes do not toggle the capsule');
  await run('coverWorkspace.setInspectorWidth(document.querySelector(".desktop-shell").clientWidth-360)');
  await until('!coverWorkspace.conversationCovered && document.querySelector(".main-stage").clientWidth>=340','usable width restores chat');
  await run('coverWorkspace.setInspectorWidth(500)'); await pause(300);
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
  const floating = await run(`(()=>{
    const capsule=document.querySelector('.inspector-cover-capsule'),page=document.querySelector('.right-inspector-tab-pages');
    const c=capsule.getBoundingClientRect(),p=page.getBoundingClientRect(),panel=document.querySelector('.right-inspector').getBoundingClientRect();
    return {capsuleWidth:c.width,blur:getComputedStyle(capsule).backdropFilter,pageBottom:p.bottom,panelBottom:panel.bottom,
      below:document.elementFromPoint(c.left-60,c.top+c.height/2)?.tagName};
  })()`);
  assert.ok(floating.capsuleWidth<240 && floating.blur.includes('blur('),'only the compact capsule receives glass styling');
  assert.ok(Math.abs(floating.pageBottom-floating.panelBottom)<3,'web page reaches the bottom without a reserved footer row');
  assert.equal(floating.below,'WEBVIEW','space alongside the capsule stays interactive');
  const guestId=await run('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()');
  const guest=require('electron').webContents.fromId(guestId);
  // The title-bar toggle opens a real drawer above the covering WebContents.
  const clickSidebar=async()=>{
    const point=await run('(()=>{const r=document.querySelector(".window-sidebar-toggle").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  await clickSidebar();await until('!!document.querySelector(".compact-sidebar-backdrop[data-visible=true]")','cover sidebar backdrop');await pause(300);
  assert.ok(await run('(()=>{const sidebar=document.querySelector(".sidebar"),r=sidebar.getBoundingClientRect();return r.width>200&&getComputedStyle(sidebar).visibility==="visible"&&sidebar.contains(document.elementFromPoint(r.left+40,r.top+20));})()'),'sidebar receives pointer input above the browser');
  assert.equal(await run('document.querySelector(".right-inspector").inert && document.querySelector(".inspector-cover-controls").inert'),true,'drawer isolates the covered content');
  fs.writeFileSync(path.join(root,'tmp','inspector-cover-sidebar.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
  await until('!document.querySelector(".compact-sidebar-backdrop[data-visible=true]")','Escape closes the drawer first');
  assert.equal(await run('coverWorkspace.inspectorCover'),true,'Escape keeps the browser cover');
  await clickSidebar();await until('!!document.querySelector(".compact-sidebar-backdrop[data-visible=true]")','sidebar reopens');
  await run('document.querySelector(".compact-sidebar-backdrop").click()');await pause(300);
  assert.equal(await run('coverWorkspace.inspectorCover'),true,'backdrop closes only the drawer');
  assert.equal(await run('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()'),guestId,'opening the drawer preserves the browser');
  const guestBounds=await run(`(()=>{const r=document.querySelector('.right-inspector-tab-page.active webview').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()`);
  for(let attempt=0;attempt<60;attempt++) {
    if(await guest.executeJavaScript(`document.readyState==='complete' && Math.abs(innerWidth-${guestBounds.width})<2 && Math.abs(innerHeight-${guestBounds.height})<2`))break;
    assert.ok(attempt<59,'native webview catches up with the uncovered height');await pause(30);
  }
  const buttonPoint=await guest.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
  const actionPoint={x:Math.round(guestBounds.left+buttonPoint.x),y:Math.round(guestBounds.top+buttonPoint.y)};
  await pause(150);
  await run('document.querySelector(".app").className="app theme-bright"');await pause();
  fs.writeFileSync(path.join(root,'tmp','inspector-cover-glass-light.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(await run(`document.elementFromPoint(${actionPoint.x},${actionPoint.y})?.tagName`),'WEBVIEW');
  // Offscreen sendInputEvent targets a WebContents, not Chromium's native
  // cross-process hit-test router. Check host hit testing, then send to that guest.
  const guestPoint={x:Math.round(buttonPoint.x),y:Math.round(buttonPoint.y)};
  guest.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...guestPoint});
  guest.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...guestPoint});
  await pause();
  assert.equal(await guest.executeJavaScript('window.pageClicks'),1,'native webview still receives bottom-page input beside the capsule');
  const appClass=await run('document.querySelector(".app").className');
  await run('document.querySelector(".app").className="app theme-dark"');await pause();
  fs.writeFileSync(path.join(root,'tmp','inspector-cover-glass-dark.png'),(await window.webContents.capturePage()).toPNG());
  await run(`document.querySelector('.app').className=${JSON.stringify(appClass)}`);
  await run('coverLayout(true)'); await pause();
  const originalSize=window.getSize();
  window.setSize(1000,800); await pause(); await assertContentWidth(true);
  window.webContents.setZoomFactor(1.25); await pause(); await assertContentWidth(true);
  window.webContents.setZoomFactor(1); window.setSize(640,800); await pause(); await assertContentWidth(true);
  assert.equal(await run('Array.from(document.querySelectorAll(".inspector-tile-drag")).every(handle=>handle.getBoundingClientRect().width>0)'),true,'narrow layouts keep drag handles visible');
  window.setSize(...originalSize); await pause();
  const inputPoint=await run('(()=>{const r=document.querySelector("#cover-input").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...inputPoint});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...inputPoint});
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
  await until('document.querySelector(".quick-input-status")?.textContent.includes("正在处理")','quick input reports the live turn');
  assert.ok(await run('document.querySelector(".inspector-quick-input").getBoundingClientRect().height<100'),'collapsed status and single-line input share a compact surface');
  await run('window.retainedQuickComposer=document.querySelector(".inspector-quick-input textarea");void 0');
  await pause(250);fs.writeFileSync(path.join(root,'tmp','inspector-quick-input-working.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.querySelector(".quick-input-status").click()');
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("quick message")','status expands a conversation preview above the input');
  assert.equal(await run('coverWorkspace.inspectorControlsVisible && document.querySelector(".main-stage").inert'),true,'preview leaves the covered conversation and browser layout unchanged');
  assert.equal(await run('document.querySelector(".inspector-quick-input textarea")===retainedQuickComposer'),true,'expansion keeps the same composer in place');
  assert.equal(await run('document.querySelectorAll("[data-composer-input]").length'),1,'preview never creates a second composer');
  assert.equal(await run('coverStops'),0,'viewing progress never cancels the turn');
  assert.equal(await guest.executeJavaScript('window.pageClicks'),1,'preview preserves the browser document');
  await run('document.querySelector(".quick-input-status").click()');
  await until('document.querySelector(".quick-input-transcript")?.hidden','preview collapses in place');
  await run('coverUpdate({error:"fixture request failed"})');await until('document.querySelector(".quick-input-status")?.dataset.state==="error"','quick input exposes failures');
  await run('coverUpdate({error:null,interactionContent:"fixture permission"})');await until('document.querySelector(".quick-input-status")?.textContent.includes("等待你的处理")','permission wait has an expansion entry even without a composer');
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("fixture permission")','required interactions are reachable in the preview');
  await run('coverUpdate({interactionContent:null})');await until('!!document.querySelector(".inspector-quick-input .send-button svg.lucide-square")','composer returns after pending interaction');
  await run('document.querySelector(".inspector-quick-input .send-button").click()');
  await until('coverStops===1','original stop callback');
  await run('coverUpdate({messages:[{id:"answer",role:"assistant",content:"检查完成，这是本次回复。",status:"completed",turnId:"cover-turn",createdAt:new Date().toISOString()}]})');
  await until('document.querySelector(".quick-input-status")?.textContent.includes("已回复")','completion remains visible until expanded');
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("检查完成，这是本次回复。")','preview follows the same live response');
  fs.writeFileSync(path.join(root,'tmp','inspector-cover-quick-input.png'),(await window.webContents.capturePage()).toPNG());
  await require('./quick-input-preview.cjs')({run,until,pause,window,root});
  await run('coverUpdate({draft:"return draft"});document.querySelector("#cover-back").click()');
  await until('!document.querySelector(".inspector-covered") && !!document.querySelector(".main-stage textarea[data-composer-input]")','Back returns composer to conversation');
  assert.equal(await run('document.querySelector(".main-stage textarea[data-composer-input]").value'),'return draft');
  assert.ok(await run('document.querySelector(".main-stage .message-list").textContent.includes("检查完成，这是本次回复。")'),'expanded conversation shows the reply');
  await until('Math.abs(document.querySelector(".right-inspector-content").getBoundingClientRect().width-499)<2','Back restores the original inspector width');
  assert.equal(await run('document.body.classList.contains("right-inspector-resizing")'),false);
  await until('localStorage.getItem("cardbush.inspector_split_width")==="500"','restored usable split is observed before covering it again');
  await run('coverWorkspace.setSidebarCollapsed(false);coverWorkspace.setInspectorWidth(innerWidth)');
  await until('coverWorkspace.conversationCovered && !!document.querySelector("#cover-back")','oversized docked width exposes recovery capsule');
  assert.equal(await run('coverWorkspace.inspectorCover'),false,'recovery also works without explicit cover mode');
  assert.equal(await run('getComputedStyle(document.querySelector(".right-inspector-resizer")).display'),'none','a hidden conversation has no second nonfunctional divider');
  assert.equal(await run('getComputedStyle(document.querySelector(".right-inspector")).borderLeftWidth'),'0px','no duplicate line next to the sidebar');
  await until(`(()=>{const p=document.querySelector('.right-inspector').getBoundingClientRect(),c=document.querySelector('.inspector-cover-capsule').getBoundingClientRect();return Math.abs((p.left+p.right-c.left-c.right)/2)<3;})()`,'capsule centered in pane, excluding sidebar');
  await run('document.querySelector("#cover-input").click()');
  await until('!!document.querySelector(".inspector-quick-input textarea")','recovered quick input');
  assert.equal(await run('document.querySelector(".inspector-quick-input textarea").value'),'return draft','recovery keeps conversation draft');
  fs.writeFileSync(path.join(root,'tmp','inspector-recovery-capsule.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.querySelector("#cover-back").click()');
  await until('document.querySelector(".main-stage").clientWidth>=340 && !document.querySelector("#cover-back")','Back restores usable split');
  await pause(300);
  assert.equal(await run('!coverWorkspace.conversationCovered && document.querySelector(".main-stage").clientWidth>=340'),true,'restore stays expanded after the layout animation');
  assert.equal(await run('coverWorkspace.inspectorWidth'),500,'Back restores last usable width');
  await run('coverWorkspace.setInspectorWidth(innerWidth)');
  await until('!!document.querySelector("#cover-back")','cover again');
  await run('coverWorkspace.setInspectorOpen(false)');
  await until('!document.querySelector("#cover-back")','closed inspector has no stale capsule');
  await pause(320);
  assert.equal(await run('document.querySelector(".right-inspector").inert'),true,'closed inspector cannot receive input');
  assert.equal(await run('document.querySelector(".right-inspector").getBoundingClientRect().width'),0,'closed inspector releases its layout space');
  assert.equal(guest.isDestroyed(),false,'closed inspector retains its native page past the exit animation');
  await run('coverWorkspace.setInspectorOpen(true)');
  await until('!!document.querySelector("#cover-back")','opening with remembered large width offers recovery');
  assert.equal(await run('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()'),guestId,'reopening reuses the native page');
  // An oversized width from a larger monitor must restore a usable split.
  await run('renderView(h(CoverFixture,{key:"saved-width",startSidebarCollapsed:false}))');
  await until('document.querySelector(".main-stage").clientWidth>=340 && !document.querySelector("#cover-back")','saved width fits the current window without hiding chat');
  assert.equal(await run('document.querySelector(".main-stage textarea[data-composer-input]").value'),'keep draft');
  await run('coverWorkspace.enterInspectorCover()'); await pause();
  window.setSize(640,800); await pause();
  await clickSidebar();await pause(300);
  assert.ok(await run('(()=>{const r=document.querySelector(".sidebar").getBoundingClientRect();return r.width>200&&r.right<innerWidth&&document.querySelector(".sidebar").contains(document.elementFromPoint(r.left+40,r.top+20));})()'),'cover drawer remains reachable in a narrow window');
  await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await pause(250);
  await run('document.querySelector("#cover-back").click()');
  await until('!coverWorkspace.inspectorOpen && !document.querySelector("#cover-back")','narrow Back closes pane when split cannot fit');
  const retainedGuest=await run('document.querySelector("webview").getWebContentsId()');
  for(const width of [900,640]) {
    window.setSize(width,800); await pause(300);
    await run('coverWorkspace.setInspectorWidth(500);coverWorkspace.setInspectorOpen(true);coverWorkspace.setSidebarCollapsed(false)');
    await pause(300);
    assert.equal(await run('coverWorkspace.inspectorControlsVisible'),false,'ordinary responsive overlay has no cover controls');
    await run('document.querySelector("#sidebar-conversation").click()');
    await until('!coverWorkspace.inspectorOpen && coverWorkspace.section==="assistant"','navigation reveals the selected conversation instead of leaving the browser above it');
    await pause(300);
    assert.equal(await run('document.querySelector("webview").getWebContentsId()'),retainedGuest,'navigation hides the page without destroying it');
  }
  window.setSize(...originalSize); await pause();
  await run('coverWorkspace.setInspectorWidth(500);coverWorkspace.setInspectorOpen(true)');await pause(300);
  await run('document.querySelector("#sidebar-conversation").click()');await pause(300);
  assert.equal(await run('coverWorkspace.inspectorOpen && coverWorkspace.inspectorWidth===500'),true,'wide navigation preserves a usable split');
  await require('./inspector-window-layout.cjs')({run,until,pause,window,root});
  console.log('Inspector recovery passed: persisted/clamped widths, real composer, sidebar hit testing, drag recovery, reopen, safe split restore and narrow-window return.');
  console.log('Inspector cover passed: real pointer drag, full inner/tile widths, single/multi-page, window resize and 125% renderer zoom, narrow drag handles, native bar retained, Composer and original-width restoration.');
  await require('./inspector-workspace.cjs')({run,until,pause});
};
