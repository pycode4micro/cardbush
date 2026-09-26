const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ run, until, pause, window, root }) => {
  window.setSize(1100, 820);
  for (const file of ['src/features/plugins/plugin-management.css', 'src/features/automations/automations.css']) await window.webContents.insertCSS(fs.readFileSync(path.join(root, file), 'utf8'));
  await run(`
    window.navPlugins=[{id:'fixture',name:'Fixture plugin',version:'1',description:'Fixture',longDescription:'Fixture details',defaultPrompts:[],source:'user',installed:true,enabled:true,config:{},components:[],keywords:[],capabilities:[]}];
    window.navHost={remote:false,supportsPluginConnections:true,fetchCardbushAppsConfiguration:async()=>({revision:1,serviceEnabled:true,plugins:navPlugins}),fetchMcpConnectionOverview:async()=>({revision:1,servers:[],snapshot:null})};
    window.navNoop=()=>{};window.navReload=async()=>[];
    window.navDeleted=new Set();window.navVisits=[];
    window.cardbushDesktop.automationCommand=async()=>({jobs:[]});
    window.cardbushDesktop.isMaximized=async()=>false;
    window.cardbushDesktop.runtimePluginRenderers=async()=>[{id:'fixture',name:'Fixture app',hash:'fixture',source:
      'export const apiVersion=1;export default()=>({apiVersion:1,getSnapshot:()=>({title:"Fixture app",selectedId:"",choices:[]}),subscribe:()=>()=>{},load:async()=>{},select(){},dispose(){},mount(root){const button=document.createElement("button");button.id="fixture-app-action";button.textContent="App action";button.onclick=()=>{window.navAppClicks=(window.navAppClicks||0)+1};root.append(button);return{update(){},dispose(){button.remove()}}}})'}];
    window.NavigationFixture=function(){
      const [page,setPage]=React.useState({section:'chat',id:'a'}),[revision,setRevision]=React.useState(0);
      const history=views.usePageNavigation(page,next=>{navVisits.push(next);setPage(next);},next=>!navDeleted.has(next.id));
      window.navHistory=history;window.navSetPage=setPage;window.navRefresh=()=>setRevision(value=>value+1);
      const back=history.canGoBack?history.back:undefined,forward=history.canGoForward?history.forward:undefined;
      const menus=views.applicationMenus('zh',{newConversation:navNoop,openSettings:navNoop,showShortcuts:navNoop,openDiagnostics:navNoop,toggleSidebar:navNoop,toggleInspector:navNoop,search:navNoop,openBrowser:navNoop,back,forward},{sidebarVisible:true,inspectorVisible:false,native:false,externalLinks:false});
      return h(views.PageNavigationContext.Provider,{value:history},h(views.PageNavigationScope.Provider,{value:'main:'+page.section},
        h(views.WindowFrame,{language:'zh',sidebarCollapsed:false,onToggleSidebar:navNoop,onBack:back,onForward:forward,menus,onError:error=>failures.push(String(error))}),
        h('nav',{id:'test-nav'},['chat','plugins','settings','automations','agents'].map(section=>h('button',{key:section,onClick:()=>setPage({section,id:section==='chat'?'a':section==='agents'?'cloud-a':undefined})},section))),
        h('output',{id:'current-route'},JSON.stringify(page)),h('span',{hidden:true},revision),
        page.section==='plugins'?h(views.SettingsHostContext.Provider,{value:navHost},h('div',{style:{height:680,overflow:'auto'}},h(views.PluginWorkspace,{capabilities:{},language:'zh',skills:[],disabledSkillNames:new Set(),onReloadSkills:navReload,onLoadSkillDetail:navReload,onToggleSkill:navNoop})))
        :page.section==='automations'?h(views.AutomationPanel,{language:'zh',onCreateAutomation:navNoop,onOpenConversation:navNoop})
        :page.section==='settings'?h('div',null,['appearance','runtime'].map(tab=>h('button',{key:tab,onClick:()=>setPage({section:'settings',tab})},tab)))
        :h('p',null,page.id)));
    };
    window.navClick=text=>{const button=[...document.querySelectorAll('button')].find(node=>node.checkVisibility()&&node.textContent.trim()===text);if(!button)throw Error('Missing '+text);button.click();};
    renderView(h(NavigationFixture));
  `);
  const back = () => run("document.querySelector('[data-history-action=back]').click()");
  const forward = () => run("document.querySelector('[data-history-action=forward]').click()");
  const route = value => until(`document.querySelector('#current-route')?.textContent.includes(${JSON.stringify(value)})`, `route ${value}`);
  await route('chat'); await pause(50);
  assert.equal(await run("document.querySelector('[data-history-action=back]').disabled"), true, 'StrictMode does not create visits');
  await run("navClick('plugins')"); await until("!!document.querySelector('.plugin-added-card')", 'plugin catalog');
  await run("document.querySelector('.plugin-added-card').click()");
  await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'plugin detail');
  await back(); await until("document.querySelector('[data-plugin-page=catalog]')?.checkVisibility()", 'Back restores plugin catalog');
  await forward(); await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'Forward restores plugin detail');
  await run("navClick('返回插件')"); await until("document.querySelector('[data-plugin-page=catalog]')?.checkVisibility()", 'in-page back uses same history');
  assert.equal(await run("document.querySelector('[data-history-action=forward]').disabled"), false);
  await forward(); await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'forward branch survives in-page back');
  await run("navClick('settings')"); await route('settings');
  await run("navClick('appearance')"); await route('appearance');
  await run("navClick('runtime')"); await route('runtime');
  await back(); await route('appearance'); await forward(); await route('runtime');
  await run("navClick('automations')"); await until("!!document.querySelector('.automation-calendar')", 'calendar page');
  await run("navClick('年')"); await until("document.querySelector('.automation-calendar')?.dataset.view==='year'", 'year view');
  await back(); await until("document.querySelector('.automation-calendar')?.dataset.view==='month'", 'calendar view Back');
  await forward(); await until("document.querySelector('.automation-calendar')?.dataset.view==='year'", 'calendar view Forward');
  await run("navClick('agents')"); await route('cloud-a');
  await run("navSetPage({section:'agents',id:'cloud-b'})"); await route('cloud-b');
  await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'[',ctrlKey:true,bubbles:true,cancelable:true}))"); await route('cloud-a');
  await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:']',ctrlKey:true,bubbles:true,cancelable:true}))"); await route('cloud-b');
  await run("navDeleted.add('cloud-a');navRefresh()"); await pause(30);
  await back(); await route('automations');
  await until("document.querySelector('.automation-calendar')?.dataset.view==='year'", 'remount preserves calendar route');
  await run("navRefresh();navRefresh();window.dispatchEvent(new Event('focus'))"); await pause(150);
  await forward(); await route('cloud-b');
  assert.equal(await run("document.querySelector('[data-history-action=forward]').disabled"), true, 'refresh adds no spurious entries');
  await back(); await route('automations');
  await run("navClick('chat')"); await route('chat');
  assert.equal(await run("document.querySelector('[data-history-action=forward]').disabled"), true, 'new visit replaces forward history');
  // Return to the older plugin details after the whole plugin surface was unmounted.
  await run("for(let visit=0;visit<6;visit++)navHistory.back()");
  await route('plugins'); await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'plugin details survive remount and rapid Back');
  await run("views.requestPluginApplication('fixture','fixture')");
  await until("document.querySelector('#fixture-app-action')?.checkVisibility()", 'app request mounts an operable renderer, not plugin settings');
  await run("document.querySelector('#fixture-app-action').click()");
  assert.equal(await run('navAppClicks'), 1);
  await run("views.requestPluginApplication('fixture','fixture')"); await pause(50);
  await back(); await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'back from actual app');
  await forward(); await until("document.querySelector('#fixture-app-action')?.checkVisibility()", 'forward reopens actual app');
  await run("navClick('chat')"); await route('chat');
  await back(); await until("document.querySelector('#fixture-app-action')?.checkVisibility()", 'app survives workspace remount');
  await back(); await until("document.querySelector('[data-plugin-page=plugin]')?.checkVisibility()", 'remount does not replay launcher request');
  console.log('Page navigation UI passed: real plugin details, shared Back/Forward, calendar, local/remote routes, shortcuts, StrictMode, remounts and refresh isolation.');
};
