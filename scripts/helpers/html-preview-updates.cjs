const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root, directory, guest, ready, clickHost }) => {
  const file = path.join(directory, 'live-chart.html').replaceAll('\\', '/');
  const source = (version, first = 300, second = 600) => `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="cardbush:preview" content="visualization">
    <style>body{margin:0}section{box-sizing:border-box;padding:12px;height:${first}px;margin:0 0 24px}
    section+section{height:${second}px;margin:0}h2{margin:0;font:18px system-ui}svg{display:block;width:100%;height:220px}
    button{color:inherit;background:transparent;border:1px solid currentColor}</style></head><body>
    <section data-chart-section><h2>完整子图 ${version}</h2><svg><path d="M0 180L100 60L200 140L350 40" stroke="var(--viz-series-1)" fill="none"/></svg>
    <button onclick="this.textContent='已选择'">选择月份</button></section><section><h2>补充趋势</h2><svg></svg></section></body></html>`;
  const write = async (version, first, second) => {
    await fs.writeFile(file, source(version, first, second));
    // Explicitly exercise same-size edits as well as size changes.
    const stamp = new Date(Date.now() + version * 1000);
    await fs.utimes(file, stamp, stamp);
  };
  const focus = () => run("dispatchEvent(new Event('focus'))");
  const changed = id => until(`document.querySelector('.inline-html-viewport.is-ready') && document.querySelector('.inline-html-webview').getWebContentsId() !== ${id}`, 'disk edit refreshes HTML without replacing its container');
  try {
    await write(1);
    await run(`
      window.updateSavedDesktop = window.cardbushDesktop;
      window.metadataCalls = [];
      window.cardbushDesktop = {...window.cardbushDesktop, inspectAttachments: async paths => {
        metadataCalls.push(paths);
        return (await Promise.all(paths.map(async file => {
          try { const stat = await require('node:fs/promises').stat(file); return {path:file,kind:'file',size:stat.size,mtimeMs:stat.mtimeMs}; }
          catch { return null; }
        }))).filter(Boolean);
      }};
      htmlContent('![自动更新图表](<${file}>)');
    `);
    await ready();
    await until("document.querySelector('.inline-html-viewport').clientHeight === 300", 'folding includes the complete first plot, labels and controls');
    assert.equal(await run("document.querySelector('.inline-html-expand-toggle').getAttribute('aria-expanded')"), 'false');
    await clickHost('.inline-html-expand-toggle');
    await until("document.querySelector('.inline-html-viewport').clientHeight === 924", 'expansion reveals both plots');
    await run("window.updateContainer=document.querySelector('.inline-html-preview'); window.updateScroller=document.querySelector('.app'); updateScroller.style.overflowY='auto'; updateScroller.scrollTop=260; void 0");
    await pause(100);
    const before = await run('updateContainer.getBoundingClientRect().top');
    const id = (await guest()).id;
    await write(2, 300, 700);
    await focus();
    await changed(id);
    await until("document.querySelector('.inline-html-viewport').clientHeight === 1024", 'updated expanded content settles');
    await pause(100);
    assert.equal(await run("updateContainer===document.querySelector('.inline-html-preview')"), true, 'file updates keep the outer preview');
    assert.equal(await run("document.querySelector('.inline-html-expand-toggle').getAttribute('aria-expanded')"), 'true', 'file updates retain expansion');
    assert.ok(Math.abs(await run('updateContainer.getBoundingClientRect().top') - before) <= 2, 'file updates preserve the reader position inside the chart');
    assert.equal(webContents.fromId(id), undefined, 'replacement releases the old guest');
    await run('updateScroller.scrollTop=0; void 0');
    await pause(80);
    await clickHost('.inline-html-collapse-top');
    const foldedId = (await guest()).id;
    await write(3, 330, 700);
    await focus();
    await changed(foldedId);
    await until("document.querySelector('.inline-html-preview.is-folded') && document.querySelector('.inline-html-viewport').clientHeight === 330", 'an updated collapsed chart keeps its state and chooses the new complete boundary');
    const stableId = (await guest()).id;
    await fs.writeFile(file, '');
    await focus();
    await pause(150);
    assert.equal((await guest()).id, stableId, 'an editor temporarily truncating a file does not clear a working preview');
    await write(4, 330, 700);
    await focus();
    await changed(stableId);
    const currentId = (await guest()).id;
    await focus(); await pause(150); await focus(); await pause(150);
    assert.equal((await guest()).id, currentId, 'unchanged metadata does not reset interactions');

    await write(7, 330, 3000);
    await focus(); await changed(currentId);
    await until("document.querySelector('.inline-html-preview.is-folded') && document.querySelector('webview').clientHeight===2400", 'oversized replacement stays folded');
    await clickHost('.inline-html-expand-toggle');
    await until("document.querySelector('.inline-html-viewport').clientHeight===2400", 'oversized chart expands to its cap');
    let longPage = await guest();
    await longPage.executeJavaScript('scrollTo(0,420); void 0');
    await write(8, 330, 3400);
    await focus(); await changed(longPage.id);
    await pause(150);
    longPage = await guest();
    assert.equal(await longPage.executeJavaScript('scrollY'), 420, 'file updates preserve internal reading position beyond the expanded height cap');
    await clickHost('.inline-html-collapse-top');
    assert.equal(await longPage.executeJavaScript('scrollY'), 0, 'collapsing an internally scrolled chart returns to the first complete plot');
    await write(4, 330, 700);
    await focus(); await changed(longPage.id);
    await until("document.querySelector('.inline-html-viewport').clientHeight===330", 'chart returns to its complete first section');

    // Both public reference forms subscribe to one native metadata source.
    const stat = await fs.stat(file);
    await run(`
      window.updateMemoReply={status:'available',currentVersion:${JSON.stringify({size:stat.size,mtimeMs:stat.mtimeMs})},memo:{file:{path:${JSON.stringify(file)},name:'live-chart.html',size:${stat.size},mtimeMs:${stat.mtimeMs}},note:{purpose:'趋势'}}};
      window.updateMemoLoad=async()=>structuredClone(updateMemoReply);
      renderView(h('div',null,h(views.MessageBubble,{message:htmlMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}),
        h(views.FileMemoReference,{reference:'file-memo://live-chart',inline:true,language:'zh',load:updateMemoLoad},'同一张趋势'),h('div',{style:{height:2000}},'后续消息')));
    `);
    await until("document.querySelectorAll('.inline-html-viewport.is-ready').length===2", 'absolute and memo embeds both load');
    await pause(180);
    const ids = await run("[...document.querySelectorAll('webview')].map(view=>view.getWebContentsId())");
    await write(5, 330, 700);
    await run('metadataCalls=[]; void 0');
    await focus();
    await until(`document.querySelectorAll('.inline-html-viewport.is-ready').length===2 && [...document.querySelectorAll('webview')].every(view=>!${JSON.stringify(ids)}.includes(view.getWebContentsId()))`, 'both kinds of reference update even when memo metadata has not refreshed');
    assert.deepEqual(await run('metadataCalls'), [[file]], 'duplicate file references share one metadata lookup');
    await until("[...document.querySelectorAll('.inline-html-viewport')].every(view=>view.clientHeight===330)", 'both updated layouts settle');
    await pause(100);
    await run("document.querySelector('.app').style.overflowY='auto'; document.querySelector('.app').scrollTop=1800; void 0");
    await pause(180);
    assert.equal(await run("[...document.querySelectorAll('.inline-html-preview')].every(view=>view.getBoundingClientRect().bottom < -240)"), true, 'all charts are outside the observation margin: '+ await run("JSON.stringify({scroll:document.querySelector('.app').scrollTop,rects:[...document.querySelectorAll('.inline-html-preview')].map(view=>view.getBoundingClientRect().toJSON())})"));
    const offscreenIds = await run("[...document.querySelectorAll('webview')].map(view=>view.getWebContentsId())");
    await run('metadataCalls=[]; void 0');
    await write(6, 330, 700);
    await focus(); await pause(150);
    assert.deepEqual(await run('metadataCalls'), [], 'offscreen charts stop checking files');
    assert.deepEqual(await run("[...document.querySelectorAll('webview')].map(view=>view.getWebContentsId())"), offscreenIds, 'scrolling away preserves mounted interaction state');
    await run("document.querySelector('.app').scrollTop=0; void 0");
    await until(`document.querySelectorAll('.inline-html-viewport.is-ready').length===2 && [...document.querySelectorAll('webview')].every(view=>!${JSON.stringify(offscreenIds)}.includes(view.getWebContentsId()))`, 'returning to an edited offscreen chart shows the latest file');

    // Uneven neighbouring plots must fold as a complete row, not at the shorter plot.
    await run('renderView(null)');
    await pause();
    const grid = path.join(directory, 'grid.html').replaceAll('\\', '/');
    await fs.writeFile(grid, `<!doctype html><meta name="cardbush:preview" content="visualization"><style>body{margin:0}.row{display:flex;gap:16px}section{width:50%;height:250px}section+section{height:360px}svg{width:100%;height:100%}.more{height:700px}</style><div class="row"><section><svg></svg></section><section><svg></svg></section></div><div class="more">补充数据</div>`);
    await run(`htmlContent('![并排子图](<${grid}>)')`);
    await ready();
    await until("document.querySelector('.inline-html-viewport').clientHeight===360", 'uneven side-by-side charts fold at the complete row');

    if (process.env.CARDBUSH_HTML_BENCHMARK) {
      await run('renderView(null)'); await pause(300);
      const metrics = () => app.getAppMetrics().map(item => ({pid:item.pid,type:item.type,mb:Math.round((item.memory.privateBytes ?? item.memory.workingSetSize)/1024),cpu:item.cpu.percentCPUUsage}));
      const baseline = metrics();
      const files = [];
      for (let index=0; index<12; index++) {
        const target = path.join(directory, `many-${index}.html`).replaceAll('\\', '/');
        await fs.copyFile(path.join(root,'assets/skills/visualize/assets/trend.html'), target);
        files.push(target);
      }
      await run(`htmlContent(${JSON.stringify(files.map((file,i)=>`![趋势 ${i}](<${file}>)`).join('\n\n'))})`);
      await until("document.querySelector('.inline-html-viewport.is-ready')!==null", 'first chart loads lazily');
      await pause(150);
      const initialGuests = await run("document.querySelectorAll('webview').length");
      assert.ok(initialGuests < 12, 'distant charts are not loaded initially');
      await run("document.querySelector('.app').style.overflowY='auto'; void 0");
      for (let index=0; index<12; index++) {
        await run(`document.querySelectorAll('.inline-html-preview')[${index}].scrollIntoView({block:'start'}); void 0`);
        await until(`document.querySelectorAll('.inline-html-preview')[${index}].querySelector('.inline-html-viewport.is-ready')!==null`, 'visited chart loads: '+index);
      }
      await pause(300);
      metrics(); // Prime the CPU sampling interval after loading settles.
      await run('metadataCalls=[]; void 0');
      await pause(2200);
      const steady = metrics();
      const guests = webContents.getAllWebContents().filter(view=>view.getType()==='webview');
      const pids = [...new Set(guests.map(view=>view.getOSProcessId()))];
      const activeFiles = [...new Set((await run('metadataCalls')).flat())];
      assert.ok(activeFiles.length < files.length, 'file polling remains limited to near-viewport charts after visiting all charts');
      await run('renderView(null)'); await pause(300);
      assert.ok(guests.every(view=>view.isDestroyed()), 'leaving the conversation releases every guest');
      const result = {charts:12,initialGuests,visitedGuests:guests.length,activeMetadataFiles:activeFiles.length,baseline,steady,previewProcesses:steady.filter(item=>pids.includes(item.pid)),afterUnmount:metrics()};
      await fs.writeFile(path.join(root,'tmp/html-preview-performance.json'), JSON.stringify(result,null,2));
      console.log('HTML chart measurement: '+JSON.stringify(result));
    }
    console.log('HTML update checks passed: complete chart boundaries, unequal grids, retained expansion and reading position, actual disk edits through both reference forms, deduplicated metadata, offscreen pause and reentry.');
  } finally {
    await run('renderView(null)'); await pause();
    await run('window.cardbushDesktop=updateSavedDesktop; void 0');
  }
};
