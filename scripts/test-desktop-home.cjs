// Exercise the shipped renderer, worker, navigation and native chrome against an isolated desktop profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = require('electron');
const project = path.resolve(__dirname, '..');
if (typeof electron === 'string') {
  const directory = path.join(project, 'tmp'); fs.mkdirSync(directory, {recursive:true});
  const root = fs.mkdtempSync(path.join(directory, 'desktop-home-'));
  const env = {...process.env, APPDATA:root, LOCALAPPDATA:root, USERPROFILE:root, HOME:root,
    CARDBUSH_DEVELOPMENT_RUNTIME:'1', CARDBUSH_ELECTRON_DEV_SERVER_URL:''};
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = require('node:child_process').spawnSync(electron,[__filename,root],{cwd:project,env,windowsHide:true,stdio:'inherit',timeout:100000});
  if (run.error) throw run.error;
  assert.equal(run.status,0); console.log(root);
} else verify().catch(error => { console.error(error); electron.app.exit(1); });
async function verify() {
  const {app,BrowserWindow} = electron, root = process.argv[2];
  app.setPath('appData',root); app.setPath('userData',root); app.setAppPath(project);
  const friends = path.join(root,'runtime-state','friends'); fs.mkdirSync(friends,{recursive:true});
  const at = new Date().toISOString();
  const event = {id:'release',logicalKey:'release',origin:'agent',title:'版本发布周报',intent:'整理本周的发布进展',status:'completed',
    archived:false,revision:1,createdAt:at,updatedAt:at,inputs:[],result:{text:'发布准备完成。',turnId:'report',createdAt:at},
    presentation:{summary:'本周完成了桌面端回归验证。',cover:'tide',pages:[{id:'checks',title:'验证结果',layout:'facts',items:[{label:'桌面',text:'已通过'}]},{id:'renderer',parentId:'checks',componentId:'local-check',title:'渲染进程',layout:'article',items:[{label:'回归',text:'完成'}]}]}};
  fs.writeFileSync(path.join(friends,'events.json'),JSON.stringify({version:1,events:[event,{...event,id:'archived',archived:true,title:'Archived fixture'}],signals:[],detections:[]}));
  const scheduler = path.join(root, 'runtime-state', 'scheduler');
  fs.mkdirSync(scheduler, {recursive:true});
  const previous = '2024-03-10T12:00:00Z';
  fs.writeFileSync(path.join(scheduler, 'automations.json'), JSON.stringify({version:1,
    contexts:{original:{title:'原项目',model:'fixture',prefixMessages:[],tools:[],permissionMode:'task_free',metadata:{},requestCapabilities:{interactiveRequests:true,vision:false}}},
    jobs:[{id:'legacy',name:'已保存的项目检查',prompt:'检查项目',sessionId:'original',trigger:{kind:'once',at:previous},timeZone:'UTC',revision:2,state:'completed',createdAt:previous,lastEventIds:[],
      runs:[{id:'legacy-run',turnId:'legacy-turn',queuedAt:previous,finishedAt:previous,status:'completed',reason:'schedule',summary:'原执行摘要',result:'原始执行结果'}]}]}));
  require(path.join(project,'dist-electron','bootstrap.js'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  async function until(fn,label) { const end=Date.now()+20000; while(Date.now()<end){ const value=await fn(); if(value)return value; await sleep(100); } throw Error('Timed out: '+label); }
  const win = await until(() => BrowserWindow.getAllWindows()[0],'main window');
  const js = code => win.webContents.executeJavaScript(code).catch(error => { throw new Error(`Renderer failed: ${code}`, {cause:error}); });
  const wait = code => until(() => js(code),code);
  const click = selector => js('document.querySelector('+JSON.stringify(selector)+').click()');
  const active = name => wait('!!document.querySelector('+JSON.stringify('[data-desktop-page="'+name+'"]')+')');
  const capture = async name => {await sleep(260);fs.writeFileSync(path.join(root,name+'.png'), (await win.webContents.capturePage()).toPNG());};
  win.setSize(1340,850); win.show();
  await active('overview');
  await js(`localStorage.setItem('cardbush_language_mode','zh');localStorage.setItem('cardbush_theme_mode','light');
    localStorage.setItem('cardbush_projects',JSON.stringify([{id:'test-project',title:'CardBush Desktop',rootPath:${JSON.stringify(root)}}]))`);
  await js("window.cardbushDesktop.homeComponentLibrary('read').then(state=>window.cardbushDesktop.homeComponentLibrary('save',state.revision,[{id:'local-check',width:4,height:200,order:1,title:'回归结果',html:'<output></output>',allowActions:true}]))");
  const reload = () => new Promise(resolve => {win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
  await reload(); await active('overview');
  await wait("document.querySelector('.desktop-cover')?.innerText.includes('版本发布周报')");
  assert.equal(await js("document.querySelector('.desktop-library').innerText.includes('Archived fixture')"),false);
  assert.equal(await js("!!document.querySelector('[data-history-action=forward]')"),false);
  const rail = await js("(()=>{const r=document.querySelector('.desktop-shell>.sidebar').getBoundingClientRect();return [r.top,innerHeight-r.bottom]})()");
  assert.ok(rail.every(n => Math.abs(n)<=1),'full-height sidebar: '+rail);
  await capture('home-light'); await click('.desktop-cover'); await active('event');
  await click('.desktop-list .desktop-row'); await wait("document.querySelector('.desktop-authored[data-layout=facts]')?.innerText.includes('已通过')");
  await click('.desktop-list .desktop-row'); await wait("document.querySelector('.desktop-authored[data-layout=article]')?.innerText.includes('回归')");
  const widget = await until(async () => {
    const frame = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    return frame && await frame.executeJavaScript('Boolean(window.cardbush?.ready)').catch(() => false) ? frame : undefined;
  }, 'event component bridge ready');
  const context = await widget.executeJavaScript('window.cardbush.ready.then(() => window.cardbush.read())');
  assert.deepEqual(Object.keys(context), ['eventPage']);
  assert.equal(context.eventPage.items[0].text, '完成');
  assert.equal(await widget.executeJavaScript("window.cardbush.state.write('fixture').catch(error=>error.message)"), 'CAPABILITY_DENIED');
  assert.equal(await widget.executeJavaScript("window.cardbush.invoke('conversation.send',{text:'fixture'}).catch(error=>error.message)"), 'CAPABILITY_DENIED');
  await click('[data-history-action=back]'); await wait("!!document.querySelector('.desktop-authored[data-layout=facts]')");
  await click('[data-history-action=back]'); await wait("!!document.querySelector('.desktop-detail-heading')");
  await capture('event'); await click('[data-history-action=back]'); await active('overview');
  await js("Array.from(document.querySelectorAll('.desktop-shelf h2 button')).find(b=>b.textContent==='事件').click()");
  await active('events');
  await js("Array.from(document.querySelectorAll('.desktop-row')).find(b=>b.textContent.includes('已保存的项目检查')).click()");
  await wait("document.querySelector('.friends-event-details')?.innerText.includes('原执行摘要')");
  await click('.friends-event-details .event-history summary');
  await click('.friends-event-details .event-result-disclosure > summary');
  await wait("document.querySelector('.event-result-disclosure[open]')?.innerText.includes('原始执行结果')");
  assert.equal(await js("document.querySelector('.desktop-library').innerText.includes('检查项目')"), false, 'history does not expose the scheduler prompt');
  assert.equal(await js("document.querySelector('#right-inspector')?.checkVisibility() ?? false"), false, 'reading history stays on the event page');
  await click('[data-nav-section=explore]'); await active('explore'); await capture('explore');
  assert.equal(await js("Array.from(document.querySelectorAll('.desktop-explore .desktop-row strong')).some(node=>node.textContent==='设置')"), false);
  const more = '.sidebar-more-apps', flyout = '.sidebar-app-flyout:popover-open';
  const hover = async selector => {
    const point = await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove', ...point});
  };
  await hover(more);
  await wait(`!!document.querySelector('${flyout}')`);
  assert.equal(await js("!!document.querySelector('[data-sidebar-app=\"builtin:automations\"]')"),false);
  assert.equal(await js("!!document.querySelector('[data-sidebar-app=\"builtin:settings\"]')"), false);
  await hover('[data-sidebar-app="builtin:components"]'); await sleep(350);
  assert.ok(await js(`!!document.querySelector('${flyout}')`),'the pointer can cross from the rail into the list');
  await click('[data-sidebar-app="builtin:components"]');
  await wait("!document.querySelector('.desktop-explore,.sidebar-app-flyout:popover-open') && !!document.querySelector('.components-app')");
  await click('[data-nav-section=explore]'); await active('explore');
  assert.equal(await js("document.querySelector('.desktop-explore > h1')?.nextElementSibling?.matches('.desktop-filter')"), true, 'search immediately follows the Explore title');
  await js(`(()=>{const n=document.querySelector('.desktop-filter input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'xyz-no-match');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait("!document.querySelector('.desktop-explore .desktop-row')");
  await click('[data-nav-section=home]'); await active('overview');
  await js("Array.from(document.querySelectorAll('.desktop-shelf h2 button')).find(b=>b.textContent==='项目').click()");
  await active('projects');
  await wait("!!document.querySelector('.workspace-project-list .project-row')");
  await js("document.querySelector('.workspace-project-list .project-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:160}));void 0");
  await js("Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='项目详情' && b.checkVisibility()).click()");
  await active('project');
  await click('[data-nav-section=home]'); await active('overview');
  await js("localStorage.setItem('cardbush_theme_mode','dark');localStorage.setItem('cardbush_language_mode','en')");
  await reload(); await wait("document.querySelector('.theme-dark .desktop-library h1')?.textContent==='Home'");
  win.setMinimumSize(420,500);win.setSize(650,720);
  await wait("innerWidth < 760"); await capture('home-narrow-dark');
  assert.ok(await js("document.querySelector('.desktop-library').scrollWidth<=document.querySelector('.desktop-library').clientWidth+1"));
  await js("document.querySelector('.sidebar-more-apps').focus();void 0");
  const press = keyCode => {
    for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode});
  };
  press('Down'); await wait("document.activeElement?.dataset.sidebarApp==='builtin:plugins'");
  press('Down'); await wait("document.activeElement?.dataset.sidebarApp==='builtin:components'");
  assert.ok(await js(`(() => {const r=document.querySelector('${flyout}').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()`));
  await capture('sidebar-apps');
  press('Escape'); await wait("!document.querySelector('.sidebar-app-flyout:popover-open') && document.activeElement.matches('.sidebar-more-apps')");
  console.log('Desktop Home passed: event card, authored detail and history, Explore search, project drill-down, flat rail, dark/narrow layout.');
  app.quit();
}
