const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/inspector/inspectorWorkspace.css'), 'utf8'));
  await window.webContents.insertCSS('.app{width:100%!important}.right-inspector-tab-pages{min-height:300px}');
  const page = 'data:text/html,' + encodeURIComponent('<title>Retained document</title><style>body{height:2400px}</style><input aria-label="Unsaved input"><script>window.ticks=0;setInterval(()=>ticks++,30)</script>');
  await run(`
    localStorage.setItem('cardbush.inspector_width','500');
    cardbushDesktop.onInspectorBrowserAction=listener=>{window.browserAction=listener;return()=>{window.browserAction=null;};};
    function SessionFixture(){
      const [session,setSession]=React.useState('a'),[sidebarCollapsed,setSidebarCollapsed]=React.useState(false),[section,setSection]=React.useState('chat');
      const scope=session.startsWith('ssh:')?views.agentInspectorWorkspace(session,'same-session'):views.localInspectorWorkspace(session);
      const tabs=views.useInspectorTabs(scope);
      const workspace=views.useInspectorWorkspace({workspaceId:scope,language:'zh',windowMaximized:false,compactLayout:false,
        section,setSection,sidebarCollapsed,sidebarWidth:240,setSidebarCollapsed,inspectorOpen:tabs.open,setInspectorOpen:tabs.setOpen,
        inspectorTabs:tabs.tabs,activeInspectorTab:tabs.activeTab,openInspectorTab:tabs.openTab,setInspectorTabsMenuOpen:()=>{}});
      const presence=views.useSoftPanelPresence(tabs.open,240,{keepMounted:true});
      const [navigation,setNavigation]=React.useState({});
      const update=React.useCallback((id,value)=>setNavigation(current=>({...current,[id]:value})),[]);
      views.useInspectorBrowserActions({open:tabs.openTab,activate:tabs.activateTab,close:(id,workspaceId)=>tabs.closeTabs(new Set([id]),workspaceId),
        workspace:(id,tabId)=>id?views.localInspectorWorkspace(id):tabs.ownerOfTab(tabId)||scope,show:workspaceId=>tabs.setOpen(true,workspaceId)});
      const portals=views.useConversationInspectorActions({open:(id,title)=>tabs.openTab({id,title,kind:'conversation'}),close:id=>tabs.disposeTabs(new Set([id]))});
      React.useEffect(()=>{window.portalMounts=(window.portalMounts||0)+1;return()=>{window.portalCleanups=(window.portalCleanups||0)+1;};},[portals.open,portals.close]);
      window.sessionFixture={tabs,workspace,navigation,session,scope,setSession,sidebarCollapsed,setSidebarCollapsed,portals};
      return h('main',{className:'desktop-shell'+(sidebarCollapsed?' sidebar-is-collapsed':'')+(workspace.inspectorCover?' inspector-covered':''),style:{'--sidebar-width':'240px'}},
        !sidebarCollapsed&&h('aside',{className:'sidebar'},'Conversations'),
        h('section',{className:'main-stage',ref:workspace.mainStageRef},h('button',{id:'new-scope',onClick:()=>setSession('b')},session)),
        (presence.mounted||tabs.allTabs.length>0)&&h('aside',{className:'right-inspector '+(presence.visible?'soft-panel-visible':'soft-panel-hidden'),
          'aria-hidden':!presence.visible,inert:!presence.visible,style:{'--right-inspector-width':workspace.inspectorWidth+'px'}},
          h('header',{className:'right-inspector-toolbar'},tabs.tabs.map(tab=>h('div',{className:'right-inspector-tab'+(tab.id===tabs.activeId?' active':''),key:tab.id,'data-tab':tab.id},
            h('button',{className:'right-inspector-tab-select',onClick:()=>tabs.activateTab(tab.id)},tab.id),
            h(views.InspectorTabLock,{language:'zh',locked:tabs.lockedIds.has(tab.id),onToggle:()=>tabs.toggleLock(tab.id)}),
            h('button',{className:'right-inspector-tab-close',onClick:()=>tabs.closeTabs(new Set([tab.id]))},'×')))),
          h('div',{className:'right-inspector-body'},h(views.InspectorTabPages,{workspaceId:scope,tabs:tabs.allTabs,activeId:tabs.activeId,layout:workspace.inspectorLayout},
            (tab,active)=>tab.kind==='resource'?h(views.InspectorWebview,{identity:tab.id,target:tab.detail.target,source:${JSON.stringify(page)},language:'zh',
              onNavigationStateChange:update,onOpenTarget:()=>{},onActivate:()=>{}}):h('div',{'data-task':tab.id},active?'Running task reply':'Background task')))));
    }
    renderView(h(SessionFixture));
  `);
  await until('!!window.sessionFixture', 'session fixture mounted');
  const portalCleanups = await run('window.portalCleanups');
  await run("browserAction({action:'open',tabId:'early-background',url:'https://background.invalid/',sessionId:'background'});void 0");
  await until('sessionFixture.navigation["early-background"]?.loading===false', 'first background guest mounts while inspector remains collapsed');
  assert.equal(await run('sessionFixture.tabs.open'), false);
  assert.equal(await run('sessionFixture.tabs.tabs.length'), 0);
  await run("sessionFixture.tabs.closeTabs(new Set(['early-background']),views.localInspectorWorkspace('background'));void 0");
  await until('sessionFixture.tabs.allTabs.length===0', 'early background page closes');
  const open = async id => {
    await run(`sessionFixture.tabs.openTab({id:${JSON.stringify(id)},kind:'resource',detail:{target:'https://example.invalid/'+${JSON.stringify(id)}}});sessionFixture.tabs.setOpen(true);void 0`);
    await until(`sessionFixture.navigation[${JSON.stringify(id)}]?.loading===false && !!document.querySelector('[data-inspector-page-id="${id}"] webview')`, 'ready ' + id);
  };
  await open('a-first');
  const guestId = await run('document.querySelector("[data-inspector-page-id=a-first] webview").getWebContentsId()');
  const guest = webContents.fromId(guestId);
  await guest.executeJavaScript(`document.querySelector('input').value='Do not lose me';window.marker='same document';history.pushState({step:1},'','#before');history.pushState({step:2},'','#after');scrollTo(0,400);void 0`);
  const snapshot = () => guest.executeJavaScript(`({url:location.href,value:document.querySelector('input').value,marker:window.marker,scroll:scrollY,history:history.length})`);
  const before = await snapshot();
  await open('a-second');
  await run("sessionFixture.tabs.activateTab('a-first'); sessionFixture.workspace.setInspectorLayout({kind:'split',axis:'y',ratio:.61,first:{kind:'page',id:'a-first'},second:{kind:'page',id:'a-second'}});void 0");
  await until('sessionFixture.workspace.inspectorLayout?.ratio===.61', 'layout saved');
  await run("window.oldActivate=sessionFixture.tabs.activateTab;window.oldSetLayout=sessionFixture.workspace.setInspectorLayout;sessionFixture.setSession('b');void 0");
  await until('sessionFixture.session==="b" && sessionFixture.tabs.tabs.length===0 && !sessionFixture.tabs.open', 'new workspace starts empty');
  assert.equal(await run('sessionFixture.workspace.inspectorLayout'), null);
  assert.equal(guest.isDestroyed(), false);
  await open('b-only');
  await run("oldActivate('a-second');oldSetLayout(tree=>({...tree,ratio:.64}));void 0");
  await pause();
  assert.equal(await run('sessionFixture.tabs.activeId'), 'b-only', 'delayed old callbacks cannot select a new conversation page');
  assert.equal(await run('sessionFixture.workspace.inspectorLayout'), null);
  await run("browserAction({action:'open',tabId:'a-background',url:'https://background.invalid/',sessionId:'a'});void 0");
  await until('sessionFixture.tabs.allTabs.length===4', 'background page mounted');
  assert.equal(await run('sessionFixture.tabs.activeId'), 'b-only');
  await run("sessionFixture.setSession('a');void 0");
  await until('sessionFixture.tabs.activeId==="a-background" && sessionFixture.workspace.inspectorLayout?.ratio===.64', 'previous selection and layout restored');
  await run("sessionFixture.tabs.activateTab('a-first');void 0");
  await pause();
  // Layout/background actions may change viewport geometry; check scroll once
  // the original split is restored, while every transition keeps the document.
  await guest.executeJavaScript('scrollTo(0,400);void 0');
  const retained = await snapshot();
  assert.equal(retained.marker, before.marker); assert.equal(retained.value, before.value);
  assert.equal(retained.url, before.url); assert.equal(retained.history, before.history);
  assert.equal(await run('sessionFixture.navigation["a-first"].loading'), false, 'changing host callbacks never restarts the guest readiness lifecycle');
  const lock = '[data-tab="a-first"] .right-inspector-tab-lock';
  assert.equal(await run(`document.querySelector('${lock}').nextElementSibling.className`), 'right-inspector-tab-close', 'lock is directly left of close');
  await run(`document.querySelector('${lock}').click();sessionFixture.workspace.setInspectorLayout(null);sessionFixture.setSession('personal-assistant');void 0`);
  await until('sessionFixture.tabs.tabs.length===1 && sessionFixture.tabs.activeId==="a-first" && sessionFixture.tabs.open', 'locked page follows assistant');
  await pause(300);
  assert.equal(await run('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()'), guestId);
  const tick = await guest.executeJavaScript('ticks');
  await run("sessionFixture.setSession('ssh:host-a');void 0"); await pause(200);
  assert.equal(await run('sessionFixture.tabs.tabs.length'), 1, 'locked page also follows SSH');
  await run(`document.querySelector('${lock}').click();void 0`);
  await until('sessionFixture.tabs.tabs.length===0', 'unlock removes foreign page from current workspace');
  assert.equal(guest.isDestroyed(), false, 'unlock leaves the owning document alive');
  assert.ok(await guest.executeJavaScript('ticks') > tick, 'hidden page work continues');
  await open('ssh-own');
  await run("sessionFixture.tabs.setOpen(false);sessionFixture.setSession('b');void 0"); await pause(300);
  assert.equal(await run('sessionFixture.tabs.activeId'), 'b-only');
  assert.equal(await run('sessionFixture.tabs.open'), true);
  await run("sessionFixture.setSession('ssh:host-a');void 0"); await pause(300);
  assert.equal(await run('sessionFixture.tabs.open'), false, 'remote collapsed state restores independently');
  await run("sessionFixture.setSession('ssh:host-b');void 0"); await pause();
  assert.equal(await run('sessionFixture.tabs.tabs.length'), 0, 'same remote session name on different hosts is isolated');
  await run("sessionFixture.setSession('a');void 0"); await pause(300);
  assert.equal(await run('sessionFixture.tabs.activeId'), 'a-first');
  assert.equal(await run('sessionFixture.tabs.allTabs.length'), 5);
  assert.equal(await run('document.querySelector("[data-inspector-page-id=a-first] webview").getWebContentsId()'), guestId);
  assert.deepEqual(await snapshot(), retained, 'regular split switches retain URL, input, JS, scroll and history');
  await run("sessionFixture.setSidebarCollapsed(false);void 0"); await pause();
  await run("sessionFixture.workspace.enterInspectorCover();void 0"); await until('sessionFixture.workspace.inspectorCover', 'cover a');
  await run("sessionFixture.setSession('b');void 0"); await until('!sessionFixture.workspace.inspectorCover && !sessionFixture.sidebarCollapsed', 'b does not inherit a cover or drawer');
  await run("sessionFixture.setSession('a');void 0"); await until('sessionFixture.workspace.inspectorCover && sessionFixture.sidebarCollapsed', 'a restores its cover');
  await run("sessionFixture.workspace.leaveInspectorCover();sessionFixture.tabs.closeTabs(new Set(['a-first']));void 0");
  await until('!sessionFixture.tabs.allTabs.some(tab=>tab.id==="a-first")', 'real close disposes original page');
  await pause(250); assert.equal(guest.isDestroyed(), true);
  assert.equal(await run('sessionFixture.tabs.allTabs.length'), 4, 'closing one workspace page retains the others');
  assert.equal(await run('window.portalCleanups'), portalCleanups, 'workspace switches and streams never trigger host portal cleanup');
  console.log('Inspector conversation UI passed: independent local/assistant/SSH workspaces, locks left of close, delayed/background routing, native document/history/draft/scroll retention, continuing work, cover/collapse restoration and actual disposal.');
};
