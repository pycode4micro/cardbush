const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { webContents } = require('electron');

// Replay the lower, static part of a long preview. Optional reports are copied
// read-only; ordinary tests use a local fixture and never need a user profile.
module.exports = async ({ run, until, pause, window, root }) => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp', 'html-regions-'));
  const reported = process.env.CARDBUSH_HTML_DIAGNOSTIC_FILE;
  const original = reported ? await fs.readFile(reported) : Buffer.from(`<!doctype html><meta charset="utf-8">
    <meta name="cardbush:preview" content="visualization"><style>
    body{margin:0;font:14px system-ui}section{padding:16px;border:1px solid #444;margin-bottom:16px}
    .upper{height:1080px}table{width:100%;border-collapse:collapse}td{padding:8px;border-bottom:1px solid #555}
    button{font:inherit}.lower{height:500px}</style><section class="upper"><h2>Upper chart</h2>
    <svg width="600" height="300"><path d="M0 240 L120 120 L300 180 L580 30" stroke="#6aa9ff" fill="none"/></svg></section>
    <section><h2>Lower table</h2><table>${Array.from({ length: 10 }, (_, index) => `<tr><td>Row ${index}</td><td>${index === 0
      ? '<button onclick="this.textContent=\'private-selected-value\'">Select row</button>' : 'Static private text'}</td></tr>`).join('')}</table></section>
    <section class="lower"><h2>Explanation</h2><p>Static explanatory content beneath the chart.</p></section>`);
  const file = path.join(directory, 'private-region-report.html');
  const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(file, original);
  try {
    await run(`
      window.regionBatches=[];window.regionOriginalLog=cardbushDesktop.writeDebugLog;
      cardbushDesktop.writeDebugLog=async(scope,payload)=>{if(scope==='inline-html-preview')regionBatches.push(payload);return 'fixture.log';};
      const message={id:'region-message-private',conversationId:'fixture',turnId:'region-turn',role:'assistant',status:'completed',
        metadata:{transcript_kind:'assistant_final'},createdAt:'2026-10-13T00:00:00Z',content:'![Private report](<'+${JSON.stringify(file.replaceAll('\\', '/'))}+'>)'};
      renderView(h('div',{className:'html-region-scroll',style:{height:560,width:704,overflowY:'auto',flex:'none'}},
        h('div',{className:'message-list-item'},h(views.MessageBubble,{message,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''})),
        h('div',{style:{height:800}})));
      void 0;
    `);
    await until("!!document.querySelector('.inline-html-viewport.is-ready')", 'lower-region preview ready');
    await run("document.querySelector('.inline-html-expand-toggle').click();void 0");
    await pause(300);
    const guestId = await run("document.querySelector('webview').getWebContentsId()");
    const page = webContents.fromId(guestId);
    const table = await page.executeJavaScript("document.querySelector('table').getBoundingClientRect().toJSON()");
    assert.ok(table.top > 900, 'the fixture exercises the lower portion of a tall native guest');
    const target = await run(`(()=>{const s=document.querySelector('.html-region-scroll'),f=document.querySelector('webview');
      return s.scrollTop+f.getBoundingClientRect().top+${table.top}-s.getBoundingClientRect().top-64;})()`);
    const paints = [];
    for (const offset of [-80, -30, 0, 35, 70, 10, -40, 0]) {
      await run(`document.querySelector('.html-region-scroll').scrollTop=${target + offset};void 0`);
      await pause(120);
      assert.equal(await run("document.querySelector('webview').getWebContentsId()"), guestId);
      assert.equal(await run("document.querySelector('.inline-html-viewport').classList.contains('is-ready')"), true);
      const crop = await run(`(()=>{const f=document.querySelector('webview').getBoundingClientRect(),s=document.querySelector('.html-region-scroll').getBoundingClientRect();
        const y=Math.ceil(Math.max(f.top+${table.top},s.top+24));return {x:Math.ceil(f.left+${table.left}),y,
          width:Math.floor(${table.width}),height:Math.floor(Math.min(f.top+${table.bottom},s.bottom-24)-y)};})()`);
      assert.ok(crop.height > 100, 'lower table occupies the visible viewport');
      const capture = await window.webContents.capturePage(crop);
      const bitmap = capture.toBitmap();
      let foreground = 0;
      for (let index = 0; index < bitmap.length; index += 4) {
        if (Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]) > 100) foreground++;
      }
      paints.push({ offset, foreground, width: crop.width, height: crop.height });
      if (offset === 0) await fs.writeFile(path.join(root, 'tmp/html-lower-region-reviewed.png'), capture.toPNG());
    }
    // Observe native paint frames during uninterrupted scrolling. A capture
    // after settling can miss a transient blank and can itself request a paint.
    const band = await run(`(()=>{const f=document.querySelector('webview').getBoundingClientRect(),s=document.querySelector('.html-region-scroll').getBoundingClientRect();
      return {x:Math.ceil(f.left+${table.left}),y:Math.ceil(s.top+170),width:Math.floor(${table.width}),height:100};})()`);
    const movingPaints = [];
    let blankFrame;
    const onPaint = (_event, _dirty, image) => {
      const bitmap = image.crop(band).toBitmap();
      let foreground = 0, darkest = 255, lightest = 0;
      for (let index = 0; index < bitmap.length; index += 16) {
        const value = Math.max(bitmap[index], bitmap[index + 1], bitmap[index + 2]);
        if (value > 100) foreground++;
        darkest = Math.min(darkest, value); lightest = Math.max(lightest, value);
      }
      movingPaints.push({ foreground, contrast: lightest - darkest });
      if (!blankFrame && (foreground <= 100 || lightest - darkest <= 32)) blankFrame = image.toPNG();
    };
    window.webContents.on('paint', onPaint);
    try {
      const dimensions = await page.executeJavaScript('({inner:innerHeight,height:document.documentElement.scrollHeight})');
      assert.ok(dimensions.height <= dimensions.inner + 1, 'trailing section margins do not create an unintended inner scroll');
      const point = { x: Math.round(table.left + table.width / 2), y: Math.round(table.top + 170) };
      page.sendInputEvent({ type: 'mouseMove', ...point });
      let previous = 0;
      for (let frame = 1; frame <= 100; frame++) {
        const offset = Math.round(Math.sin(frame / 8) * 40);
        page.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: previous - offset });
        previous = offset;
        await pause(20);
      }
      await pause(80);
      const finalTop = await run("document.querySelector('.html-region-scroll').scrollTop");
      assert.ok(Math.abs(finalTop - target - previous) <= 2,
        'wheel input inside the lower table moves only the outer conversation by the supplied distance: '+JSON.stringify({finalTop,target,previous}));
      assert.equal(await page.executeJavaScript('scrollY'), 0, 'the full-height report does not enter a native inner scroll');
      await run(`document.querySelector('.html-region-scroll').scrollTop=${target};void 0`);
      await pause(80);
    } finally { window.webContents.removeListener('paint', onPaint); }
    await fs.writeFile(path.join(root, 'tmp/html-moving-paints.json'), JSON.stringify({ band, movingPaints }, null, 2));
    if (blankFrame) await fs.writeFile(path.join(root, 'tmp/html-moving-blank.png'), blankFrame);
    assert.ok(movingPaints.length >= 10, 'continuous scrolling produces native paint samples');
    assert.ok(movingPaints.every(paint => paint.foreground > 100 && paint.contrast > 32), 'lower table text stays painted in every sampled moving frame');
    if (!reported) {
      const point = await page.executeJavaScript("(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      for (const type of ['mouseDown', 'mouseUp']) page.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
      await pause(150);
      assert.equal(await page.executeJavaScript("document.querySelector('button').textContent"), 'private-selected-value');
    }
    // A document cannot smuggle text, paths, selectors or arbitrary fields into
    // the diagnostic channel while supplying otherwise valid numeric metrics.
    await page.executeJavaScript(`console.info('[cardbush:inline-html-metrics]'+JSON.stringify({event:'region',secret:'private-forged-payload',
      regions:[{tag:'TABLE',top:1,bottom:2,text:'private-forged-payload'},{tag:'private-forged-payload'}]}))`);
    await pause(1200);
    await run('renderView(null);void 0'); await pause(100);
    const batches = await run('regionBatches'), records = batches.flatMap(batch => batch.records);
    const regions = records.filter(record => record.event === 'guest-metrics' && record.kind === 'region');
    assert.ok(records.some(record => record.event === 'host-frames' && record.frames > 0), 'host frame cadence is measured during scrolling');
    assert.ok(records.some(record => record.event === 'scroll-sample' && record.region?.top > 900 && record.region.height > 100), 'visible guest coordinates identify the lower section');
    assert.ok(regions.some(record => record.regions?.some(region => region.tag === 'TABLE' && region.visible && region.height > 100)), 'guest confirms visibility of the actual lower table');
    if (!reported) assert.ok(records.some(record => record.kind === 'activity' && record.tableMutations > 0), 'actual table interaction is distinguished from native repainting');
    assert.equal(records.filter(record => record.event === 'dom-ready').length, 1, 'scrolling does not reload the document');
    const serialized = JSON.stringify(batches);
    for (const secret of ['private-selected-value', 'Static private text', 'private-region-report', 'region-message-private', 'private-forged-payload']) {
      assert.ok(!serialized.includes(secret), 'only presentation metrics are logged: ' + secret);
    }
    assert.ok(batches.every(batch => batch.records.length <= 160));
    assert.ok(paints.every(paint => paint.foreground > 100), 'captured lower sections contain painted table text');
    assert.equal(webContents.fromId(guestId), undefined, 'sampling does not retain a destroyed document');
    if (reported) assert.equal(checksum(await fs.readFile(reported)), checksum(original), 'original report is unchanged');
    await fs.writeFile(path.join(root, 'tmp/html-lower-region-diagnostics.jsonl'), batches.map(payload => JSON.stringify({ payload })).join('\n') + '\n');
    await fs.writeFile(path.join(root, 'tmp/html-lower-region-paints.json'), JSON.stringify(paints, null, 2));
    console.log('Lower HTML region replay:', JSON.stringify({ source: reported ? 'reported-file-copy' : 'fixture', guestId, regionSamples: regions.length,
      foreground: paints.map(paint => paint.foreground), movingFrames: movingPaints.length,
      reloads: records.filter(record => record.event === 'reload-request').length }));
  } finally {
    await run('renderView(null);cardbushDesktop.writeDebugLog=regionOriginalLog;void 0');
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, 'tmp'));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
