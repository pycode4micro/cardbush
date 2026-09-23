const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, webContents, session } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const { AgentFilePreviews } = await import('../../dist-electron/agentFilePreview.mjs');
  require('../../dist-electron/inspectorWindowOpen.js').installInspectorWindowOpen(window.webContents);
  const files = new Map([
    ['/srv/project/图表 #1.html', `<!doctype html><meta charset="utf-8"><meta name="cardbush:preview" content="visualization"><link rel="stylesheet" href="chart.css"><body><h1>中国 CPI 同比走势</h1><select><option>近 3 年</option><option>近 10 年</option></select><strong id="value"></strong><svg viewBox="0 0 600 240"><path d="M10 200 L100 140 L200 150 L300 80 L420 100 L580 20" fill="none" stroke="#498eff" stroke-width="3"/></svg><a id="data" href="data.json">数据</a> <a id="other" href="https://example.com" target="_blank">来源</a><script src="chart.js"></script></body>`],
    ['/srv/project/chart.css', 'body{padding:24px;font:16px system-ui}svg{display:block;width:100%;height:240px}#value{color:rgb(39, 174, 96)}'],
    ['/srv/project/chart.js', `window.chartInstance=Math.random();document.querySelector('select').onchange=e=>document.getElementById('value').textContent=e.target.value;fetch('data.json').then(r=>r.json()).then(data=>document.getElementById('value').textContent=data.value);`],
    ['/srv/project/data.json', '{"value":"同比 +0.8%"}'],
    ['/srv/project/picture.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="blue"/></svg>'],
  ]);
  const reads=[], grants=[], released=[]; let offline=false;
  const read = async (id,input) => {
    reads.push({ id, ...input }); assert.equal(id,'agent-a'); assert.equal(input.sessionId,'session-a');
    if(offline || !files.has(input.path)) throw Error('Remote file unavailable');
    const bytes=Buffer.from(files.get(input.path)), offset=input.offset||0, part=bytes.subarray(offset,offset+512*1024);
    return {name:input.path.split('/').at(-1),size:bytes.length,offset,content:part.toString('base64'),done:offset+part.length===bytes.length};
  };
  const previews = new AgentFilePreviews(read, file => ({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml'}[path.extname(file)]||'text/plain'));
  for(const target of new Set([window.webContents.session,session.defaultSession])) target.protocol.handle('cardbush-agent',request=>previews.respond(request));
  ipcMain.handle('agent-preview-test', (_event, action, input) => {
    if(action==='read') return read('agent-a',input);
    if(action==='create'){const grant=previews.create(window.webContents.id,input.id,input.sessionId,input.path);grants.push(grant);return grant}
    if(action==='release'){released.push(input);previews.release(window.webContents.id,input);return}
    throw Error('Unexpected preview action');
  });
  const guest = async () => webContents.fromId(await run("document.querySelector('.inline-html-webview').getWebContentsId()"));
  const ready = () => until("!!document.querySelector('.inline-html-viewport.is-ready')",'remote chart ready');
  try {
    await run(`
      window.calls=[];window.localReads=[];window.opened=[];window.externalLinks=[];
      cardbushDesktop.inspectAttachments=async paths=>{localReads.push(paths);throw Error('Must not inspect local files')};
      cardbushDesktop.inspectLocalReference=async path=>{localReads.push(path);throw Error('Must not inspect local files')};
      const ipc=require('electron').ipcRenderer;
      cardbushDesktop.onInspectorOpenLink=callback=>{const handler=(_,detail)=>callback(detail);ipc.on('inspector:open-link',handler);return()=>ipc.removeListener('inspector:open-link',handler)};
      cardbushDesktop.agents={filePreview:(id,sessionId,path)=>ipc.invoke('agent-preview-test','create',{id,sessionId,path}),releaseFilePreview:id=>ipc.invoke('agent-preview-test','release',id)};
      window.memo={status:'available',memo:{protocol:'bush.file_memo.v1',id:'file_2',reference:'cardbush-memo:2',file:{path:'/srv/project/图表 #1.html',name:'图表 #1.html',size:100,mtimeMs:1},note:{purpose:'CPI 趋势',points:[]}}};
      window.remoteCall=async(operation,input={})=>{
        calls.push({operation,input});
        if(operation==='conversation.catalog')return{skills:[],pluginCommands:[]};
        if(operation==='product.command')return{plugins:[]};
        if(operation==='files.read')return ipc.invoke('agent-preview-test','read',input);
        if(operation==='runtime.command'&&input.kind==='runtime.resolve_file_memo')return memo;
        if(operation==='runtime.command')return [];
        throw Error('Unexpected remote call '+operation);
      };
      window.remoteRuntime={client:views.agentRuntimeClient(remoteCall),dispose(){},answerPermission(){}};
      window.remoteMessage={id:'remote-message',conversationId:'session-a',turnId:'turn-a',role:'assistant',createdAt:'2026-09-22T00:00:00Z',status:'completed',metadata:{transcript_kind:'assistant_final'},content:'![中国 CPI 同比走势](cardbush-memo:2)'};
      window.remotePanelOnly=false;
      function RemoteFixture(){const context=views.useAgentConversationHost(remoteCall,'agent-a','session-a',true);
        const host={...context.host,sessionId:'session-a',runtime:remoteRuntime,openFile:path=>{opened.push(path);context.host.openFile(path)}};
        return h(views.ConversationHostContext.Provider,{value:host},h('div',{style:{height:'100vh',overflow:'auto',padding:'20px'}},
          remotePanelOnly ? h(views.ConversationHostPreview,{path:'/srv/project/图表 #1.html',language:'zh'}) : h(views.MessageFileReferenceScope,{workspaceRoot:'/srv/project'},h(views.MessageBubble,{message:remoteMessage,language:'zh',sending:remoteMessage.status==='streaming',activeTurnId:remoteMessage.status==='streaming'?'turn-a':'',activeAssistantMessageId:remoteMessage.status==='streaming'?'remote-message':''}))));
      }
      window.renderRemote=()=>renderView(h(RemoteFixture));
      addEventListener('cardbush:open-inspector',event=>externalLinks.push(event.detail.target));
      renderRemote();
    `);
    await ready(); let page=await guest();
    for(let i=0;i<40 && await page.executeJavaScript("document.getElementById('value')?.textContent")!=='同比 +0.8%';i++)await pause(50);
    assert.equal(await page.executeJavaScript("document.getElementById('value').textContent"),'同比 +0.8%','relative JSON fetch works');
    assert.equal(await page.executeJavaScript("getComputedStyle(document.getElementById('value')).color"),'rgb(39, 174, 96)','relative CSS works');
    assert.deepEqual(await page.executeJavaScript('[typeof require,typeof process,typeof cardbushDesktop]'),['undefined','undefined','undefined']);
    assert.deepEqual(await run('localReads'),[]);
    const resolution=await run("calls.find(c=>c.input.kind==='runtime.resolve_file_memo')");
    assert.equal(resolution.input.payload.sessionId,'session-a');assert.equal(resolution.input.payload.turnId,'turn-a');
    assert.ok(reads.some(r=>r.path==='/srv/project/chart.js'));
    const color=await page.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--background')");
    assert.ok(color.trim(),'native theme injected');
    await run("document.querySelector('.app').classList.replace('theme-dark','theme-bright')");await pause(300);
    assert.notEqual(await page.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--background')"),color,'theme changes without regenerating the chart');
    await run("document.querySelector('.app').classList.replace('theme-bright','theme-dark')");await pause(100);
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/agent-inline-chart.png'),(await window.webContents.capturePage()).toPNG());
    const identity=await page.executeJavaScript('chartInstance');
    await page.executeJavaScript("document.getElementById('data').click()");await until("opened.includes('/srv/project/data.json')",'chart links route to remote files');
    assert.equal(await page.executeJavaScript('chartInstance'),identity,'opening a file keeps the chart intact');
    await run("document.querySelector('[aria-label=\"在侧栏展开 HTML\"]').click()");await until("opened.includes('/srv/project/图表 #1.html')",'side panel uses remote path');
    await page.executeJavaScript("location.href='file:///C:/private.txt'");await pause(120);assert.ok(page.getURL().startsWith('cardbush-agent://'),'remote HTML cannot navigate to a local file');
    await run("document.querySelector('[aria-label=\"关闭 HTML 预览\"]').click()");await until("!document.querySelector('webview')",'closing suspends remote chart');
    await pause(80);assert.ok(released.length,'closing revokes remote origin');
    const current=grants.at(-1);assert.equal((await previews.respond(new Request(current.url))).status,404);
    await run("document.querySelector('[aria-label=\"打开 HTML 预览\"]').click()");await ready();
    assert.notEqual(grants.at(-1).id,current.id,'reopening gets a fresh origin');
    await run("remoteMessage={...remoteMessage,content:'![相对路径](<./图表 #1.html> )'};renderRemote()");await ready();
    await run("remoteMessage={...remoteMessage,content:'![图片](./picture.svg) [数据](./data.json) [来源](https://example.com)'};renderRemote()");
    await until("document.querySelector('.message-body img')?.naturalWidth===100 || [...document.querySelectorAll('img')].some(img=>img.naturalWidth===100)",'remote image rendered');
    assert.deepEqual(await run('localReads'),[]);
    await run("[...document.querySelectorAll('a')].find(a=>a.textContent==='来源').click()");assert.deepEqual(await run('externalLinks'),['https://example.com']);
    await run("remoteMessage={...remoteMessage,status:'streaming',metadata:{},content:'![未完成](cardbush-memo:2)'};renderRemote()");await pause(100);
    assert.equal(await run("document.querySelectorAll('webview').length"),0,'streaming narration does not execute remote HTML');
    await run("remotePanelOnly=true;renderRemote()");await ready();assert.equal(await run("document.querySelectorAll('iframe').length"),0,'inspector reuses the native themed chart');
    offline=true;await run("document.querySelector('[aria-label=\"重新加载 HTML\"]').click()");
    await until("!!document.querySelector('.inline-html-viewport.is-failed')",'disconnect produces retry state');
    offline=false;await run("document.querySelector('.inline-html-status button').click()");await ready();
    // Optional manual reproduction with an actual exported chart; the standard
    // suite remains independent of accounts, profiles and network access.
    if (process.env.CARDBUSH_AGENT_PREVIEW_SAMPLE) {
      files.set('/srv/project/图表 #1.html',fs.readFileSync(process.env.CARDBUSH_AGENT_PREVIEW_SAMPLE,'utf8'));
      await run("document.querySelector('[aria-label=\"重新加载 HTML\"]').click()");await ready();await pause(250);
      page=await guest();
      assert.ok(await page.executeJavaScript("document.querySelectorAll('svg,canvas').length>0"),'real chart has rendered graphics');
      fs.writeFileSync(path.join(root,'tmp/cloud-agent-chart-rendered.png'),(await window.webContents.capturePage()).toPNG());
      console.log('Actual cloud chart rendered through the shared preview.');
    }
    await run("renderView(null)");await pause(120);
    for(const grant of grants)assert.equal((await previews.respond(new Request(grant.url))).status,404,'unmount releases every origin');
    assert.deepEqual(await run('localReads'),[]);
  } finally {
    previews.releaseOwner(window.webContents.id);ipcMain.removeHandler('agent-preview-test');
    for(const target of new Set([window.webContents.session,session.defaultSession]))target.protocol.unhandle('cardbush-agent');
  }
};
