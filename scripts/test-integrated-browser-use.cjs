// Real inspector webviews, renderer @ resolution, desktop routing and HTTP MCP. No user profile or model calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, webContents, ipcMain } = require('electron');
const { IntegratedBrowser } = require('../dist-electron/integratedBrowser.js');
const { installInspectorWindowOpen } = require('../dist-electron/inspectorWindowOpen.js');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { const deadline=Date.now()+12000; while(!await check()) { assert.ok(Date.now()<deadline,message); await pause(30); } }
let window, endpoint, client, fixture;
const deadline=setTimeout(()=>{ console.error('Integrated Browser Use test timed out.'); app.exit(1); },50000);

async function run() {
  await app.whenReady();
  const { BrowserUseRouter, startBrowserUseHost } = await import('../dist-electron/browserUseHost.mjs');
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  fixture=http.createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<title>Same URL browser fixture</title><style>body{margin:24px}button,input{padding:15px}</style>
      <button id="video" onclick="window.clicks++;this.textContent='Video opened'">Play first video</button><input aria-label="Search text" />
      ${Array.from({length:30},(_,i)=>`<p>Snapshot row ${i}</p>`).join('')}
      <script>window.clicks=0;</script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${fixture.address().port}/`, scope='conversation-a', otherScope='conversation-b';
  window=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:path.resolve('dist-electron/preload.js'),
    sandbox:true,contextIsolation:true,nodeIntegration:false,webviewTag:true,backgroundThrottling:false,offscreen:true}});
  installInspectorWindowOpen(window.webContents);
  const integrated=new IntegratedBrowser({getContents:id=>webContents.fromId(id),defaultOwner:()=>window.webContents,
    action:(ownerId,action)=>webContents.fromId(ownerId)?.send('inspector:browser-action',action)});
  const externalCalls=[];
  const externalId='a'.repeat(32);
  const external=async(method,params)=>{
    externalCalls.push({method,params});
    if(method==='browser.list')return {connections:[{id:externalId,name:'Fixture Chrome',connected:true}],defaultConnectionId:externalId,selectedConnectionId:externalId};
    if(method==='browser.select')return {connectionId:params.connectionId};
    if(method==='debugger.detachScope')return {released:true};
    if(method==='tabs.list')return [{id:637760547,url,title:'Same URL browser fixture',active:true}];
    throw Error('Unexpected external browser operation: '+method);
  };
  const routesPath=path.join(directory,'routes.json');
  const router=new BrowserUseRouter(integrated,{external,routesPath});
  ipcMain.handle('inspector:browser-register',(event,input)=>integrated.register(event.sender,input));
  ipcMain.handle('inspector:browser-unregister',(event,input)=>integrated.unregister(event.sender.id,input));
  ipcMain.handle('inspector:browser-bind',(event,input)=>router.bindReferences(event.sender,input.sessionId,input.references));
  ipcMain.handle('browser:settings-read',()=>({protocol:'cardbush.browser_config.v1',revision:1,startPage:url}));
  await window.loadFile(path.join(directory,'index.html'));
  const ui=code=>window.webContents.executeJavaScript(code);
  await until(()=>ui('Boolean(window.browserFixture)'), 'React inspector did not mount');
  await ui(`browserFixture.open({target:${JSON.stringify(url)}})`);
  await until(()=>ui(`Boolean(browserFixture.navigation[${JSON.stringify(url)}]?.guestWebContentsId)`),'Inspector guest not ready');
  const pageId=await ui(`browserFixture.navigation[${JSON.stringify(url)}].guestWebContentsId`);
  const guest=webContents.fromId(pageId);
  assert.throws(()=>integrated.register(window.webContents,{tabId:'app',guestWebContentsId:window.webContents.id}),/does not belong/);
  endpoint=await startBrowserUseHost(router,{browserConfigPath:path.join(directory,'browser.json'),artifactsDirectory:path.join(directory,'artifacts')});
  // Verify the actual desktop utility process publishes this endpoint as Browser Use,
  // without launching the external connector or configuring any model provider.
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const appsConfigPath=path.join(directory,'apps.json');
  require('node:fs').writeFileSync(appsConfigPath,JSON.stringify({protocol:'cardbush.apps_config.v1',revision:1,serviceEnabled:true,
    plugins:[{id:'chrome',installed:true,enabled:true,config:{connectionMode:'connector'}}]}));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CARDBUSH_')&&!['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)));
  let routedLocally=0;
  const runtime=new RuntimeUtilityProcessController({modulePath:path.resolve('dist-electron/runtimeHostWorker.mjs'),
    onMcpHostRequest:async(operation,payload)=>{
      if(operation==='network.configuration')return {default:{mode:'manual',httpProxy:'http://unreachable.invalid:8080',httpsProxy:'',noProxy:''},plugins:{}};
      if(operation==='network.route'){assert.equal(payload.mode,'none','desktop Browser Use must bypass plugin proxies');routedLocally++;return '';}
      throw Error('Unexpected desktop operation: '+operation);
    },env:{...env,
    CARDBUSH_MCP_DESKTOP_BRIDGE:'1',CARDBUSH_BROWSER_USE_URL:endpoint.url,CARDBUSH_BROWSER_USE_TOKEN:endpoint.token,
    CARDBUSH_APPS_CONFIG_PATH:appsConfigPath,CARDBUSH_RUNTIME_STATE_ROOT:path.join(directory,'runtime'),
    CARDBUSH_RUNTIME_SKILL_ROOTS:'[]',CARDBUSH_RUNTIME_PLUGIN_ROOTS:'[]'}});
  let operation=0;
  const command=(kind,payload={})=>runtime.command({protocol:'bush.runtime_ipc.v1',type:'command',operationId:`browser-fixture-${++operation}`,command:{kind,payload}});
  try {
    await runtime.start();
    const apply=await command('runtime.apply_mcp_snapshot',{protocol:'bush.mcp_snapshot.v2',snapshotId:'browser-fixture',revision:1,servers:[]});
    assert.equal(apply.ok,true,JSON.stringify(apply));
    await until(async()=>{
      const snapshot=await command('runtime.get_mcp_snapshot');
      assert.equal(snapshot.ok,true,JSON.stringify(snapshot));
      assert.notEqual(snapshot.result.applicationState,'failed',snapshot.result.applicationError);
      if(snapshot.result.applicationState!=='applied')return false;
      assert.deepEqual(snapshot.result.servers.map(server=>server.id),['browser_use']);return true;
    },'Runtime did not publish integrated Browser Use');
    const catalog=await command('runtime.get_tool_catalog');
    assert.equal(catalog.ok,true,JSON.stringify(catalog));
    assert.ok(catalog.result.some(tool=>tool.name==='mcp__browser_use__click'));
    const select=catalog.result.find(tool=>tool.name==='mcp__browser_use__select_browser');
    assert.ok(select);assert.match(JSON.stringify(select.inputSchema),/cardbush/);
    assert.ok(routedLocally>0,'HTTP MCP discovery used the desktop network route');
  } finally { runtime.dispose(); }
  assert.equal((await fetch(endpoint.url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(endpoint.url,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,Origin:url},body:'{}'})).status,403);
  client=new Client({name:'integrated-browser-regression',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url),{requestInit:{headers:{Authorization:`Bearer ${endpoint.token}`}}}));
  async function call(name,args={},sessionId=scope){return client.callTool({name,arguments:args,_meta:{cardbush_session_id:sessionId}});}
  function success(result){assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent;}
  function failure(result,code){assert.equal(result.isError,true,JSON.stringify(result));assert.equal(result.structuredContent.error.code,code);}
  assert.equal(success(await call('list_pages')).pages[0].id,637760547,'baseline external browser has identical URL');
  const authored=await ui(`browserFixture.reference(${JSON.stringify(scope)},${JSON.stringify(url)})`);
  assert.match(authored.content, /"browser": "cardbush"/);
  assert.match(authored.content, new RegExp('"pageId": '+pageId));
  const externalBefore=externalCalls.length;
  const pages=success(await call('list_pages'));
  assert.equal(pages.pages.length,1);assert.equal(pages.selectedPageId,pageId);assert.equal(pages.pages[0].browser,'cardbush');
  const first=await call('take_snapshot',{limit:3});success(first);
  assert.ok(first.structuredContent.nextCursor,JSON.stringify(first));
  success(await call('take_snapshot',{cursor:first.structuredContent.nextCursor,limit:3}));
  const snapshot=await call('take_snapshot',{query:'Play first video'});success(snapshot);
  const uid=snapshot.content[0].text.match(/uid=(cb_\d+) role=button/)?.[1];assert.ok(uid,snapshot.content[0].text);
  success(await call('click',{uid}));
  await until(()=>guest.executeJavaScript('window.clicks===1'),'Real click did not reach the referenced inspector');
  const screenshot=await call('take_screenshot',{format:'png'});success(screenshot);
  assert.ok(screenshot.content.some(item=>item.type==='image'&&item.data.length>100));
  assert.equal(externalCalls.length,externalBefore,'@ binding must not issue any further Chrome operation');
  const blockedCommand={scopeId:scope,tabId:pageId,command:'Runtime.evaluate',commandParams:{expression:'new Promise(()=>{})',awaitPromise:true}};
  const abort=new AbortController();
  const blocked=router.request('debugger.command',blockedCommand,{signal:abort.signal});
  setTimeout(()=>abort.abort(),80);
  await assert.rejects(blocked,error=>error.name==='AbortError');
  await assert.rejects(router.request('debugger.command',blockedCommand,{timeoutMs:80}),error=>error.code==='cardbush_browser_timeout');
  success(await call('take_snapshot',{limit:3}));
  assert.equal(await guest.executeJavaScript('window.clicks'),1,'cancellation never repeats a prior action');
  success(await call('select_browser',{connectionId:'cardbush'},otherScope));
  failure(await call('select_page',{pageId},otherScope),'cardbush_page_not_authorized');
  success(await call('release_browser'));
  assert.equal(guest.debugger.isAttached(),false);
  success(await call('take_snapshot',{limit:3}));
  const newTab=success(await call('new_page',{url}));
  assert.notEqual(newTab.id,pageId);assert.ok(newTab.tabId.startsWith('browser:'));
  await until(()=>ui(`browserFixture.activeId===${JSON.stringify(newTab.tabId)}`),'New CardBush tab not visible in inspector');
  assert.equal(success(await call('list_pages')).selectedPageId,newTab.id);
  // Re-mention an earlier tab after the server has selected a newer one.
  await ui(`browserFixture.reference(${JSON.stringify(scope)},${JSON.stringify(url)})`);
  assert.equal(success(await call('list_pages')).selectedPageId,pageId);
  success(await call('navigate_page',{type:'url',url:url+'next'}));
  await until(()=>guest.getURL()===url+'next','CardBush navigation did not reach the same guest');
  // Closing the selected page in the UI cannot choose another live CardBush tab or Chrome.
  await ui(`browserFixture.closeTabs(new Set([${JSON.stringify(url)}]))`);
  await until(()=>guest.isDestroyed(),'Selected guest did not close');
  failure(await call('list_pages'),'cardbush_page_unavailable');
  assert.equal(externalCalls.length,externalBefore,'closed targets never fall back to Chrome');
  // An old @ with the same inspector identity cannot retarget a newly created guest.
  await ui(`browserFixture.open({target:${JSON.stringify(url)}})`);
  await until(()=>ui(`Boolean(browserFixture.navigation[${JSON.stringify(url)}]?.guestWebContentsId!==${pageId})`),'Replacement page not ready');
  await assert.rejects(router.bindReferences(window.webContents,scope,[{tabId:url,pageId:String(pageId)}]),/closed or replaced/);
  // Persisted CardBush selection after restart is fail-closed until explicitly re-selected.
  const restarted=new BrowserUseRouter(new IntegratedBrowser({getContents:()=>undefined,defaultOwner:()=>window.webContents,action(){}}),{external,routesPath});
  await assert.rejects(restarted.request('tabs.list',{scopeId:scope}),error=>error.code==='cardbush_browser_reselect_required');
  assert.equal(externalCalls.length,externalBefore);
  success(await call('select_browser',{connectionId:externalId}));
  assert.equal(success(await call('list_pages')).selectedPageId,637760547);
  console.log('Passed integrated Browser Use: Runtime utility process discovery, actual @ -> same visible webview, HTTP MCP snapshot pagination/click/screenshot/navigation, create/reselect/release, cancellation and timeout recovery, same-URL Chrome isolation, scope isolation, closed/replaced/restarted targets, explicit switching, and endpoint authentication.');
}
run().then(async()=>{await client?.close();await endpoint?.close();fixture?.closeAllConnections();fixture?.close();window?.destroy();clearTimeout(deadline);app.exit(0);},async error=>{console.error(error);await client?.close().catch(()=>{});await endpoint?.close().catch(()=>{});fixture?.closeAllConnections();fixture?.close();window?.destroy();clearTimeout(deadline);app.exit(1);});
