const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Optional read-only replay of a reported interactive HTML file. */
module.exports = async ({ run, until, pause, window, root, directory, guest, ready, clickHost }) => {
  const original = await fs.readFile(process.env.CARDBUSH_HTML_SCROLL_REVIEW_FILE);
  const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
  const file = path.join(directory, 'reported-scroll.html').replaceAll('\\', '/');
  await fs.writeFile(file, original);
  const stat = await fs.stat(file);
  try {
    await run(`
      viewTheme='theme-dark';
      window.scrollReviewBatches=[];window.scrollReviewOriginalLog=cardbushDesktop.writeDebugLog;
      cardbushDesktop.writeDebugLog=async(scope,payload)=>{if(scope==='inline-html-preview')scrollReviewBatches.push(payload);return 'fixture.log';};
      window.scrollReviewMemo={status:'available',currentVersion:${JSON.stringify({size:stat.size,mtimeMs:stat.mtimeMs})},
        memo:{file:{path:${JSON.stringify(file)},name:'reported-scroll.html',size:${stat.size},mtimeMs:${stat.mtimeMs}},note:{purpose:'交互讲解'}}};
      window.scrollReviewLoad=async()=>structuredClone(scrollReviewMemo);
      renderView(h('div',{className:'html-scroll-review',style:{height:520,width:820,overflowY:'auto'}},
        h('div',{className:'message-list-item'},h(views.FileMemoReference,{reference:'file-memo://scroll-review',inline:true,language:'zh',load:scrollReviewLoad},'交互讲解')),
        h('div',{style:{height:3500}},'后续消息')));
      document.querySelector('.app').style.width='900px';document.querySelector('.app').scrollTop=0;
    `);
    await ready();
    await run("document.querySelector('.inline-html-expand-toggle').scrollIntoView({block:'center'});void 0");
    await pause(100);
    await clickHost('.inline-html-expand-toggle');
    await until("document.querySelector('.inline-html-viewport').clientHeight===2400", 'reported long document expands');
    const page = await guest();
    const point = await page.executeJavaScript(`(()=>{const r=document.querySelector('#gridToggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await run(`document.querySelector('.html-scroll-review').scrollTop=${point.y}-180;void 0`);
    await pause(100);
    const frame = await run("(()=>{const r=document.querySelector('webview').getBoundingClientRect();return {x:r.x,y:r.y}})()");
    assert.equal(await run(`document.elementFromPoint(${Math.round(frame.x+point.x)},${Math.round(frame.y+point.y)})===document.querySelector('webview')`), true, 'reported control is visible and unoccluded: '+JSON.stringify({frame,point}));
    const position = { x: Math.round(point.x), y: Math.round(point.y) };
    page.sendInputEvent({ type:'mouseMove', ...position });
    page.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...position });
    page.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, ...position });
    await pause(120);
    assert.equal(await page.executeJavaScript("document.querySelector('#gridToggle').getAttribute('aria-pressed')"), 'true', 'native click changes the reported interactive state');
    await page.executeJavaScript('scrollTo(0,80);void 0');await pause(240);
    await page.executeJavaScript('scrollTo(0,0);void 0');await pause(240);
    await run(`window.scrollReviewStates=[];window.scrollReviewObserver=new MutationObserver(()=>scrollReviewStates.push(document.querySelector('.inline-html-viewport')?.className));
      scrollReviewObserver.observe(document.querySelector('.file-memo-reference'),{attributes:true,childList:true,subtree:true});void 0`);
    for (const top of [0, 420, 900, 1450, 1800, 650, 120, 1000]) {
      await run(`document.querySelector('.html-scroll-review').scrollTop=${top};void 0`);await pause(70);
      assert.equal((await guest()).id,page.id,'visible scroll keeps the same reported document');
      assert.equal(await run("document.querySelector('.inline-html-viewport').classList.contains('is-ready')"),true);
    }
    await run("document.querySelector('.html-scroll-review').scrollTop=4000;void 0");await pause(100);
    await run("document.querySelector('.html-scroll-review').scrollTop=500;void 0");await ready();
    assert.equal((await guest()).id,page.id,'quick return across the buffer keeps the reported document');
    assert.equal(await page.executeJavaScript("document.querySelector('#gridToggle').getAttribute('aria-pressed')"),'true');
    assert.equal(await run("document.querySelector('webview').closest('[title]')===null && !document.querySelector('.inline-html-heading button[title]')"),true,'no inherited memo/HTML hover tooltip');
    assert.equal(await run("scrollReviewStates.every(state=>state?.includes('is-ready'))"),true,'scrolling never hides ready content behind a loading/suspended state');
    await pause(160);
    await fs.writeFile(path.join(root,'tmp/html-scroll-reviewed.png'),(await window.webContents.capturePage()).toPNG());
    assert.equal(checksum(await fs.readFile(process.env.CARDBUSH_HTML_SCROLL_REVIEW_FILE)),checksum(original),'the original report remains unchanged');
    await run('renderView(null);void 0');await pause(100);
    const batches=await run('scrollReviewBatches');
    const records=batches.flatMap(batch=>batch.records);
    const skippedReadyRows=records.filter(record=>record.event==='content-visibility'&&record.skipped&&record.guestId&&record.state?.state==='ready');
    assert.equal(skippedReadyRows.length,0,'the reported document row does not skip painting its retained native guest');
    await fs.writeFile(path.join(root,'tmp/reported-html-scroll-diagnostics.jsonl'),batches.map(payload=>JSON.stringify({at:new Date().toISOString(),payload})).join('\n')+'\n');
    console.log('Reported HTML diagnostics:',JSON.stringify({
      reloads:records.filter(record=>record.event==='reload-request').length,
      readyGuests:[...new Set(records.filter(record=>record.state?.state==='ready'&&record.guestId).map(record=>record.guestId))],
      measuredHeights:[...new Set(records.filter(record=>record.event==='layout-measured').map(record=>record.height))],
      guestScrolls:records.filter(record=>record.event==='guest-metrics'&&record.kind==='scroll').length,
      skippedReadyRows:skippedReadyRows.length,
    }));
    console.log('Reported HTML scroll passed: actual memo embed, native control click, continuous/quick return scrolling, retained guest/state, no hover tooltip, original file unchanged.');
  } finally {
    await run('window.scrollReviewObserver?.disconnect();renderView(null);cardbushDesktop.writeDebugLog=scrollReviewOriginalLog;void 0');
  }
};
