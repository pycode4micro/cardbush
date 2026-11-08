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
  require(path.join(project,'dist-electron','bootstrap.js'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  async function until(fn,label) { const end=Date.now()+20000; while(Date.now()<end){ const value=await fn(); if(value)return value; await sleep(100); } throw Error('Timed out: '+label); }
  const win = await until(() => BrowserWindow.getAllWindows()[0],'main window');
  const js = code => win.webContents.executeJavaScript(code);
  const wait = code => until(() => js(code),code);
  const click = selector => js('document.querySelector('+JSON.stringify(selector)+').click()');
  const active = name => wait('!!document.querySelector('+JSON.stringify('[data-desktop-page="'+name+'"]')+')');
  const capture = async name => {await sleep(260);fs.writeFileSync(path.join(root,name+'.png'), (await win.webContents.capturePage()).toPNG());};
  win.setSize(1340,850); win.show();
  await active('overview');
  await js(`localStorage.setItem('cardbush_language_mode','zh');localStorage.setItem('cardbush_theme_mode','light');
    localStorage.setItem('cardbush.html_components.v1',JSON.stringify({version:1,revision:1,items:[{id:'local-check',width:4,height:200,order:1,title:'回归结果',html:'<output></output>',allowActions:true}]}));
    localStorage.setItem('cardbush_projects',JSON.stringify([{id:'test-project',title:'CardBush Desktop',rootPath:${JSON.stringify(root)}}]))`);
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
  const widget = await until(() => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc'), 'event component frame');
  const context = await widget.executeJavaScript('window.cardbush.ready.then(() => window.cardbush.read())');
  assert.deepEqual(Object.keys(context), ['eventPage']);
  assert.equal(context.eventPage.items[0].text, '完成');
  assert.equal(await widget.executeJavaScript("window.cardbush.state.write('fixture').catch(error=>error.message)"), 'CAPABILITY_DENIED');
  assert.equal(await widget.executeJavaScript("window.cardbush.invoke('conversation.send',{text:'fixture'}).catch(error=>error.message)"), 'CAPABILITY_DENIED');
  await click('[data-history-action=back]'); await wait("!!document.querySelector('.desktop-authored[data-layout=facts]')");
  await click('[data-history-action=back]'); await wait("!!document.querySelector('.desktop-detail-heading')");
  await capture('event'); await click('[data-history-action=back]'); await active('overview');
  await click('[data-nav-section=explore]'); await active('explore'); await capture('explore');
  assert.equal(await js("document.querySelector('.desktop-explore > h1')?.nextElementSibling?.matches('.desktop-filter')"), true, 'search immediately follows the Explore title');
  await js(`(()=>{const n=document.querySelector('.desktop-filter input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'xyz-no-match');n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait("!document.querySelector('.desktop-explore .desktop-row')");
  await click('[data-nav-section=home]'); await active('overview');
  await js("Array.from(document.querySelectorAll('.desktop-shelf h2 button')).find(b=>b.textContent==='项目').click()");
  await active('projects'); await click('.desktop-list .desktop-row'); await active('project');
  await click('[data-nav-section=home]'); await active('overview');
  await js("localStorage.setItem('cardbush_theme_mode','dark');localStorage.setItem('cardbush_language_mode','en')");
  await reload(); await wait("document.querySelector('.theme-dark .desktop-library h1')?.textContent==='Home'");
  win.setMinimumSize(420,500);win.setSize(650,720);
  await wait("innerWidth < 760"); await capture('home-narrow-dark');
  assert.ok(await js("document.querySelector('.desktop-library').scrollWidth<=document.querySelector('.desktop-library').clientWidth+1"));
  console.log('Desktop Home passed: event card, authored detail and history, Explore search, project drill-down, flat rail, dark/narrow layout.');
  app.quit();
}
