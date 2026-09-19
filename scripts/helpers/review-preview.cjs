const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const parent = path.join(root, 'tmp');
  const directory = await fs.mkdtemp(path.join(parent, 'review-preview-'));
  const local = name => path.join(directory, name).replaceAll('\\', '/');
  const html = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="preview.css"><h1>Rendered HTML</h1><button onclick="this.textContent=\'Clicked\'">Try interaction</button><script>window.loads=1</script>';
  const text = Array.from({ length: 24000 }, (_, i) => `const line${i + 1} = "完整内容 ${i + 1}";`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 43 >>\nstream\nBT /F1 16 Tf 30 100 Td (PDF preview) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await Promise.all([
    fs.writeFile(local('page.html'), html), fs.writeFile(local('preview.css'), 'h1{color:rgb(20,80,140)}body{font-family:system-ui}'),
    fs.writeFile(local('sample.pdf'), pdf), fs.writeFile(local('large.ts'), text),
    fs.writeFile(local('image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')),
  ]);
  try {
    await run(`
      window.reviewTestRoot=${JSON.stringify(directory.replaceAll('\\', '/'))};
      window.reviewTestPath=reviewTestRoot+'/image.png'; window.reviewTestWidth=840;
      window.reviewTestReports=[];
      window.reviewPreviewReads=[];
      window.longPreviewText='x'.repeat(1000000)+'😀 END OF LONG LINE';
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async content=>{window.copiedPreview=content;}}});
      cardbushDesktop.readWorkspaceDirectory=async()=>({entries:['image.png','sample.pdf','page.html','large.ts','README.md','unknown.npy'].map(name=>({name,path:reviewTestRoot+'/'+name,kind:'file'}))});
      cardbushDesktop.readTextPreview=async path=>{ reviewPreviewReads.push(path); return {path,content:path.endsWith('.ts')?${JSON.stringify(text)}:path.endsWith('long.json')?longPreviewText:path.endsWith('.html')?${JSON.stringify(html)}:'# Rendered Markdown',truncated:false}; };
      window.renderReviewPreview=()=>renderView(h('aside',{className:'right-inspector',style:{height:'100%',width:reviewTestWidth+'px',maxWidth:'none',flex:'none'}},h(views.ConversationChangeDialog,{
        embedded:true,language:'zh',conversation:{id:'preview-review',title:'Preview',projectDir:reviewTestRoot},
        reports:reviewTestReports,initialFilePath:reviewTestPath,notice:'',revertingChangeId:'',revertedChangeIds:new Set(),onClose:()=>{},onRevert:async()=>{},
      })));
      window.selectReviewFile=name=>{reviewTestPath=reviewTestRoot+'/'+name;renderReviewPreview();};
      renderReviewPreview();
    `);
    await until("document.querySelector('.inspector-media-preview img')?.naturalWidth === 1", 'PNG decodes inside review');
    assert.equal(await run('reviewPreviewReads.length'), 0, 'image does not enter the text decoder');
    await run("selectReviewFile('page.html')");
    await until("!!document.querySelector('.right-inspector-preview.ready webview')", 'HTML guest ready');
    const guestId = await run("document.querySelector('webview').getWebContentsId()");
    const guest = webContents.fromId(guestId);
    assert.equal(await guest.executeJavaScript('document.querySelector("h1").textContent'), 'Rendered HTML');
    assert.equal(await guest.executeJavaScript('getComputedStyle(document.querySelector("h1")).color'), 'rgb(20, 80, 140)', 'HTML resolves relative resources');
    assert.equal(await guest.executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'), 'Clicked');
    assert.equal(await run('reviewPreviewReads.length'), 0, 'HTML renders without an eager source read');
    const widths = await run(`new Promise(async resolve=>{
      const values=[];const view=document.querySelector('webview');
      const observer=new ResizeObserver(entries=>values.push(entries[0].contentRect.width)); observer.observe(view);
      for(let index=0;index<18;index++){reviewTestWidth=840-index*8;renderReviewPreview();await new Promise(requestAnimationFrame);}
      setTimeout(()=>{observer.disconnect();resolve(values)},500);
    })`);
    assert.ok(widths[0] - widths.at(-1) > 100, 'fixture actually changes the preview viewport width: ' + widths);
    assert.ok(new Set(widths.map(Math.round)).size <= 3, 'dragging does not relayout the guest on every pointer frame: ' + widths);
    assert.equal(await run("document.querySelector('webview').getWebContentsId()"), guestId, 'resizing preserves the guest');
    assert.equal(await guest.executeJavaScript('document.querySelector("button").textContent'), 'Clicked', 'resizing preserves page state');
    await run("document.querySelector('.review-preview-modes button[title=源码]').click()");
    await until("document.querySelector('.source-inspector-preview')?.textContent.includes('<!doctype html>')", 'explicit HTML source view');
    assert.equal(webContents.fromId(guestId), undefined, 'source view releases the hidden guest');
    await run("document.querySelector('.review-preview-modes button[title=预览]').click()");
    await until("!!document.querySelector('.right-inspector-preview.ready webview')", 'return to rendered HTML');
    await pause(350);
    assert.ok(await run("document.querySelector('webview').clientHeight > 400"), 'rendered page has a usable viewport');
    await fs.writeFile(path.join(root, 'tmp', 'review-preview-html.png'), (await window.webContents.capturePage()).toPNG());
    await run("selectReviewFile('sample.pdf')");
    await until("!!document.querySelector('.right-inspector-preview.ready webview[src$=\"sample.pdf\"]')", 'PDF guest ready');
    const pdfGuest = webContents.fromId(await run("document.querySelector('webview').getWebContentsId()"));
    let pdfFrame;
    for (let attempt = 0; attempt < 40; attempt++) {
      pdfFrame = pdfGuest.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('chrome-extension:'));
      if (pdfFrame && await pdfFrame.executeJavaScript('!!document.querySelector("pdf-viewer")')) break;
      await pause(50);
    }
    assert.ok(pdfFrame && await pdfFrame.executeJavaScript('!!document.querySelector("pdf-viewer")'), 'PDF uses Chromium PDF rendering');
    await pause(250);
    await fs.writeFile(path.join(root, 'tmp', 'review-preview-pdf.png'), (await window.webContents.capturePage()).toPNG());
    assert.equal(await run("!!document.querySelector('.inspector-file-fallback')"), false);
    assert.equal(await run("reviewPreviewReads.some(path=>path.endsWith('.pdf'))"), false, 'PDF never enters the text decoder');
    await run("selectReviewFile('README.md')");
    await until("document.querySelector('.markdown-content h1')?.textContent==='Rendered Markdown'", 'Markdown is rendered inside review');
    await run("selectReviewFile('large.ts')");
    await until("!!document.querySelector('[data-render-mode=virtual] .source-code-line')", 'large source uses visible blocks');
    assert.ok(await run("document.querySelectorAll('.source-code-line').length") < 240, '24k lines keep a bounded DOM');
    assert.ok(await run("document.querySelectorAll('.source-virtual-block code span').length") > 0, 'large source still has syntax highlighting');
    await run("window.largeCodeScroll=document.querySelector('.source-inspector-document'); largeCodeScroll.scrollTop=largeCodeScroll.scrollHeight;");
    await until("document.querySelector('[data-source-line=\"24000\"]')?.textContent.includes('完整内容 24000')", 'last source line remains accessible');
    assert.ok(await run("document.querySelectorAll('.source-code-line').length") < 240);
    const readsBeforeDrag = await run('reviewPreviewReads.length');
    const sourceWidths = await run(`new Promise(async resolve=>{
      const values=[], handle=document.querySelector('.change-review-column-resizer');
      const start=handle.getBoundingClientRect().x+4;
      const scroller=largeCodeScroll;
      const observer=new ResizeObserver(entries=>values.push(entries[0].contentRect.width));observer.observe(scroller);
      handle.setPointerCapture=()=>{};
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:17,clientX:start}));
      for(let i=1;i<=18;i++) {window.dispatchEvent(new PointerEvent('pointermove',{pointerId:17,clientX:start-i*4}));await new Promise(requestAnimationFrame);}
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17,clientX:start-72}));
      setTimeout(()=>{observer.disconnect();resolve(values)},500);
    })`);
    assert.ok(sourceWidths[0] - sourceWidths.at(-1) >= 70, 'inner file-list divider actually resizes the document: ' + sourceWidths);
    assert.ok(new Set(sourceWidths.map(Math.round)).size <= 3, 'large source reflows after the drag instead of each frame: ' + sourceWidths);
    assert.equal(await run("largeCodeScroll===document.querySelector('.source-inspector-document')"), true, 'drag retains the source scroll element');
    assert.equal(await run('reviewPreviewReads.length'), readsBeforeDrag, 'resizing never rereads the file');
    assert.ok(await run(`(() => {const toolbar=document.querySelector('.source-virtual-toolbar').getBoundingClientRect(),viewport=largeCodeScroll.getBoundingClientRect();return toolbar.top>=viewport.top&&toolbar.bottom<viewport.bottom})()`), 'copy control stays visible when reading the tail');
    await fs.writeFile(path.join(root, 'tmp', 'review-preview-source.png'), (await window.webContents.capturePage()).toPNG());
    await run("document.querySelector('.source-virtual-toolbar button').click()");
    await until(`copiedPreview===${JSON.stringify(text)}`, 'copy includes the entire loaded source, not just visible rows');
    await run("selectReviewFile('long.json')");
    await until("document.querySelector('.change-review-file-heading strong')?.title.endsWith('long.json') && document.querySelector('[data-render-mode=virtual] .source-code-line code')?.textContent.startsWith('xxx')", 'long single line is split into bounded display fragments');
    assert.ok(await run("[...document.querySelectorAll('.source-code-line code')].every(node=>node.textContent.length<=4096)"), 'minified text does not create a million-character layout node');
    await until("document.querySelector('.source-inspector-document').scrollHeight > 20000", 'long-line scroll range is measured');
    await run("window.longScroller=document.querySelector('.source-inspector-document');longScroller.scrollTop=longScroller.scrollHeight;");
    await until("document.querySelector('.source-virtual-lines')?.textContent.includes('😀 END OF LONG LINE')", 'long-line tail is reachable without splitting Unicode');
    await run("document.querySelector('.source-virtual-toolbar button').click()");
    await until('copiedPreview===longPreviewText', 'long-line copy preserves every character');
    await run("selectReviewFile('unknown.npy')");
    await until("!!document.querySelector('.inspector-file-fallback')", 'unknown binary retains explicit fallback');
    assert.equal(await run("reviewPreviewReads.some(path=>path.endsWith('.npy'))"), false, 'unknown binary is not sent to a text parser');
    await run(`reviewTestReports=[{id:'changed-files',turnId:'edit-turn',createdAt:'2026-09-19T00:00:00Z',fileCount:2,additions:1,deletions:0,
      files:[{path:reviewTestRoot+'/image.png',additions:0,deletions:0,lines:[]},
        {path:reviewTestRoot+'/page.html',additions:1,deletions:0,lines:[{kind:'addition',text:'+<h1>Changed page</h1>'}]}]}];
      selectReviewFile('image.png');`);
    await until("document.querySelector('.inspector-media-preview img')?.naturalWidth===1", 'changed images render instead of an empty diff');
    assert.equal(await run("document.querySelector('.change-review-source-note').textContent"), '当前文件内容');
    await run("selectReviewFile('page.html')");
    await until("document.querySelector('.tool-file-change')?.textContent.includes('Changed page')", 'changed HTML initially preserves its review diff');
    await run("document.querySelector('.change-review-preview-toggle').click()");
    await until("!!document.querySelector('.right-inspector-preview.ready webview')", 'changed HTML can show the rendered current page');
    await run("document.querySelector('.change-review-preview-toggle').click()");
    await until("document.querySelector('.tool-file-change')?.textContent.includes('Changed page')", 'preview returns to the original diff');
    console.log('Review previews: real PNG, HTML resources/interaction/source toggle, PDF embed, Markdown, bounded 24k-line source, deferred drag reflow and guest lifecycle passed.');
  } finally {
    await run('renderView(null)');
    window.webContents.session.protocol.unhandle('cardbush-file');
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(parent) + path.sep + 'review-preview-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
