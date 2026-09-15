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
  try {
    await fs.writeFile(path.join(directory, 'chart.css'), 'body{margin:0;padding:24px;font:14px system-ui;background:#17191d;color:#e4e7ec}h1{font-size:20px}svg{display:block;width:100%;height:220px}#value{color:rgb(39, 174, 96)}select{margin:12px 0}');
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
      await fs.writeFile(path.join(parent, `html-reference-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await run("document.querySelector('[aria-label=\"重新加载 HTML\"]').click()");
    await ready();
    page = await guest();
    assert.notEqual(await page.executeJavaScript('chartInstance'), identity, 'manual reload is explicit');
    await run("window.htmlOpened=[]; addEventListener('cardbush:open-inspector',event=>htmlOpened.push(event.detail)); document.querySelector('[aria-label=\"在侧栏展开 HTML\"]').click()");
    assert.equal((await run('htmlOpened'))[0]?.target, htmlPath, 'expanded view targets the original file');
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
    await run(`
      window.memoReply = { status:'available', memo:{ file:{path:htmlPath,name:'报表 #1.html',size:10,mtimeMs:1}, note:{purpose:'销售报表'} } };
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
    await run("memoReply.status='changed'; dispatchEvent(new Event('focus'))");
    await until("document.querySelector('.file-memo-reference')?.textContent.includes('文件已变化')", 'changed memo uses existing availability rules');
    assert.equal(await run("document.querySelectorAll('webview').length"), 0, 'changed memo is offered as a link rather than silently executing new content');
    await run('renderView(null)');
    await pause();
    assert.equal(webContents.fromId(memoPageId), undefined, 'unmount releases the guest');
    console.log('HTML references passed: links vs embeds, final-only execution, relative JS/CSS, isolation, preserved filters, reload, narrow view, missing-file retry and file memo rendering.');
  } finally {
    await run('renderView(null)');
    await pause();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.ok(path.basename(directory).startsWith('html-reference-test-'));
    await fs.rm(directory, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
  }
};
