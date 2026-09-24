const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = async ({ win, read, until, send, click }) => {
  const open = async (label = '打开设计') => {
    await until(`Array.from(document.querySelectorAll('.message-app-reference')).some(button=>button.textContent===${JSON.stringify(label)}&&!button.disabled)`);
    await read(`Array.from(document.querySelectorAll('.message-app-reference')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  };
  const ready = async () => until('fixtureReports.result && !!document.querySelector("button[aria-label=关闭界面]")');
  const close = async () => { await read('document.querySelector("button[aria-label=关闭界面]").click()'); await until('!document.querySelector("iframe")'); };
  const reset = async script => { await read('clearFixture()'); await until('!document.querySelector(".message-row,.mcp-app-panel")'); await read(script); };

  await until('!!document.querySelector(".message-row.streaming") && !!document.querySelector(".message-tool-artifact")');
  assert.equal(await read('document.querySelector("iframe,.mcp-app-panel,.message-app-reference")'), null, 'loop text cannot load an App');
  assert.deepEqual(await read('operations'), [], 'running tool outputs do not discover, open or initialize Apps');
  await read('fixtureContent="没有提供 App 链接。";renderFixture(false)');
  await until('document.querySelector(".assistant-final-answer")?.textContent.includes("没有提供")');
  assert.equal(await read('document.querySelector(".message-app-reference,iframe")'), null, 'successful MCP calls alone do not add references to the reply');
  await read('fixtureContent=null;renderFixture(false)');
  await until('document.querySelectorAll(".message-app-reference").length===2');
  assert.deepEqual(await read('operations'), [], 'authored references do not fetch even discovery metadata');
  assert.equal(await read('document.querySelector(".assistant-final-answer p").textContent'), '设计已保存。打开设计，也可查看此前设计。', 'references retain their exact position in model prose');
  assert.equal(await read('document.querySelector("iframe")'), null);
  win.webContents.invalidate(); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(resolve('tmp/mcp-app-reference.png'), (await win.webContents.capturePage()).toPNG());
  await open(); await ready();
  await until('fixtureReports.isolated && fixtureReports.networkBlocked');
  assert.equal(await read('operations.find(x=>x.action==="open").toolCallId'), 'tool');
  assert.equal(await read('document.querySelector("iframe").closest(".markdown-content")'), null, 'opening a reference does not insert block content inside Markdown');
  assert.equal(await read('!!document.querySelector("dialog.reference-view:modal")'), true);
  assert.equal(await read('document.querySelector("iframe").getAttribute("sandbox")'), 'allow-scripts');
  assert.equal(await read('fixtureReports.result._meta.uiOnly'), true);
  assert.equal(await read('document.querySelector("iframe").srcdoc.includes("opaque-host-token")'), false);
  await read('window.originalFrame=document.querySelector("iframe");document.querySelector(".app").className="app theme-bright"');
  await until('fixtureReports.theme==="light"');
  await until('fixtureReports.hostContext?.styles?.variables["--color-text-primary"]===getComputedStyle(document.querySelector(".app")).getPropertyValue("--text").trim()');
  assert.equal(await win.webContents.mainFrame.frames[0].executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--color-text-primary").trim()'), await read('getComputedStyle(document.querySelector(".app")).getPropertyValue("--text").trim()'));
  await read('document.querySelector(".app").style.setProperty("--accent","#c74375")');
  await until('fixtureReports.hostContext?.styles?.variables["--cardbush-accent"]==="#c74375"');
  assert.equal(await read('document.querySelector("iframe")===originalFrame'), true, 'palette updates preserve the iframe and draft');
  await read('document.querySelector(".app").className="app theme-dark"'); await until('fixtureReports.theme==="dark"');
  win.webContents.invalidate(); writeFileSync(resolve('tmp/mcp-app-reference-open.png'), (await win.webContents.capturePage()).toPNG());
  await read('window.postMessage({jsonrpc:"2.0",id:99,method:"tools/call",params:{name:"save",arguments:{}}},"*")');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await read('operations.filter(x=>x.action==="call").length'), 0, 'foreign windows cannot use the bridge');
  await send('call'); await until('document.body.innerText.includes("允许本次")'); await click('拒绝'); await until('!!fixtureReports.denied');
  await send('legacy'); await until('document.body.innerText.includes("允许本次")'); await click('允许本次');
  await until('fixtureReports.legacy && context'); assert.equal(await read('saved'), 1); assert.equal(await read('context.structuredContent.widgetState.page'), 2);
  await send('message'); await until('document.body.innerText.includes("发送到会话")'); await click('发送到会话'); await until('fixtureReports.message');
  assert.equal(await read('followup'), 'Continue fixture');
  await close(); assert.equal(await read('document.querySelectorAll(".message-app-reference").length'), 2);
  await read('window.beforeReentry=operations.filter(x=>x.action==="open").length');
  await reset('renderFixture(false)'); await until('!!document.querySelector(".message-app-reference")');
  assert.equal(await read('operations.filter(x=>x.action==="open").length'), await read('beforeReentry'), 'replaying a reply never loads App content');
  await open('此前设计'); await ready(); assert.equal(await read('operations.filter(x=>x.action==="open").at(-1).toolCallId'), 'old', 'each authored reference selects its own result');
  await close();
  await read('fixtureContent="外部引用：[别的会话](cardbush-app:other/t/tool)，[非法](cardbush-app:s/t/%00)。";renderFixture(false)');
  await until('document.querySelector(".assistant-final-answer")?.textContent.includes("外部引用")');
  assert.equal(await read('document.querySelectorAll(".message-app-reference:not(:disabled)").length'), 0, 'links cannot cross conversation identities or accept malformed IDs');

  await reset('fixtureContent=null;fixtureReports={};deferOpen=true;releaseOpen=null;renderFixture(false)');
  await open(); await until('!!releaseOpen && !!document.querySelector(".mcp-app-loading")');
  await read('window.pendingToken="opaque-host-token-"+operations.length;renderFixture(true)');
  await until('!document.querySelector(".mcp-app-panel")');
  await read('renderFixture(false)'); await until('!!document.querySelector(".message-app-reference")');
  await read('releaseOpen();deferOpen=false'); await until('operations.some(x=>x.action==="close"&&x.token===pendingToken)');
  assert.equal(await read('document.querySelector("iframe")'), null, 'a late open cannot resurrect a reference after another loop');
  assert.equal(await read('fixtureReports.result'), undefined, 'cancelled HTML never initializes');
  await open(); await ready();
  await read('window.beforeResume=operations.filter(x=>x.action==="open").length;fixtureMessageOverrides={id:"earlier-message",status:"completed"};renderFixture(true)');
  await until('!document.querySelector("iframe")');
  await read('renderFixture(false)'); await until('!!document.querySelector(".message-app-reference")');
  assert.equal(await read('operations.filter(x=>x.action==="open").length'), await read('beforeResume'), 'historical Apps close for a new loop and do not auto-resume');
  await read('fixtureMessageOverrides={};fixtureReports={}'); await open(); await ready();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
  await until('!document.querySelector("dialog:modal") && !document.querySelector("iframe")');

  for (const failure of [{code:'mcp_app_html_missing',message:'No supported HTML'}, {code:'future_plugin_error',message:'Unknown error'}]) {
    await reset(`fixtureReports={};openFailure=${JSON.stringify(failure)};renderFixture(false)`);
    await open(); await until('!!document.querySelector(".mcp-app-error")');
    assert.equal(await read('document.querySelector(".mcp-app-error details").open'), false);
    await read('openFailure=null;document.querySelector(".mcp-app-error button").click()'); await ready(); await close();
  }
  await reset('staleOpens=1;fixtureReports={};window.beforeRecovery=operations.filter(x=>x.action==="open").length;renderFixture(false)');
  await open(); await ready();
  assert.equal(await read('operations.filter(x=>x.action==="open").length-beforeRecovery'), 2, 'stale bindings retry once after explicit opening');
  await send('script-error'); await until('document.body.innerText.includes("插件界面运行出错")');
  await read('fixtureReports={};document.querySelector(".mcp-app-error button").click()'); await ready();
  await send('broken-resource'); await until('document.body.innerText.includes("部分界面资源加载失败")');
  assert.equal(await read('document.querySelector(".mcp-app-error pre").textContent'), 'script: https://example.invalid/widget.js');
  await close();

  // Keep the generic panel's inline/fullscreen and legacy compatibility covered.
  await reset('fixtureReports={};renderInlineFixture()'); await ready();
  await read('window.inlineFrame=document.querySelector("iframe")');
  await win.webContents.mainFrame.frames[0].executeJavaScript('document.querySelector("#fixture-input").value="Keep draft"');
  await read('document.querySelector("button[aria-label=展开视图]").click()'); await until('!!document.querySelector("dialog:modal")');
  await read('document.querySelector("button[aria-label=收起]").click()'); await until('!document.querySelector("dialog:modal")');
  assert.equal(await read('document.querySelector("iframe")===inlineFrame'), true);
  assert.equal(await win.webContents.mainFrame.frames[0].executeJavaScript('document.querySelector("#fixture-input").value'), 'Keep draft');
  await read('overlapMode=true;overlapCalls=[];overlapAnswers=[];fixtureReports={}');
    await send('overlap'); await until('overlapCalls.length === 3');
    assert.deepEqual(await read('overlapCalls.map(x=>x.input.action)'), ['call', 'call', 'resource'], 'MCP Apps and legacy calls both reach the runtime without a frontend busy rejection');
    await read('overlapPermission={permissionId:"first",reason:"First queued action",targets:[],capabilityIds:["write"]}');
    await until('document.body.innerText.includes("First queued action")');
    await read('deferStatus=true'); await until('!!releaseStatus');
    await click('允许本次'); await until('!document.querySelector(".mcp-app-confirm")');
    await read('window.permissionReappeared=false;window.permissionObserver=new MutationObserver(()=>{if(document.body.innerText.includes("First queued action"))permissionReappeared=true});permissionObserver.observe(document.body,{subtree:true,childList:true});releaseStatus()');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(await read('permissionReappeared'), false, 'a delayed status response cannot resurrect an answered permission');
    await read('permissionObserver.disconnect();overlapPermission={permissionId:"second",reason:"Second queued action",targets:[],capabilityIds:["write"]}');
    await until('document.body.innerText.includes("Second queued action")');
    // The next permission can arrive before the previous command response.
    await read('overlapCalls[0].resolve({content:[{type:"text",text:"Native result"}],structuredContent:null,isError:false,_meta:{native:true}})');
    await until('!!fixtureReports.overlap0');
    assert.equal(await read('document.body.innerText.includes("Second queued action")'), true, 'an earlier response cannot clear the next request’s permission');
    await click('拒绝'); await read('overlapCalls[1].reject(Error("User denied queued action"));overlapPermission={permissionId:"third",reason:"Queued resource read",targets:[],capabilityIds:["read"]}');
    await until('fixtureReports.overlap1 && document.body.innerText.includes("Queued resource read")');
    await click('允许本次'); await read('overlapCalls[2].resolve({contents:[{uri:"ui://fixture/next",text:"Native resource"}]})');
    await until('fixtureReports.overlap2 && !document.querySelector(".mcp-app-confirm")');
    assert.deepEqual(await read('[fixtureReports.overlap0,fixtureReports.overlap1,fixtureReports.overlap2]'), [
      { result: { content: [{ type: 'text', text: 'Native result' }], structuredContent: null, isError: false, _meta: { native: true } } },
      { error: 'User denied queued action' },
      { result: { contents: [{ uri: 'ui://fixture/next', text: 'Native resource' }] } },
    ], 'each request gets its own unmodified result or error');
    assert.deepEqual(await read('overlapAnswers.map(x=>[x.permissionId,x.decision])'), [['first', 'allow_once'], ['second', 'deny'], ['third', 'allow_once']]);

    // A transport can deliver a completion after view cancellation. Reopening
    // reuses the widget’s numeric JSON-RPC IDs, but must not reuse its replies.
    await read('fixtureReports={};document.querySelector("button[aria-label=重新加载]").click()');
    await until('!!fixtureReports.result');
    await send('call'); await until('overlapCalls.length === 4');
    await read('fixtureReports={};document.querySelector("button[aria-label=重新加载]").click()');
    await until('fixtureReports.result && operations.some(x=>x.action==="close" && x.token===overlapCalls[3].input.token)');
    await send('call'); await until('overlapCalls.length === 5');
    assert.notEqual(await read('overlapCalls[3].input.token'), await read('overlapCalls[4].input.token'));
    await read('overlapCalls[3].resolve({structuredContent:{stale:true}})');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await read('fixtureReports.called'), undefined, 'an old view completion cannot satisfy a new view’s request');
    await read('overlapCalls[4].resolve({structuredContent:{current:true}})');
    await until('!!fixtureReports.called');
    assert.deepEqual(await read('fixtureReports.called'), { structuredContent: { current: true } });
    await read('clearFixture()'); await until('!document.querySelector(".mcp-app-panel")');
  await reset('overlapMode=false;legacyOnly=true;renderInlineFixture()'); await until('document.querySelector(".mcp-app-viewport")?.clientHeight===420');
  assert.equal(await win.webContents.mainFrame.frames[0].executeJavaScript('getComputedStyle(document.documentElement).colorScheme'), 'dark');
  await reset('legacyOnly=false;fixtureContent=null;fixtureMessageOverrides={};outputIds=null;fixtureReports={};');
  console.log('MCP App references passed: model-authored placement, no automatic discovery/content, scoped IDs, modal/ESC, theme tokens, permissions, recovery and late-open races.');
};
