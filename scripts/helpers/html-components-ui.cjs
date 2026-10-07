const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ run, until, pause, window, root }) => {
  for (const file of ['src/features/inspector/inspectorWorkspace.css','src/features/components/components.css','src/features/components/welcomeLayout.css']) await window.webContents.insertCSS(fs.readFileSync(path.join(root,file),'utf8'));
  await run(`
    window.componentEvents=[];window.componentReports=[];
    addEventListener('message',e=>{if(e.data?.test==='component-ready')componentReports.push(e.data);});
    window.componentHost={revision:'session-a',sessionId:'session-a',language:'zh',running:false,
      fill:text=>componentEvents.push(['fill',text]),send:async text=>{componentEvents.push(['send',text]);},openBrowser:url=>componentEvents.push(['browser',url])};
    window.componentHtml='<h1>HTML component</h1><textarea id="draft">saved draft</textarea><script>cardbush.ready.then(async context=>{try {await cardbush.state.write({draft:"kept"}); const results=await Promise.all([cardbush.invoke("conversation.send",{text:"component task"},"once"),cardbush.invoke("conversation.send",{text:"component task"},"once")]); parent.postMessage({test:"component-ready",context,results},"*");}catch(error){parent.postMessage({test:"component-ready",error:error.message},"*");}});</script>';
    window.component={id:'fixture',title:'Fixture',html:componentHtml,allowActions:true,width:6,height:280,order:0};
    window.componentActive=true;
    window.showSurface=()=>renderView(h(views.HtmlComponentContext.Provider,{value:componentHost},h('div',{style:{height:400}},h(views.HtmlComponentSurface,{component,active:componentActive}))));
    showSurface();
  `);
  await until('componentReports.length>0','HTML SDK handshake and actions');
  assert.deepEqual(await run('componentEvents'),[['send','component task']],'duplicate action key submits once');
  assert.equal(await run('componentReports[0].results[0].status'),'accepted');
  assert.equal(await run('JSON.parse(localStorage.getItem("cardbush.component-state.fixture")).draft'),'kept');
  const guest=window.webContents.mainFrame.framesInSubtree.find(frame=>frame.url==='about:srcdoc');
  assert.ok(guest,'HTML runs in its own sandbox frame');
  assert.deepEqual(await guest.executeJavaScript('[typeof require,typeof window.cardbushDesktop]'),['undefined','undefined']);
  assert.equal(await run('document.querySelector(".html-component-frame").sandbox.value'),'allow-scripts');
  assert.equal(await guest.executeJavaScript('document.querySelector("meta[http-equiv]").content.includes("connect-src \'none\'")'),true);
  const firstColor=await guest.executeJavaScript('getComputedStyle(document.documentElement).color');
  await run('document.querySelector(".app").style.setProperty("--text","rgb(12, 34, 56)"); void 0');
  await pause();
  assert.equal(await guest.executeJavaScript('getComputedStyle(document.documentElement).color'),'rgb(12, 34, 56)');
  assert.notEqual(firstColor,'rgb(12, 34, 56)');
  await run('document.querySelector(".app").style.removeProperty("--text");void 0');
  await run('document.documentElement.dataset.reduceMotion="true";void 0');await pause();
  assert.equal(await guest.executeJavaScript('document.documentElement.dataset.reduceMotion'),'true');
  await run('delete document.documentElement.dataset.reduceMotion;void 0');
  await guest.executeJavaScript('location.href="https://example.invalid/component-navigation";void 0');
  await pause();
  assert.equal(guest.url,'about:srcdoc','Electron navigation guard retains the controlled HTML document');
  await run('componentActive=false;showSurface()');await pause();
  assert.equal(await guest.executeJavaScript('cardbush.invoke("conversation.send",{text:"editing"}).then(()=>"bad",e=>e.message)'),'INACTIVE_SURFACE');
  await run('componentActive=true;showSurface()');await pause();
  assert.equal(await guest.executeJavaScript('cardbush.invoke("conversation.send",{text:"component task"},"once").then(x=>x.status)'),'accepted');
  assert.equal(await run('componentEvents.length'),1,'editing retains action deduplication');
  await guest.executeJavaScript('cardbush.context.revision="stale";void 0');
  assert.equal(await guest.executeJavaScript('cardbush.invoke("conversation.send",{text:"stale"}).then(()=>"bad",e=>e.message)'),'STALE_CONTEXT');
  await run('component={...component,id:"readonly",allowActions:false}; componentReports=[]; showSurface();');
  await until('componentReports.length>0','read-only component callback');
  assert.equal(await run('componentReports[0].error'),'CAPABILITY_DENIED');
  assert.equal(await run('componentEvents.length'),1);
  await run(`
    window.canvasSnapshot={version:1,revision:0,items:[{...component,id:'canvas-a',html:'<p>Canvas A</p>'},{...component,id:'canvas-b',title:'Second',order:1,html:'<p>Canvas B</p>'}]};
    views.saveComponents(canvasSnapshot,0);
    window.showComponents=()=>renderView(h(views.HtmlComponentContext.Provider,{value:componentHost},h(views.ComponentsApp,{language:'zh'})));
    showComponents();
  `);
  await until('document.querySelectorAll(".html-component-frame").length===2','component canvas');
  await run(`
    window.outerCancelCount=0;
    renderView(h('dialog',{className:'cancel-test-parent',ref:node=>{if(node&&!node.open)node.showModal()},
      onCancel:views.dialogEventHandler(event=>{event.preventDefault();outerCancelCount++}),style:{width:900,height:650}},
      h(views.HtmlComponentContext.Provider,{value:componentHost},h(views.ComponentsApp,{language:'zh'}))));
  `);
  const importButton = await run(`(()=>{const rect=[...document.querySelectorAll('.components-app > header button')].find(x=>x.textContent==='自定义组件').getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`);
  // A real gesture gives the nested modal its own Chromium CloseWatcher group.
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...importButton});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...importButton});
  await until('!!document.querySelector(".component-import:modal")','component import opens');
  await run(`
    {
    const input=document.querySelector('.component-import input:not([type])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'未保存的组件');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.component-import input[type=file]').dispatchEvent(new Event('cancel',{bubbles:true}));
    }
    void 0;
  `);
  await pause();
  assert.equal(await run('!!document.querySelector(".component-import:modal")'),true,'cancelling file selection must retain component import');
  assert.equal(await run('outerCancelCount'),0,'file cancellation does not dismiss the containing dialog either');
  assert.equal(await run('document.querySelector(".component-import input:not([type])").value'),'未保存的组件','file cancellation retains unsaved draft');
  await run(`
    {
    const files=new DataTransfer();files.items.add(new File(['<main>导入内容</main>'],'example.html',{type:'text/html'}));
    const input=document.querySelector('.component-import input[type=file]');input.files=files.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    } void 0;
  `);
  await until('document.querySelector(".component-import textarea").value.includes("导入内容")','file import still works');
  await run('document.querySelector(".component-import input[type=file]").dispatchEvent(new Event("cancel",{bubbles:true}));void 0');
  assert.equal(await run('document.querySelector(".component-import textarea").value'),'<main>导入内容</main>','cancel/reselect retains imported HTML');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector(".component-import")','Escape still closes the component dialog');
  assert.equal(await run('outerCancelCount'),0,'Escape on a nested dialog must not cancel its parent');
  assert.equal(await run('document.querySelector(".cancel-test-parent").open'),true);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('outerCancelCount===1','the parent still handles its own Escape');
  await run('showComponents()');
  await run('[...document.querySelectorAll("button")].find(x=>x.textContent==="编辑布局").click();');
  await until('!!document.querySelector(".welcome-layout-editor")','new conversation layout edit');
  assert.equal(await run('document.querySelectorAll("[data-welcome-component]").length'),4,'editor starts with the welcome page, not the component catalog');
  await run('[...document.querySelectorAll(".welcome-layout-toolbar button")].find(x=>x.textContent==="取消").click();');
  await until('!!document.querySelector(".components-grid")','cancel returns to component catalog');
  await pause();
  fs.writeFileSync(path.join(root,'tmp','html-components-canvas.png'),(await window.webContents.capturePage()).toPNG());
  await run('localStorage.setItem("cardbush.component-state.canvas-a","{}");views.saveComponents({...canvasSnapshot,items:[]},1);');
  assert.equal(await run('localStorage.getItem("cardbush.component-state.canvas-a")'),null,'removing a saved component clears only its state');
  await run('renderView(h(views.BrowserBookmarkButton,{address:"https://example.test/a",title:"Example",language:"zh"}));');
  await until('!!document.querySelector(".inspector-bookmark-button")','bookmark control');
  await run('document.querySelector(".inspector-bookmark-button").click();');
  await until('document.querySelector(".inspector-bookmark-button").getAttribute("aria-pressed")==="true"','bookmark saved');
  await run(`renderView(h(views.InspectorActions,{language:'zh',filesAvailable:false,shadowUnavailableReason:'',onOpenFiles:()=>{},onOpenShadow:()=>{},onOpenBrowser:()=>{},onAddPage:()=>{},onMultiPage:()=>{},onOpenBookmark:url=>componentEvents.push(['bookmark',url])}));`);
  await until('document.querySelector(".inspector-bookmark-entry")?.textContent==="Example"','bookmark in empty page');
  await run('document.querySelector(".inspector-bookmark-entry").click();');
  assert.deepEqual(await run('componentEvents.at(-1)'),['bookmark','https://example.test/a']);
  await run(`
    window.tileTabs=['a','b'].map(id=>({id,kind:'resource',detail:{target:'about:blank',title:id}}));
    window.tileLayout=views.addPanel(views.addPanel(null,'a'),'b');
    window.showTiles=()=>renderView(h('div',{className:'desktop-shell sidebar-is-collapsed inspector-multi-page',style:{height:650}},h('section',{className:'main-stage'}),h('aside',{className:'right-inspector',style:{'--right-inspector-width':'560px'}},h('div',{className:'right-inspector-body'},h(views.InspectorTabPages,{tabs:tileTabs,activeId:'a',layout:tileLayout,onResize:(p,r)=>{tileLayout=views.resizePanelSplit(tileLayout,p,r);showTiles();},renderFrame:tab=>h('header',null,tab.id)},tab=>h('textarea',{'data-draft':tab.id,defaultValue:'draft '+tab.id}))))));
    showTiles();
  `);
  await until('document.querySelectorAll(".right-inspector-tab-page.active").length===2','two pages visible');
  await run('window.originalPage=document.querySelector("[data-draft=a]");originalPage.value="keep this";');
  await run('tileLayout=views.resizePanelSplit(tileLayout,"",.65);showTiles();');await pause();
  assert.equal(await run('document.querySelector("[data-draft=a]")===originalPage'),true);
  assert.equal(await run('document.querySelector("[data-draft=a]").value'),'keep this');
  const positions=await run(`(()=>{const a=document.querySelector('[data-inspector-page-id=a]').getBoundingClientRect(),b=document.querySelector('[data-inspector-page-id=b]').getBoundingClientRect();return {ratio:a.width/(a.width+b.width),overlap:a.right>b.left+1};})()`);
  assert.ok(Math.abs(positions.ratio-.65)<.01);assert.equal(positions.overlap,false);
  await run('tileLayout=views.swapPanels(tileLayout,"a","b");showTiles();');await pause();
  assert.equal(await run('document.querySelector("[data-draft=a]")===originalPage'),true);
  await run('tileLayout=null;showTiles();');await pause();
  assert.equal(await run('document.querySelectorAll(".right-inspector-tab-page.active").length'),1);
  assert.equal(await run('document.querySelector("[data-draft=a]")===originalPage'),true);
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp','html-component-workspace.png'),(await window.webContents.capturePage()).toPNG());
  console.log('HTML components/workspace UI passed: sandbox SDK, explicit actions, deduplication, stale context, theme, retained resize/cancel state, bookmarks, multi-page partition and stable page DOM.');
};
