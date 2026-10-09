const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp', 'html-diagnostics-'));
  const file = path.join(directory, 'diagnostic-private-name.html');
  await fs.writeFile(file, '<!doctype html><meta name="cardbush:preview" content="visualization"><style>body{margin:0}section{height:200px;background:#142234;color:#fff}button{margin:24px}</style><button onclick="this.textContent=\'selected-private-text\'">Choose</button>' + '<section data-chart-section>Private document content</section>'.repeat(12));
  const baselineCSS = await window.webContents.insertCSS('.message-list-item:has(.inline-html-preview){content-visibility:auto;contain:none;contain-intrinsic-block-size:auto 220px}');
  try {
    await run(`
      window.htmlDiagnosticBatches=[];window.htmlDiagnosticOriginalLog=cardbushDesktop.writeDebugLog;
      cardbushDesktop.writeDebugLog=async(scope,payload)=>{if(scope==='inline-html-preview')htmlDiagnosticBatches.push(payload);return 'fixture.log';};
      window.htmlDiagnosticMessage={id:'diagnostic-private-message',conversationId:'fixture',turnId:'fixture-turn',role:'assistant',status:'completed',metadata:{transcript_kind:'assistant_final'},createdAt:'2026-10-09T00:00:00Z',content:'![Private document title](<'+${JSON.stringify(file.replaceAll('\\', '/'))}+'>)'};
      renderView(h('div',{className:'html-diagnostic-scroll',style:{height:480,width:820,overflowY:'auto'}},
        h('div',{style:{height:1500}}),
        h('div',{className:'message-list-item','data-message-id':htmlDiagnosticMessage.id},h(views.MessageBubble,{message:htmlDiagnosticMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''})),
        h('div',{style:{height:6000}})));
      window.htmlDiagnosticTop=top=>{document.querySelector('.html-diagnostic-scroll').scrollTop=top;};void 0;
    `);
    await until("!!document.querySelector('.html-diagnostic-scroll')", 'diagnostic scroller mounted');
    await run('htmlDiagnosticTop(1500);void 0');
    await until("!!document.querySelector('.inline-html-viewport.is-ready')", 'diagnostic document ready');
    const guestId = await run("document.querySelector('webview').getWebContentsId()");
    await webContents.fromId(guestId).executeJavaScript("document.querySelector('button').click()");
    await run("document.querySelector('.inline-html-expand-toggle').click();void 0");
    await pause(200);
    const readyAt = Date.now();
    for (const top of [1550, 1700, 2100, 2800, 3400, 2600, 1700, 1500]) {
      await run(`htmlDiagnosticTop(${top});void 0`); await pause(100);
    }
    webContents.fromId(guestId).sendInputEvent({ type:'mouseWheel', x:160, y:200, deltaY:-60, deltaX:0 });
    await pause(260);
    // Expose the lazy row's skip/unskip without waiting long enough to recycle
    // the native guest. This interaction was absent from the old scroll replay.
    await run('htmlDiagnosticTop(6000);void 0'); await pause(180);
    await run('htmlDiagnosticTop(1500);void 0'); await pause(260);
    assert.equal(await run("document.querySelector('webview').getWebContentsId()"), guestId, 'same native guest survives scroll with diagnostics enabled');
    assert.equal(await webContents.fromId(guestId).executeJavaScript("document.querySelector('button').textContent"), 'selected-private-text');
    const rowContain = await run("(()=>{const s=getComputedStyle(document.querySelector('.message-list-item'));return {visibility:s.contentVisibility,contain:s.contain}})()");
    await window.webContents.removeInsertedCSS(baselineCSS);
    await pause(150);
    assert.equal(await run("getComputedStyle(document.querySelector('.message-list-item')).contentVisibility"),'visible','product CSS keeps native preview rows painted');
    const variantAt = await run('performance.now()');
    for (let index=0;index<3;index++) {
      await run('htmlDiagnosticTop(6000);void 0');await pause(160);
      await run('htmlDiagnosticTop(1500);void 0');await pause(160);
    }
    assert.equal(await run("document.querySelector('webview').getWebContentsId()"),guestId);
    const scrollHeight=await run("document.querySelector('.html-diagnostic-scroll').scrollHeight");
    await run('htmlDiagnosticTop(6000);void 0');await pause(1000);
    assert.equal(await run("document.querySelector('webview')===null"),true,'paint exemption still reclaims a distant guest');
    assert.equal(await run("document.querySelector('.html-diagnostic-scroll').scrollHeight"),scrollHeight,'reclamation does not collapse the lazy row to an estimated height');
    await run('renderView(null);void 0'); await pause(100);
    const batches = await run('htmlDiagnosticBatches');
    const records = batches.flatMap(batch => batch.records);
    for (const event of ['mount', 'state', 'intersection', 'guest-dom', 'dom-ready', 'layout-measured', 'layout-published', 'scroll-sample', 'unmount']) {
      assert.ok(records.some(record => record.event === event), 'log includes '+event);
    }
    assert.ok(records.some(record => record.event === 'guest-metrics' && ['wheel', 'scroll'].includes(record.kind)), 'native guest scrolling is logged across the document boundary');
    const scrollRecords = records.filter(record => Date.parse(record.at) >= readyAt && record.event === 'scroll-sample');
    assert.ok(scrollRecords.length >= 3, 'bounded scrolling snapshots are captured');
    assert.ok(scrollRecords.every(record => record.state.state === 'ready' && record.guestId === guestId), 'logged visible scrolling does not reload or hide the document');
    assert.ok(!records.some(record => record.event === 'reload-request'), 'no file/manual reload in this replay');
    assert.ok(records.some(record => record.event === 'content-visibility' && record.skipped), 'diagnostics observe the lazy row skipping paint');
    const variantRecords=records.filter(record=>record.t>=variantAt && record.event!=='unmount');
    const variantSkips=variantRecords.filter(record=>record.event==='content-visibility'&&record.skipped);
    const variantHidden=variantRecords.filter(record=>record.event==='guest-metrics'&&record.kind==='visibility'&&record.hidden);
    console.log('HTML containment comparison:',JSON.stringify({skips:variantSkips.length,hiddenGuest:variantHidden.length}));
    assert.equal(variantSkips.length,0,'a live native guest is not skipped by content-visibility after the override');
    assert.equal(variantHidden.length,0,'product CSS avoids hiding the retained guest on scroll');
    assert.ok(batches.every(batch => batch.records.length <= 160), 'batches are bounded');
    const serialized = JSON.stringify(batches);
    for (const privateValue of ['diagnostic-private-name', 'diagnostic-private-message', 'Private document', 'selected-private-text', directory]) assert.ok(!serialized.includes(privateValue), 'diagnostics omit '+privateValue);
    assert.equal(webContents.fromId(guestId), undefined, 'diagnostics do not retain the guest');
    await fs.writeFile(path.join(root, 'tmp', 'inline-html-diagnostics-replay.jsonl'), batches.map(payload => JSON.stringify({at:new Date().toISOString(),payload})).join('\n')+'\n');
    const events = Object.fromEntries([...new Set(records.map(record => record.event))].map(event => [event, records.filter(record => record.event===event).length]));
    console.log('HTML diagnostic replay:', JSON.stringify({rowContain,events,guestIds:[...new Set(scrollRecords.map(record=>record.guestId))],heights:[...new Set(scrollRecords.map(record=>record.state.viewportHeight))]}));
    console.log('HTML diagnostics passed: actual lazy message rows, scrolling identity/state, skip/unskip, layout/load reasons, bounded private-free logs and cleanup.');
  } catch (error) {
    console.error('Diagnostic renderer errors:', await run('failures'));
    throw error;
  } finally {
    await run('renderView(null);cardbushDesktop.writeDebugLog=htmlDiagnosticOriginalLog;void 0');
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, 'tmp'));
    await fs.rm(directory, { recursive:true, force:true });
  }
};
