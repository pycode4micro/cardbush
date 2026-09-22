const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  assert.match(main, /function createWindow[\s\S]*?minWidth: 480,\s*minHeight: 480,/);
  await run(`
    {
    const {useState} = require(${JSON.stringify(require.resolve('react'))});
    const noop = () => {};
    Object.assign(window.cardbushDesktop,{platform:${JSON.stringify(process.platform)},isMaximized:async()=>false,
      minimize:noop, toggleMaximize:async()=>false, closeToTray:noop});
    window.compactSettings = {managedModelConfigs:[], terminal:{runtime:'powershell'}, proxy:{mode:'none'}};
    window.CompactFixture = function CompactFixture() {
      const layout = views.useCompactSidebar();
      const [draft, setDraft] = useState('保留输入草稿'), [history, setHistory] = useState(false);
      const [inspector, setInspector] = useState(false), [settings, setSettings] = useState(false);
      const [theme, setTheme] = useState('dark');
      const presence = views.useSoftPanelPresence(!layout.sidebarCollapsed);
      window.compactState = { ...layout, draft, inspector, settings };
      window.compactActions = {setDraft, setHistory, setInspector, setSettings, setTheme};
      const close = () => layout.setSidebarCollapsed(true);
      const toggle = () => layout.setSidebarCollapsed(value => !value);
      const actions = {newConversation:noop,openSettings:()=>setSettings(true),showShortcuts:noop,openDiagnostics:noop,
        toggleSidebar:toggle,toggleInspector:()=>setInspector(value=>!value),search:noop,openBrowser:noop};
      return h('div', {className:'app theme-'+theme,style:{height:'100vh','--sidebar-width':'272px'}},
        h(views.WindowFrame,{language:'zh',sidebarCollapsed:layout.sidebarCollapsed,onToggleSidebar:toggle,
          menus:views.applicationMenus('zh',actions,{sidebarVisible:!layout.sidebarCollapsed,inspectorVisible:inspector,native:false,externalLinks:false}),onError:noop}),
        settings && h(views.SettingsView,{active:true,onReady:noop,themePreference:theme,language:'zh',languageMode:'zh',systemLanguage:'zh',settings:compactSettings,
          selectedModel:'fixture',availableModels:[],backendCapabilities:{terminalRuntimes:['powershell'],runtimeAssetCategories:[]},runtimeBusy:false,conversations:[],skills:[],disabledSkillNames:new Set(),
          initialSection:'runtime',initialPluginTab:'plugins',onBack:()=>setSettings(false),onThemePreferenceChange:noop,onLanguageModeChange:noop,
          onSettingsChange:noop,onUseModel:noop,sidebarCollapsed:layout.sidebarCollapsed,compactLayout:layout.compactLayout,sidebarPresence:presence,sidebarWidth:272,
          onSidebarCollapse:close,onSidebarWidthChange:noop,onToggleSkill:noop,onReloadSkills:async()=>[],onLoadSkillDetail:async()=>({})}),
        h('main',{className:'desktop-shell'+(layout.sidebarCollapsed?' sidebar-is-collapsed':'')+(settings?' app-content-suspended':''),inert:settings},
          h(views.CompactSidebarBackdrop,{visible:layout.compactLayout&&!layout.sidebarCollapsed,language:'zh',onClose:close}),
          presence.mounted&&h(views.ChatSidebar,{language:'zh',section:'chat',activeConversationId:'draft',projects:[],
            conversations:[{id:'draft',title:'今天有更新邮件么',preview:'',updatedAt:''}],changeReportsByConversation:{},softVisible:presence.visible,
            onSectionChange:close,onConversationChange:()=>{setHistory(true);if(layout.compactLayout)close();},onCreateConversation:()=>{setHistory(false);if(layout.compactLayout)close();},
            onAddProject:noop,onProjectAction:noop,onDeleteConversation:noop,onRenameConversation:async()=>true,onOpenConversationChanges:noop,onOpenSettings:()=>{close();setSettings(true);},onOpenPlugins:noop,onOpenSearch:noop}),
          h('section',{className:'main-stage',inert:layout.compactLayout&&(!layout.sidebarCollapsed||inspector)},h(views.ChatPanel,{...chatProps,
            language:'zh',theme,loading:false,sidebarCollapsed:layout.sidebarCollapsed,draft,onDraftChange:setDraft,selectedModel:'long-model',
            availableModels:[{id:'long-model',provider:'deepseek',modelName:'deepseek-v4-1-with-a-long-name',apiKey:'',baseUrl:''}],
            inspectorOpen:inspector,onToggleInspector:()=>setInspector(value=>!value),
            messages:history?[{id:'one',role:'user',content:'今天有更新邮件么',createdAt:'2026-09-21T12:00:00Z'},
              {id:'two',role:'assistant',content:'文件已经更新。\\n\\n'+('这里是用于验证小窗口换行和滚动的历史消息。'.repeat(60)),createdAt:'2026-09-21T12:00:01Z'}]:[]})),
          inspector&&h('aside',{className:'right-inspector',style:{'--right-inspector-width':'620px'}},h('div',{className:'right-inspector-viewport'},
            h('div',{className:'right-inspector-content'},h('header',{className:'right-inspector-toolbar'},h('strong',null,'预览'),h('button',{'aria-label':'关闭预览',onClick:()=>setInspector(false)},'×')),
              h('div',{className:'source-inspector-document'},h('pre',{className:'source-plain-text'},'预览文件内容。'.repeat(100))))))));
    };
    renderView(h(CompactFixture));
    // The shared harness wraps views at a fixed width; this case uses the real viewport.
    const host = document.querySelector('#root > .app');
    host.style.width = '100%'; host.className = 'compact-fixture-host';
    }
  `);
  const fits = async selector => {
    const rect = await run(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    const viewport = await run('({width:innerWidth,height:innerHeight})');
    assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= viewport.width + 1 && rect.top >= -1 && rect.bottom <= viewport.height + 1,
      `${selector} fits: ${JSON.stringify({rect,viewport})}`);
  };
  const resize = async (width, height) => { window.setSize(width, height); await pause(380); };
  await until("!!document.querySelector('.welcome-composer')", 'initial welcome');
  assert.equal(await run('compactState.sidebarCollapsed'), false);
  for (const [width, height] of [[750,620],[560,520],[480,480]]) {
    await resize(width,height);
    assert.equal(await run('compactState.sidebarCollapsed'), true, JSON.stringify(await run('({width:innerWidth,height:innerHeight,compact:compactState.compactLayout, media:matchMedia("(max-width: 760px)").matches, errors:failures})')));
    await fits('.window-frame'); await fits('.welcome-input-stack'); await fits('.composer-footer');
    await fits('.composer-actions button:last-child');
    await fits('.window-frame-menu-group');
    assert.ok(await run("document.querySelector('.window-frame-menu-group').getBoundingClientRect().right <= document.querySelector('.window-frame').getBoundingClientRect().right - parseFloat(getComputedStyle(document.querySelector('.window-frame')).paddingRight)"), 'menus avoid native caption buttons');
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'no page horizontal overflow');
  }
  await run("document.querySelector('.window-sidebar-toggle').click()");
  await until('compactState.sidebarCollapsed === false', 'open narrow drawer');
  await pause(260); await fits('.sidebar'); await fits('.main-stage');
  assert.ok(await run("document.querySelector('.main-stage').getBoundingClientRect().width > innerWidth-4"), 'drawer does not squeeze the chat');
  await run("document.querySelector('.compact-sidebar-backdrop').click()");
  await until('compactState.sidebarCollapsed', 'backdrop closes drawer');
  await run("document.querySelector('.window-sidebar-toggle').click()"); await pause(260);
  await run("document.querySelector('.conversation-row').click()");
  await until("!!document.querySelector('.message-list') && compactState.sidebarCollapsed", 'history selection closes drawer');
  await fits('.composer-surface');
  assert.equal(await run('compactState.draft'), '保留输入草稿');
  await run("compactActions.setDraft('长输入文本 '.repeat(150))"); await pause(150);
  await fits('.composer-footer'); await fits('.composer-surface');
  await run('compactActions.setInspector(true)'); await pause(150);
  await fits('.right-inspector'); await fits('.right-inspector-content');
  await run("document.querySelector('[aria-label=关闭预览]').click()");
  await until('!compactState.inspector', 'close preview');
  await run('compactActions.setSettings(true)');
  await until("!!document.querySelector('.settings-content')", 'small settings');
  await fits('.settings-content');
  assert.ok(await run("document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth+1"), 'settings fit horizontally');
  await run("document.querySelector('.window-sidebar-toggle').click()"); await pause(260);
  await fits('.settings-sidebar');
  await run("document.querySelector('[data-settings-section=proxy]').click()");
  await until('compactState.sidebarCollapsed', 'settings choice closes drawer');
  await fits('.settings-content');
  await run('compactActions.setSettings(false); compactActions.setDraft("保留输入草稿")');
  await resize(1180,760);
  assert.equal(await run('compactState.sidebarCollapsed'), false, 'wide sidebar preference restored');
  await run('compactState.setSidebarCollapsed(true)'); await pause(260);
  await resize(480,480);
  await run("document.querySelector('.window-sidebar-toggle').click()"); await pause(260);
  await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until('compactState.sidebarCollapsed', 'Escape closes drawer');
  await resize(1180,760);
  assert.equal(await run('compactState.sidebarCollapsed'), true, 'collapsed wide preference is also retained');
  await resize(480,480);
  fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
  for (const theme of ['dark','bright']) {
    await run(`compactActions.setTheme(${JSON.stringify(theme)})`); await pause(160);
    await fits('.composer-surface');
    fs.writeFileSync(path.join(root,`tmp/compact-window-${theme}.png`),(await window.webContents.capturePage()).toPNG());
  }
  console.log('Compact window UI passed: 480x480, 560x520, 750x620; welcome/history/composer, drawer, inspector, settings, draft and wide-layout preservation.');
};
