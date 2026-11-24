const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  window.setSize(1120, 780);
  window.webContents.focus();
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/components/global-tooltip.css'), 'utf8'));
  await window.webContents.insertCSS('.app{width:100%!important}.apps-fixture{display:flex;height:calc(100vh - 36px)}.apps-fixture>.chat-panel{flex:1;min-width:0}');
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'assets/plugins/browser/extension/icons/cardbush-32.png')).toString('base64');
  await run(`
    window.appEvents=[]; window.appReferences=[]; window.appErrors=[]; window.localOpened=[]; window.localPicks=[];
    window.localSelection=null; window.localOpenError='';
    window.cardbushDesktop.openExternal=async url=>appEvents.push(['external',url]);
    window.cardbushDesktop.showErrorDialog=async error=>appErrors.push(error);
    window.localFixture={id:'local:editor',title:'本地编辑器',path:'C:/Program Files/编辑器/editor.exe',icon:${JSON.stringify(icon)}};
    views.rememberBrowserSiteIconImage('http://localhost:8888',localFixture.icon);
    window.cardbushDesktop.localApplications={pick:async language=>{localPicks.push(language);return localSelection;},
      open:async target=>{if(localOpenError)throw Error(localOpenError);localOpened.push(target);}};
    window.appsHost={id:'fixture',environmentId:'cloud-demo', plugins:[{id:'demo',name:'Design plugin',description:'Design workspace',longDescription:'Design workspace',version:'1.0.0',developerName:'Fixture',category:'Tools',keywords:[],capabilities:[],defaultPrompts:[],installed:true,enabled:true,logoPath:'',logoDarkPath:'',manifestPath:'',components:[{kind:'app',id:'canvas',name:'Design canvas',app:{kind:'url',url:'https://example.test/canvas'}},{kind:'app',id:'slack',name:'Slack',mcp:{registeredAppId:'slack'}}]}],pluginCommands:[]};
    window.cardbushDesktop.agents={connect:async()=>({}),call:async()=>({plugins:appsHost.plugins})};
    window.mountApps=()=>renderView(h(views.ConversationHostContext.Provider,{value:appsHost},
      h(views.ApplicationLauncher,{language:'zh',onNavigate:(app,environment)=>appEvents.push(['navigate',app.id,environment])}),
      h(views.GlobalTooltip),h('div',{className:'apps-fixture'},h('aside',{className:'sidebar'},h(views.SidebarApplications,{language:'zh'})),h(views.ChatPanel,chatProps))));
    Object.assign(chatProps,{language:'zh',loading:false,historyLoading:false,draft:'',availableModels:[{id:'fixture',modelName:'fixture',provider:'fixture',enabled:true}],
      onDraftChange:draft=>{chatProps.draft=draft;mountApps();},onSend:async text=>{appReferences.push(text);chatProps.draft='';mountApps();}});
    window.viewTheme='theme-bright'; mountApps();void 0;
  `);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const trigger = '.sidebar-more-apps', list = '.sidebar-app-flyout:popover-open', search = '.sidebar-app-search input';
  const row = id => `[data-sidebar-app="${id}"]`;
  const open = async () => { await click(trigger); await until(`!!document.querySelector('${list}')`, 'More apps opens'); };
  const close = async () => {
    await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0`);
    await until(`!document.querySelector('${list}')`, 'More apps closes');
  };
  const fill = (selector, value) => run(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const prefs = field => run(`JSON.parse(localStorage.getItem('cardbush_app_center_v1')||'{}').${field}`);
  const dialog = '.application-link-dialog';
  const linkForm = async (title, url) => {
    await until(`!!document.querySelector('${dialog}:modal')`, 'link form opens');
    await fill(`${dialog} input[name=title]`, title);
    await fill(`${dialog} input[name=address]`, url);
    await click(`${dialog} button[type=submit]`);
  };
  await until(`!!document.querySelector('${trigger}')`, 'sidebar is ready');
  await run(`(()=>{const button=document.querySelector('${trigger}');button.focus();
    button.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse'}));
    button.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'}));})()`);
  await pause(350);
  assert.equal(await run(`document.querySelector('${trigger}').getAttribute('aria-expanded')`), 'false', 'focus, hover and arrow keys leave More apps closed');
  await open();
  await run(`(()=>{const button=document.querySelector('${trigger}');
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));button.click();})()`);
  await until(`!document.querySelector('${list}')`, 'clicking the same trigger toggles the menu closed');
  await open();
  await run("document.querySelector('.main-stage, .chat-panel').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0}));void 0");
  await until(`!document.querySelector('${list}')`, 'clicking outside dismisses the menu');
  await open();
  assert.deepEqual(await run("Array.from(document.querySelectorAll('[data-sidebar-app]'),node=>node.dataset.sidebarApp).sort()"),
    ['builtin:components','builtin:md-presentation','builtin:plugins','builtin:team','plugin:demo:canvas']);
  assert.equal(await run('document.activeElement.dataset.sidebarApp'), 'builtin:plugins', 'keyboard opening focuses the first app');
  await click(row('builtin:team'));
  await until("appEvents.some(event=>event[1]==='builtin:team') && !document.querySelector('.sidebar-app-flyout')", 'Team opens and dismisses the list');
  await open(); await fill(search, 'xyz-no-match');
  await until("!!document.querySelector('.sidebar-app-empty') && !document.querySelector('[data-sidebar-app]')", 'the list filters by query');
  await close(); await open(); assert.equal(await run(`document.querySelector('${search}').value`), 'xyz-no-match');
  await run('views.showMoreApplications()');
  await until(`document.querySelector('${search}')?.value===''`, 'a browser jump clears the old query');
  await click('.sidebar-app-add button:last-child');
  await linkForm('本地看板', 'file:///invalid');
  await until(`!!document.querySelector('${dialog} [role=alert]')`, 'non-HTTP app links are rejected');
  await linkForm('本地看板', 'http://localhost:8888/dashboard');
  await until(`!document.querySelector('${dialog}')`, 'valid link saves');
  const link = (await prefs('links'))[0];
  await open(); await until(`document.querySelector('${row(link.id)} img')?.naturalWidth>0`, 'link shows a site icon');
  await click(row(link.id));
  await until("appEvents.at(-1)?.[0]==='external'", 'external link opens only when selected');
  assert.deepEqual(await run('appEvents.at(-1)'), ['external', 'http://localhost:8888/dashboard']);
  await open(); await click(`[data-sidebar-app-edit="${link.id}"]`);
  await linkForm('团队看板', 'https://example.test/dashboard');
  await until(`!document.querySelector('${dialog}')`, 'edit saves');
  assert.deepEqual((await prefs('links'))[0], { ...link, title:'团队看板', url:'https://example.test/dashboard' });
  await open(); await click(`[data-sidebar-app-remove="${link.id}"]`);
  assert.deepEqual(await prefs('links'), []);
  assert.ok(await run(`document.activeElement.matches('${search}')`), 'removal restores focus to search');
  await click('.sidebar-app-add button:first-child');
  await until('localPicks.length===1 && !document.querySelector(".sidebar-app-add button:disabled")', 'canceling the picker settles');
  assert.equal((await prefs('localApps'))?.length ?? 0, 0);
  await run('localSelection=localFixture;void 0'); await click('.sidebar-app-add button:first-child');
  await until(`!!document.querySelector('${row('local:editor')} img')`, 'picked desktop shortcut appears');
  assert.deepEqual(await run('localOpened'), [], 'saving does not launch the shortcut');
  await click('.sidebar-app-add button:first-child');
  await until('localPicks.length===3 && !document.querySelector(".sidebar-app-add button:disabled")', 'repeated pick settles');
  assert.equal((await prefs('localApps')).length, 1);
  await close(); await run('renderView(null);void 0'); await pause(30); await run('mountApps();void 0');
  await until("!!document.querySelector('.sidebar-more-apps')", 'sidebar remounted');
  await open(); await click(row('local:editor'));
  await until('localOpened.length===1', 'saved native app launches after remount');
  assert.deepEqual(await run('localOpened'), [await run('localFixture.path')]);
  await run("localOpenError='应用已移动或不存在';void 0"); await open(); await click(row('local:editor'));
  await until("appErrors.at(-1)?.message==='应用已移动或不存在'", 'launch failure shows an actionable error');
  await run(`window.refreshedIcons=[];window.cardbushDesktop.localApplications.refreshIcons=async paths=>{refreshedIcons.push(paths);return {[localFixture.path]:localFixture.icon};};
    views.saveAppCenterPreferences({...JSON.parse(localStorage.getItem('cardbush_app_center_v1')),localApps:[{...localFixture,title:'自定义快捷方式',icon:undefined}]});void 0`);
  await open(); await until("JSON.parse(localStorage.getItem('cardbush_app_center_v1')).localApps[0]?.iconVersion===1", 'legacy icons refresh');
  assert.equal((await prefs('localApps'))[0].title, '自定义快捷方式');
  await close(); await open(); assert.equal(await run('refreshedIcons.length'), 1, 'cached icons are reused');
  await click('[data-sidebar-app-remove="local:editor"]'); assert.deepEqual(await prefs('localApps'), []);
  assert.equal(await run('localOpened.length'), 1, 'removing a shortcut does not launch its app');
  await close();
  await run(`const input=document.querySelector('textarea[data-composer-input]');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'@组件');input.setSelectionRange(3,3);input.dispatchEvent(new Event('input',{bubbles:true}));void 0`);
  await until(`!!document.querySelector('[data-command-id="application:builtin:components"]')`, 'composer still offers application references');
  const before = await run('appEvents.length');
  await run(`document.querySelector('[data-command-id="application:builtin:components"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));void 0`);
  await until("!!document.querySelector('[data-context-reference]')", 'application reference inserted');
  assert.equal(await run('appEvents.length'), before, 'selecting a reference cannot launch an app');
  await click('.send-button'); await until('appReferences.length===1', 'reference submitted');
  assert.match(await run('appReferences[0]'), /builtin%3Acomponents/);
  await run("views.requestApplication('plugin:demo:canvas','cloud-demo',{applicationKind:'plugin'});void 0");
  await until("appEvents.at(-1)?.[1]==='https://example.test/canvas'", 'remote plugin opens its declared URL');
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400}); await pause(40);
    await require('./tooltip-activation.cjs')({ run, until, pause, window });
    await require('./tooltip-titles.cjs')({ run, until, pause, window, root });
  } finally { window.webContents.debugger.detach(); }
  for (const [theme, width] of [['bright', 1120], ['dark', 640]]) {
    window.setSize(width, 740); await pause(120);
    await run(`window.viewTheme='theme-${theme}';mountApps();void 0`); await open();
    const bounds = await run(`(()=>{const r=document.querySelector('${list}').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);
    assert.ok(bounds, `More apps fits the ${theme} window`); await close();
  }
  console.log('More apps passed: keyboard, search, themes, links, local apps, legacy icon refresh, launch errors, references and tooltips.');
};
