const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const parent = path.join(root, 'tmp');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'html-reference-test-'));
  const htmlPath = path.join(directory, '报表 #1.html').replaceAll('\\', '/');
  const missingPath = path.join(directory, 'missing.html').replaceAll('\\', '/');
  const guest = async () => webContents.fromId(await run("document.querySelector('.inline-html-webview').getWebContentsId()"));
  const ready = () => until("document.querySelector('.inline-html-viewport.is-ready') !== null", 'inline HTML loaded');
  const clickHost = async selector => {
    const position = await run(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      const rect = button.getBoundingClientRect();
      const point = {x:Math.round(rect.x + rect.width/2),y:Math.round(rect.y + rect.height/2)};
      return {...point, reachable:button.contains(document.elementFromPoint(point.x,point.y))};
    })()`);
    assert.equal(position.reachable, true, 'chart action is reachable: ' + selector);
    const {x,y} = position;
    window.webContents.sendInputEvent({type:'mouseMove',x,y});
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
    await pause(80);
  };
  const clickInChart = async (page, selector) => {
    const point = await page.executeJavaScript(`(() => {
      const bounds = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    })()`);
    const frame = await run("document.querySelector('.inline-html-webview').getBoundingClientRect().toJSON()");
    assert.equal(await run(`document.elementFromPoint(${Math.round(frame.x + point.x)},${Math.round(frame.y + point.y)}) === document.querySelector('.inline-html-webview')`), true, 'host overlays do not cover the chart control');
    // Offscreen Electron does not route host input into guest surfaces. Check
    // host hit testing above, then deliver native input to the actual guest.
    const position = { x: Math.round(point.x), y: Math.round(point.y) };
    page.sendInputEvent({ type: 'mouseMove', ...position });
    await pause(60);
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
    await pause(100);
  };
  try {
    await fs.writeFile(path.join(directory, 'chart.css'), 'body{margin:0;padding:24px;font:14px system-ui;background:#f5f7fa;color:#16202b}h1{font-size:20px}svg{display:block;width:100%;height:220px}#value{color:rgb(39, 174, 96)}select{margin:12px 0}');
    await fs.writeFile(path.join(directory, 'chart.js'), `window.chartInstance = Math.random();
const select = document.querySelector('select');
select.onchange = () => document.getElementById('value').textContent = select.value;
document.getElementById('value').textContent = select.value;`);
    await fs.writeFile(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="chart.css"></head><body>
<h1>销售分析</h1><label>查看年份 <select><option>2025</option><option>2026</option></select></label>
<div>当前筛选：<strong id="value"></strong></div><svg viewBox="0 0 600 200"><path d="M10 180 L90 80 L180 120 L270 60 L350 100 L450 30 L590 60" fill="none" stroke="#4892ff" stroke-width="3"/></svg>
<script src="chart.js"></script></body></html>`);
    await run(`
      window.htmlMessage = { id:'html-message', conversationId:'html-session', turnId:'html-turn', role:'assistant', createdAt:'2026-09-15T00:00:00Z',
        status:'completed', metadata:{transcript_kind:'assistant_final'}, content:'' };
      window.htmlPath = ${JSON.stringify(htmlPath)};
      window.htmlRender = () => renderView(h(views.MessageFileReferenceScope, {workspaceRoot:${JSON.stringify(directory.replaceAll('\\', '/'))}},
        h(views.MessageBubble, {message:htmlMessage, language:'zh', sending:htmlMessage.status==='streaming',
          activeTurnId:htmlMessage.status==='streaming'?'html-turn':'', activeAssistantMessageId:htmlMessage.status==='streaming'?'html-message':''})));
      window.htmlContent = content => { htmlMessage = {...htmlMessage, content}; htmlRender(); };
      htmlContent('[销售分析](<' + htmlPath + '>)');
    `);
    await until("document.querySelector('.local-file-reference') !== null", 'normal HTML file link');
    assert.equal(await run("document.querySelectorAll('webview').length"), 0, 'normal links do not execute HTML');
    await run("htmlMessage={...htmlMessage,status:'streaming',metadata:{}}; htmlContent('![销售分析](<' + htmlPath + '>)')");
    await pause();
    assert.equal(await run("document.querySelectorAll('.inline-html-preview, webview').length"), 0, 'incomplete assistant narration does not execute HTML');
    await run("htmlMessage={...htmlMessage,status:'completed',metadata:{transcript_kind:'assistant_final'}}; htmlRender()");
    await ready();
    let page = await guest();
    assert.equal(await page.executeJavaScript("document.getElementById('value').textContent"), '2025', 'relative JavaScript works');
    assert.equal(await page.executeJavaScript("getComputedStyle(document.getElementById('value')).color"), 'rgb(39, 174, 96)', 'relative stylesheet works');
    assert.deepEqual(await page.executeJavaScript('[typeof window.require, typeof window.process, typeof window.cardbushDesktop]'), ['undefined', 'undefined', 'undefined'], 'the page has no Node or host API');
    const identity = await page.executeJavaScript('chartInstance');
    const pageId = page.id;
    await page.executeJavaScript("document.querySelector('select').value='2026'; document.querySelector('select').dispatchEvent(new Event('change'))");
    await run("window.htmlRetained=document.querySelector('.inline-html-webview'); window.htmlHeight=document.querySelector('.inline-html-preview').getBoundingClientRect().height; void 0");
    for (let i = 0; i < 4; i++) {
      await run(`htmlMessage={...htmlMessage, toolExecutions:[{id:'edit',name:'edit_file',state:'running',summary:'Update ${i}',createdAt:'2026-09-15T00:00:00Z',metadata:{}}]}; htmlRender()`);
      await pause(60);
      assert.equal(await run("htmlRetained===document.querySelector('.inline-html-webview')"), true, 'tool changes retain the same guest element: ' + await run("JSON.stringify({connected:htmlRetained.isConnected,frame:!!document.querySelector('.inline-html-webview'),errors:failures,body:document.body.innerText})"));
    }
    assert.equal((await guest()).id, pageId, 'tool changes retain the same browser process');
    assert.equal(await page.executeJavaScript('chartInstance'), identity, 'the chart did not reload');
    assert.equal(await page.executeJavaScript("document.getElementById('value').textContent"), '2026', 'the selected filter survives tool updates');
    assert.equal(await run("document.querySelector('.inline-html-preview').getBoundingClientRect().height===htmlHeight"), true, 'updates do not change the preview height');
    await run("htmlMessage={...htmlMessage,toolExecutions:[]}; htmlContent('![销售分析](<./报表 #1.html>)')");
    await pause();
    assert.equal((await guest()).id, pageId, 'a relative reference resolves to the same page');
    for (const [theme, width] of [['theme-dark', 900], ['theme-bright', 440]]) {
      await run(`window.viewTheme=${JSON.stringify(theme)}; htmlRender()`);
      await pause();
      await run(`document.querySelector('.app').style.width='${width}px'`);
      await pause();
      assert.equal(await run("document.querySelector('.inline-html-preview').getBoundingClientRect().right <= document.querySelector('.app').getBoundingClientRect().right+1"), true, 'the page fits the conversation width');
      assert.equal(await run("getComputedStyle(document.querySelector('.inline-html-preview')).borderTopWidth"), '1px', 'existing reports retain the preview frame');
      assert.equal(await run("document.querySelector('.inline-html-menu-toggle')"), null, 'no floating button covers existing HTML');
      assert.equal(await run("document.querySelector('.inline-html-toolbar').getBoundingClientRect().bottom <= document.querySelector('.inline-html-viewport').getBoundingClientRect().top"), true, 'file actions stay above the document');
      assert.ok(await run("document.querySelector('.inline-html-viewport').clientHeight <= 520"), 'existing documents retain bounded previews');
      assert.equal(await page.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(245, 247, 250)', 'ordinary HTML keeps authored appearance');
      await fs.writeFile(path.join(parent, `html-reference-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await run("document.querySelector('[aria-label=\"重新加载 HTML\"]').click()");
    await ready();
    page = await guest();
    assert.notEqual(await page.executeJavaScript('chartInstance'), identity, 'manual reload is explicit');
    await run("window.htmlOpened=[]; addEventListener('cardbush:open-inspector',event=>htmlOpened.push(event.detail)); document.querySelector('[aria-label=\"在侧栏展开 HTML\"]').click()");
    assert.equal((await run('htmlOpened'))[0]?.target, htmlPath, 'expanded view targets the original file');
    // Exercise the shipped skill example, not a separate approximation of its
    // theme and responsive contract. No CDN/network is needed for this chart.
    const trendPath = path.join(directory, 'trend.html').replaceAll('\\', '/');
    await fs.copyFile(path.join(root, 'assets/skills/visualize/assets/trend.html'), trendPath);
    await run(`htmlContent('![月度趋势](<${trendPath}>)')`);
    await ready();
    page = await guest();
    const trendId = page.id;
    for (const [theme, width] of [['theme-dark', 900], ['theme-bright', 440], ['theme-dark', 320]]) {
      await run(`window.viewTheme=${JSON.stringify(theme)}; htmlRender()`);
      await run(`document.querySelector('.app').style.width='${width}px'`);
      await pause(180);
      const metrics = await page.executeJavaScript(`({
        theme: document.documentElement.dataset.cardbushTheme,
        background: getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
        color: getComputedStyle(document.querySelector('h1')).color,
        width: innerWidth, contentWidth: document.documentElement.scrollWidth,
        height: innerHeight, contentHeight: document.documentElement.scrollHeight,
        labelsFit: [...document.querySelectorAll('svg text')].every(el => {
          const box = el.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1;
        })
      })`);
      assert.equal(metrics.theme, theme === 'theme-dark' ? 'dark' : 'light', 'guest follows host theme');
      assert.equal(metrics.background, await run("getComputedStyle(document.querySelector('.app')).backgroundColor"), 'guest canvas matches actual conversation background, including non-white light themes');
      assert.equal(metrics.color, await run("getComputedStyle(document.querySelector('.app')).color"), 'chart text follows conversation theme');
      assert.ok(metrics.contentWidth <= metrics.width + 1, 'no horizontal scrolling');
      assert.ok(metrics.contentHeight <= metrics.height + 1, 'chart fits without internal scrolling');
      assert.ok(metrics.labelsFit, 'axis labels fit even at 320px');
      assert.equal((await guest()).id, trendId, 'theme/width updates preserve the guest');
      assert.equal(await run("getComputedStyle(document.querySelector('.inline-html-preview')).borderTopWidth"), '0px', 'chart has no outer card frame');
      assert.equal(await run("document.querySelector('.inline-html-heading').textContent.includes('交互图表') && document.querySelectorAll('.inline-html-rule').length >= 3"), true, 'lightweight start and end boundaries separate the chart from prose');
      assert.equal(await run("getComputedStyle(document.querySelector('.inline-html-toolbar')).display"), 'none', 'file toolbar is closed by default');
      await fs.writeFile(path.join(parent, `html-visualize-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await page.executeJavaScript("document.querySelector('select').value='7'; document.querySelector('select').dispatchEvent(new Event('change'))");
    assert.match(await page.executeJavaScript("document.querySelector('output').textContent"), /8月.*43.1/, 'keyboard-accessible month picker updates the value');
    await page.executeJavaScript("window.trustedChartClick=false; document.querySelector('svg').addEventListener('click', event => { trustedChartClick=event.isTrusted; }); void 0");
    await clickInChart(page, 'svg circle');
    assert.equal(await page.executeJavaScript('trustedChartClick'), true, 'the shipped chart receives native clicks');
    assert.match(await page.executeJavaScript("document.querySelector('output').textContent"), /^1月.*36.5/, 'clicking the first point changes the displayed month');
    await page.executeJavaScript("document.querySelector('select').value='7'; document.querySelector('select').dispatchEvent(new Event('change'))");
    const originalHeight = await run("document.querySelector('.inline-html-viewport').clientHeight");
    const originalWindowSize = window.getContentSize();
    window.setContentSize(1200, 500);
    await until("innerHeight < 800 && document.querySelector('.inline-html-viewport').clientHeight <= Math.min(520, Math.max(220,Math.round(innerHeight*0.6))) && Boolean(document.querySelector('.inline-html-expand-toggle'))", 'short windows have a smaller default preview');
    await run("document.querySelector('.inline-html-expand-toggle').focus()");
    window.webContents.focus();
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await until("document.querySelector('.inline-html-expand-toggle').getAttribute('aria-expanded') === 'true'", 'keyboard can expand a folded chart');
    await clickHost('.inline-html-collapse-top');
    await until("Boolean(document.querySelector('.inline-html-preview.is-folded'))", 'an explicit collapse is remembered');
    window.setContentSize(...originalWindowSize);
    await until("!document.querySelector('.inline-html-expand-toggle')", 'a short chart naturally fits again after enlarging the window');
    await page.executeJavaScript("window.extra=document.createElement('div'); extra.style.height='650px'; document.body.append(extra); void 0");
    await until("document.querySelector('.inline-html-preview.is-folded') && document.querySelector('.inline-html-expand-toggle')?.getAttribute('aria-expanded') === 'false'", 'long content gets a bounded preview and an explicit expansion control');
    assert.ok(await run("document.querySelector('.inline-html-viewport').clientHeight <= Math.min(520,Math.round(innerHeight*0.6))"), 'preview fits a portion of the window');
    const intrinsicHeight = await page.executeJavaScript('innerHeight');
    await clickHost('.inline-html-expand-toggle');
    await until(`document.querySelector('.inline-html-viewport').clientHeight >= ${originalHeight + 649}`, 'expansion reveals the complete chart');
    assert.equal((await guest()).id, trendId, 'expanding retains the same browser guest');
    assert.equal(await page.executeJavaScript('innerHeight'), intrinsicHeight, 'expansion does not resize the authored chart');
    assert.match(await page.executeJavaScript("document.querySelector('output').textContent"), /8月.*43.1/, 'expansion preserves selected data');
    await clickHost('.inline-html-collapse-top');
    await until("Boolean(document.querySelector('.inline-html-preview.is-folded'))", 'the top collapse control remains reachable on a long chart');
    assert.equal((await guest()).id, trendId);
    await clickHost('.inline-html-expand-toggle');
    await run("window.chartScroller=document.querySelector('.app'); chartScroller.style.overflowY='auto'; chartScroller.scrollTop=chartScroller.scrollHeight; void 0");
    await pause(80);
    assert.ok(await run("document.querySelector('.inline-html-preview').getBoundingClientRect().top < 0"), 'fixture reaches the bottom of the expanded chart');
    await clickHost('.inline-html-expand-toggle');
    await until("document.querySelector('.inline-html-preview.is-folded') && document.querySelector('.inline-html-preview').getBoundingClientRect().top >= 0", 'bottom collapse brings the chart start back into view');
    assert.equal(await run("document.activeElement === document.querySelector('.inline-html-expand-toggle')"), true, 'collapse retains keyboard focus on the reachable control');
    await run("chartScroller.style.overflowY=''; void 0");
    await page.executeJavaScript('extra.remove()');
    await until(`document.querySelector('.inline-html-viewport').clientHeight === ${originalHeight} && !document.querySelector('.inline-html-expand-toggle')`, 'removing content shrinks inline and removes fold controls');
    assert.match(await run("document.querySelector('.inline-html-footer').textContent"), /图表结束/, 'short charts have an explicit end');
    await run("document.querySelector('.inline-html-menu-toggle').click()");
    assert.equal(await run("getComputedStyle(document.querySelector('.inline-html-toolbar')).display"), 'flex', 'chart actions remain available');
    await run("document.querySelector('.inline-html-menu-toggle').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))");
    assert.equal(await run("document.querySelector('.inline-html-menu-toggle').getAttribute('aria-expanded')"), 'false', 'Escape dismisses options from keyboard focus');
    assert.match(await page.executeJavaScript("document.querySelector('output').textContent"), /8月.*43.1/, 'host presentation changes retain chart selection');
    await page.executeJavaScript("extra.style.height='3000px'; document.body.append(extra); void 0");
    await until("Boolean(document.querySelector('.inline-html-preview.is-folded'))", 'very long documents start folded');
    await clickHost('.inline-html-expand-toggle');
    await until("document.querySelector('.inline-html-viewport').clientHeight === 2400", 'long documents have a bounded preview');
    assert.match(await run("document.querySelector('.inline-html-footer').textContent"), /图内可继续滚动.*在侧栏查看/, 'oversized charts explain how to reach remaining content');
    assert.equal(await page.executeJavaScript('getComputedStyle(document.documentElement).scrollbarWidth'), 'none', 'inline chart scrollbar is hidden');
    assert.equal(await page.executeJavaScript('innerWidth-document.documentElement.clientWidth'), 0, 'hidden scrollbar reserves no gutter');
    await page.executeJavaScript("scrollTo(0,200); void 0");
    assert.ok(await page.executeJavaScript('scrollY > 0'), 'long charts remain scrollable without visible bars');
    await page.executeJavaScript("extra.style.cssText='height:120px;overflow:auto;scrollbar-width:auto;scrollbar-gutter:stable'; extra.innerHTML='<div style=\"height:600px\">Scrollable details</div>'; void 0");
    assert.equal(await page.executeJavaScript('getComputedStyle(extra).scrollbarWidth'), 'none', 'nested chart scrollers hide their bars too');
    await page.executeJavaScript('extra.scrollTop=80; void 0');
    assert.equal(await page.executeJavaScript('extra.scrollTop'), 80, 'nested details remain reachable');
    await page.executeJavaScript("extra.remove(); window.liveRegion=document.createElement('p'); liveRegion.style.cssText='position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'; document.body.append(liveRegion); void 0");
    await until(`document.querySelector('.inline-html-viewport').clientHeight > ${originalHeight + 1}`, 'out-of-flow live regions contribute to intrinsic height');
    await pause(120);
    assert.ok(await page.executeJavaScript('document.documentElement.scrollHeight <= innerHeight + 1'), 'live region creates no phantom inner scrolling');
    await page.executeJavaScript('liveRegion.remove()');
    await until(`document.querySelector('.inline-html-viewport').clientHeight === ${originalHeight}`, 'preview shrinks after removing out-of-flow content');
    if (process.env.CARDBUSH_HTML_REVIEW_FILE) {
      const reviewPath = path.join(directory, 'review.html').replaceAll('\\', '/');
      await fs.copyFile(process.env.CARDBUSH_HTML_REVIEW_FILE, reviewPath);
      await run(`window.viewTheme='theme-dark'; htmlContent('![图表复核](<${reviewPath}>)')`);
      await ready();
      page = await guest();
      await run("document.querySelector('.app').style.width='900px'");
      await pause(220);
      const layout = await page.executeJavaScript('({height:innerHeight,contentHeight:document.documentElement.scrollHeight,bodyHeight:document.body.scrollHeight,bodyBox:document.body.getBoundingClientRect().height,mainBottom:document.querySelector("main")?.getBoundingClientRect().bottom,lastBottom:document.querySelector(".sr-only")?.getBoundingClientRect().bottom,bar:getComputedStyle(document.documentElement).scrollbarWidth,gutter:innerWidth-document.documentElement.clientWidth})');
      assert.equal(layout.bar, 'none', 'reported chart hides scrollbar');
      assert.equal(layout.gutter, 0);
      assert.ok(layout.contentHeight <= layout.height + 1, 'reported chart expands to fit all content: ' + JSON.stringify(layout));
      assert.ok(await run("document.querySelector('.inline-html-viewport').clientHeight <= 520"), 'the real CPI chart starts as a bounded preview');
      await fs.writeFile(path.join(parent, 'html-reviewed-chart-folded.png'), (await window.webContents.capturePage()).toPNG());
      await clickHost('.inline-html-expand-toggle');
      assert.equal(await run("document.querySelector('.inline-html-expand-toggle').getAttribute('aria-expanded')"), 'true');
      if (await page.executeJavaScript("Boolean(document.querySelector('#chart-yoy'))")) {
        await page.executeJavaScript("window.chartClicks=[]; document.addEventListener('click', event => chartClicks.push({trusted:event.isTrusted,tag:event.target.tagName,text:event.target.textContent}),true); void 0");
        await clickInChart(page, '.legend .lg');
        assert.ok(await page.executeJavaScript("chartClicks.some(event => event.trusted && event.text === '全国')"), 'native legend click reaches the embedded HTML');
        assert.equal(await page.executeJavaScript("document.querySelector('.legend .lg').getAttribute('aria-pressed')"), 'false', 'national legend communicates its toggled state');
        assert.equal(await page.executeJavaScript("getComputedStyle(document.querySelector('#chart-yoy .line.main')).display"), 'none', 'clicking national hides its curve');
        assert.equal(await page.executeJavaScript("[...document.querySelectorAll('#chart-yoy .area,#chart-yoy .halo,#chart-yoy .dot.s1,#chart-yoy .callout')].every(node => getComputedStyle(node).display === 'none')"), true, 'national area, markers and latest annotation hide together');
        await clickInChart(page, '#chart-yoy .overlay');
        assert.equal(await page.executeJavaScript("document.querySelector('#chart-yoy .tip').hidden"), false, 'native plot click shows the existing tooltip');
        assert.equal(await page.executeJavaScript("document.querySelector('#chart-yoy .tip').textContent.includes('全国同比')"), false, 'hidden series is omitted from the tooltip');
        const retainedId = page.id;
        for (const [theme, width] of [['theme-bright',320], ['theme-dark',900]]) {
          await run(`window.viewTheme=${JSON.stringify(theme)}; htmlRender()`);
          await run(`document.querySelector('.app').style.width='${width}px'`);
          await pause(220);
          assert.equal((await guest()).id, retainedId);
          assert.equal(await page.executeJavaScript("getComputedStyle(document.querySelector('#chart-yoy .line.main')).display"), 'none', 'legend selection survives resize and theme change');
        }
        await clickInChart(page, 'button[data-series=city]');
        await clickInChart(page, 'button[data-series=rural]');
        assert.notEqual(await page.executeJavaScript("getComputedStyle(document.querySelector('.series-empty')).display"), 'none', 'all hidden has a visible recovery instruction');
        page.sendInputEvent({type:'keyDown',keyCode:'Space'});
        page.sendInputEvent({type:'keyUp',keyCode:'Space'});
        await pause(80);
        assert.equal(await page.executeJavaScript("document.querySelector('button[data-series=rural]').getAttribute('aria-pressed')"), 'true', 'Space restores the focused series');
        assert.notEqual(await page.executeJavaScript("getComputedStyle(document.querySelector('#chart-yoy .line.rural')).display"), 'none');
        await clickInChart(page, 'button[data-series=city]');
        await clickInChart(page, 'button[data-series=main]');
        assert.equal(await page.executeJavaScript("[...document.querySelectorAll('button[data-series]')].every(button => button.getAttribute('aria-pressed') === 'true')"), true, 'series can all be restored');
        console.log('Reported chart interactions passed: unoccluded hit targets, trusted pointer clicks, series/tooltip visibility, all-hidden recovery, keyboard and theme/resize retention.');
      }
      await fs.writeFile(path.join(parent, 'html-reviewed-chart.png'), (await window.webContents.capturePage()).toPNG());
    }
    await run(`htmlContent('![缺失文件](<${missingPath}>)')`);
    await until("document.querySelector('.inline-html-viewport.is-failed') !== null", 'missing HTML fallback');
    assert.equal(await run("document.querySelectorAll('webview').length"), 0, 'failed guests are removed without resetting the conversation');
    assert.equal(await run("document.querySelector('.inline-html-toolbar .local-file-reference')?.textContent"), '缺失文件', 'original file reference remains available');
    await fs.copyFile(htmlPath, missingPath);
    await run("document.querySelector('.inline-html-status button').click()");
    await ready();
    await run("htmlContent('```md\\n![销售分析](<' + htmlPath + '>)\\n```')");
    await pause();
    assert.equal(await run("document.querySelectorAll('webview').length"), 0, 'code samples never run');

    // A resolved memo uses the same renderer and keeps the guest across focus
    // refreshes, even when the returned file metadata is a new object.
    const memoSource = await fs.readFile(htmlPath, 'utf8');
    const memoFile = await fs.stat(htmlPath);
    await run(`
      window.memoReply = { status:'available', currentVersion:${JSON.stringify({size:memoFile.size,mtimeMs:memoFile.mtimeMs})}, memo:{ file:{path:htmlPath,name:'报表 #1.html',size:${memoFile.size},mtimeMs:${memoFile.mtimeMs}}, note:{purpose:'销售报表'} } };
      window.htmlMemoLoad = async () => structuredClone(memoReply);
      window.renderHtmlMemo = inline => renderView(h(views.FileMemoReference, { reference:'file-memo://fixture', inline, language:'zh', load:htmlMemoLoad }, '销售分析'));
      renderHtmlMemo(false);
    `);
    await until("document.querySelector('.file-memo-reference .local-file-reference') !== null", 'memo file link');
    assert.equal(await run("document.querySelectorAll('webview').length"), 0, 'normal memo references remain links');
    await run('renderHtmlMemo(true)');
    await ready();
    const memoPageId = (await guest()).id;
    await run("dispatchEvent(new Event('focus'))");
    await pause();
    assert.equal((await guest()).id, memoPageId, 'focus refresh keeps the same memo preview');
    let previousMemoId = memoPageId;
    for (const revision of [1, 2]) {
      await fs.writeFile(htmlPath, memoSource.replace('</body>', `<p id="memo-revision">Updated chart ${revision}</p></body>`));
      const version = await fs.stat(htmlPath);
      await run(`memoReply.status='changed'; memoReply.currentVersion=${JSON.stringify({size:version.size,mtimeMs:version.mtimeMs})}; dispatchEvent(new Event('focus'))`);
      await until(`document.querySelector('.inline-html-viewport.is-ready') && document.querySelector('.inline-html-webview').getWebContentsId() !== ${previousMemoId}`, 'edited memo reloads the current HTML in place');
      page = await guest();
      assert.equal(await page.executeJavaScript("document.getElementById('memo-revision').textContent"), `Updated chart ${revision}`, 'the updated file is rendered, not a stale cached chart');
      assert.equal(webContents.fromId(previousMemoId), undefined, 'old guest is released after a file edit');
      previousMemoId = page.id;
      await page.executeJavaScript("document.querySelector('select').value='2026'; document.querySelector('select').dispatchEvent(new Event('change'))");
      await run("dispatchEvent(new Event('focus'))");
      await pause();
      assert.equal((await guest()).id, page.id, 'changed status alone does not repeatedly reset the preview');
      assert.equal(await page.executeJavaScript("document.getElementById('value').textContent"), '2026', 'unchanged focus refresh retains chart interaction');
    }
    await run('renderHtmlMemo(false)');
    await until("!document.querySelector('webview') && document.querySelector('.file-memo-reference')?.textContent.includes('文件已变化')", 'ordinary changed references remain links');
    await run('renderHtmlMemo(true)');
    await ready();
    assert.equal(await (await guest()).executeJavaScript("document.getElementById('memo-revision').textContent"), 'Updated chart 2', 'reopening an already-changed memo still embeds its latest HTML');
    await run("memoReply.status='unavailable'; dispatchEvent(new Event('focus'))");
    await until("!document.querySelector('webview') && Boolean(document.querySelector('.local-file-reference-unavailable'))", 'missing files retain an accessible fallback');
    await run("memoReply.status='changed'; dispatchEvent(new Event('focus'))");
    await ready();
    assert.equal(await (await guest()).executeJavaScript("document.getElementById('memo-revision').textContent"), 'Updated chart 2', 'restored changed file recovers its preview');
    await run("delete memoReply.currentVersion; dispatchEvent(new Event('focus'))");
    await pause();
    await ready();
    const recoveredMemoId = (await guest()).id;
    assert.equal(await (await guest()).executeJavaScript("document.getElementById('memo-revision').textContent"), 'Updated chart 2', 'older runtime responses without a disk version still render changed HTML');
    if (process.env.CARDBUSH_HTML_REVIEW_FILE) {
      await run(`memoReply.memo.file.path=${JSON.stringify(process.env.CARDBUSH_HTML_REVIEW_FILE)}; memoReply.memo.file.name='china-cpi-trend.html'; dispatchEvent(new Event('focus'))`);
      await until(`document.querySelector('.inline-html-viewport.is-ready') && document.querySelector('.inline-html-webview').getWebContentsId() !== ${recoveredMemoId}`, 'reported CPI chart renders through its changed memo');
      assert.equal(await (await guest()).executeJavaScript("document.querySelectorAll('button[data-series]').length"), 3, 'updated CPI legend is present through the changed file reference');
      await pause(220);
      await fs.writeFile(path.join(parent, 'html-reviewed-changed-memo.png'), (await window.webContents.capturePage()).toPNG());
    }
    const finalMemoId = (await guest()).id;
    await run('renderView(null)');
    await pause();
    assert.equal(webContents.fromId(finalMemoId), undefined, 'unmount releases the guest');
    await require('./html-preview-updates.cjs')({ run, until, pause, window, root, directory, guest, ready, clickHost });
    await run(`
      window.savedThemeDesktop = window.cardbushDesktop;
      window.themeSnapshots = [];
      window.cardbushDesktop = {...window.cardbushDesktop, publishVisualTheme: async context => { themeSnapshots.push(context); }};
      window.ThemeProbe = ({theme, preference}) => {
        views.useVisualThemeContext(theme, preference);
        return h('div', {className:'main-stage',style:{background:'var(--surface)'}}, 'Theme probe');
      };
      window.viewTheme = 'theme-dark';
      renderView(h(ThemeProbe, {theme:'dark',preference:'system'}));
    `);
    await until('themeSnapshots.length > 0', 'current theme is published before generating a visual');
    assert.equal(await run('themeSnapshots.at(-1).colorScheme'), 'dark', 'snapshot resolves system preference to the actual scheme');
    assert.equal(await run('themeSnapshots.at(-1).background'), await run("getComputedStyle(document.querySelector('.main-stage')).backgroundColor"), 'snapshot captures conversation surface, not sidebar background');
    await run("document.querySelector('.app').style.setProperty('--surface','#243648'); document.querySelector('.app').style.setProperty('--text','#f1f4f8')");
    await until("themeSnapshots.at(-1).tokens['--surface']==='#243648'", 'custom palette changes refresh the snapshot');
    assert.equal(await run('themeSnapshots.at(-1).background'), 'rgb(36, 54, 72)', 'custom background is the computed color');
    await run("window.viewTheme='theme-bright'; renderView(h(ThemeProbe,{theme:'bright',preference:'light'}))");
    await until("themeSnapshots.at(-1).colorScheme==='light'", 'theme toggle updates snapshot');
    await run('renderView(null); window.cardbushDesktop = savedThemeDesktop; void 0');
    console.log('HTML references passed: links vs embeds, final-only execution, relative JS/CSS, isolation, preserved filters, reload, narrow view, missing-file retry and file memo rendering.');
  } finally {
    await run('renderView(null)');
    await pause();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.ok(path.basename(directory).startsWith('html-reference-test-'));
    await fs.rm(directory, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
  }
};
