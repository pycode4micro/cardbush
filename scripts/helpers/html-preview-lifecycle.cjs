const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const parent = path.join(root, 'tmp');
  const directory = await fs.mkdtemp(path.join(parent, 'html-lifecycle-'));
  const file = path.join(directory, 'interactive.html').replaceAll('\\', '/');
  const chart = path.join(directory, 'chart.html').replaceAll('\\', '/');
  const source = '<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;font:16px system-ui}section{height:260px}button{font:inherit}</style><section data-chart-section><h1>交互预览</h1><button onclick="this.textContent=\'已选择\'">选择</button></section><script>window.framesRun=0;function tick(){framesRun++;requestAnimationFrame(tick)}tick()</script>';
  try {
    await fs.writeFile(file, source);
    await fs.writeFile(chart, source.replace('<style>', '<meta name="cardbush:preview" content="visualization"><style>'));
    await run(`
      window.lifecycleMessages=Array.from({length:200},(_,index)=>({id:'html-'+index,turnId:'turn-'+index,conversationId:'lifecycle-session',
        role:'assistant',status:'completed',metadata:{transcript_kind:'assistant_final'},createdAt:'2026-09-18T00:00:00Z',
        content:'![预览 '+index+'](<'+(index%2?${JSON.stringify(chart)}:${JSON.stringify(file)})+'>)'}));
      window.lifecycleRender=()=>renderView(h('div',{className:'html-lifecycle-scroll',style:{height:480,width:820,overflowY:'auto',flex:'none'}},
        lifecycleMessages.map((message,index)=>h('div',{key:message.id,'data-preview-index':index,style:{height:680,boxSizing:'border-box'}},
          h(views.MessageBubble,{message,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''})))));
      window.lifecycleCard=index=>document.querySelector('[data-preview-index="'+index+'"]');
      window.lifecycleJump=index=>{document.querySelector('.html-lifecycle-scroll').scrollTop=index*680;};
      window.lifecycleIds=()=>[...document.querySelectorAll('.inline-html-webview')].flatMap(view=>{try{return [view.getWebContentsId()]}catch{return []}});
      lifecycleRender();
    `);
    const ready = index => until(`lifecycleCard(${index}).querySelector('.inline-html-viewport.is-ready')!==null`, 'visible preview '+index);
    const idAt = index => run(`lifecycleCard(${index}).querySelector('webview').getWebContentsId()`);
    const openIds = new Set();
    await ready(0);
    const first = await idAt(0); openIds.add(first);
    await webContents.fromId(first).executeJavaScript("document.querySelector('button').click()");
    await run('lifecycleJump(1)'); await ready(1); await pause(320);
    assert.equal(await idAt(0), first, 'one-screen neighbour retains its existing guest');
    assert.equal(await webContents.fromId(first).executeJavaScript("document.querySelector('button').textContent"), '已选择', 'nearby filters survive scroll');
    await run('lifecycleJump(80)');
    await until("!!lifecycleCard(80).querySelector('webview')", 'current viewport bypasses buffer preloading');
    await ready(80); await pause(400);
    assert.equal(webContents.fromId(first), undefined, 'far-away old guest is actually destroyed');
    assert.equal(await run("lifecycleCard(0).querySelector('.inline-html-viewport').clientHeight>300"), true, 'placeholder preserves scrolling geometry');
    assert.ok(await run("document.querySelectorAll('webview').length<=4"), '200 Turns do not create 200 guests');
    assert.equal(await run("(()=>{const scroller=document.querySelector('.html-lifecycle-scroll'),bounds=scroller.getBoundingClientRect();return [...document.querySelectorAll('.inline-html-webview')].every(view=>{const r=view.closest('.inline-html-preview').getBoundingClientRect();return r.bottom>bounds.top-scroller.clientHeight&&r.top<bounds.bottom+scroller.clientHeight})})()"), true, 'only visible and adjacent pages stay mounted');
    for (const index of [3, 160, 20, 198, 0]) {
      (await run('lifecycleIds()')).forEach(id => openIds.add(id));
      await run(`lifecycleJump(${index})`); await ready(index); await pause(60);
      assert.ok(await run("document.querySelectorAll('webview').length<=4"), 'fast scroll does not accumulate guests: '+index);
    }
    assert.notEqual(await idAt(0), first, 'the oldest Turn reloads when visible; no Turn count limit');

    const beforeClose = await idAt(0); openIds.add(beforeClose);
    await run("lifecycleCard(0).querySelector('.inline-html-close').click()");
    await until("lifecycleCard(0).querySelector('.inline-html-preview.is-closed')!==null", 'manual close');
    assert.equal(webContents.fromId(beforeClose), undefined);
    assert.equal(await run("lifecycleCard(0).querySelector('.inline-html-viewport')===null"), true, 'closed preview keeps no hidden viewport');
    assert.ok(await run("lifecycleCard(0).querySelector('.inline-html-preview').clientHeight<80"), 'closed preview is a compact file row');
    assert.equal(await run("document.activeElement===lifecycleCard(0).querySelector('.inline-html-reopen')"), true, 'close retains keyboard focus');
    await run("lifecycleMessages=lifecycleMessages.map(message=>({...message}));lifecycleRender();dispatchEvent(new Event('focus'))"); await pause(400);
    assert.equal(await run("lifecycleCard(0).querySelector('webview')===null"), true, 'transcript updates do not reopen manually closed content');
    await run('lifecycleJump(100)'); await ready(100);
    await run('lifecycleJump(0)'); await pause(400);
    assert.equal(await run("lifecycleCard(0).querySelector('webview')===null"), true, 'scrolling back respects manual close');
    await run("lifecycleCard(0).querySelector('.inline-html-reopen').click()"); await ready(0);
    const reopened = await idAt(0); openIds.add(reopened);
    assert.notEqual(reopened, beforeClose);

    // A late reload reply must not recreate a guest after the user closed it.
    await run("window.lifecycleLateGuest=lifecycleCard(0).querySelector('webview');const original=lifecycleLateGuest.executeJavaScript.bind(lifecycleLateGuest);lifecycleLateGuest.executeJavaScript=code=>code==='scrollY'?new Promise(resolve=>window.lifecycleFinishRead=resolve):original(code);lifecycleCard(0).querySelector('[aria-label=\"重新加载 HTML\"]').click()");
    await until("typeof lifecycleFinishRead==='function'", 'reload read is pending');
    await run("lifecycleCard(0).querySelector('.inline-html-close').click();lifecycleFinishRead(0)"); await pause(200);
    assert.equal(await run("lifecycleCard(0).querySelector('webview')===null"), true, 'late reload cannot reopen a closed preview');

    await run('lifecycleJump(1)'); await ready(1);
    const vizId = await idAt(1); openIds.add(vizId);
    await until("lifecycleCard(1).querySelector('.inline-html-heading .inline-html-close')!==null", 'visualization has a visible close action');
    await run("lifecycleCard(1).querySelector('.inline-html-heading .inline-html-close').click()"); await pause();
    assert.equal(webContents.fromId(vizId), undefined, 'visualization close destroys its guest too');
    await run("lifecycleCard(1).querySelector('.inline-html-reopen').click()"); await ready(1);
    const pageGuests = await run('lifecycleIds()');
    await run("Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.lifecyclePageHidden?'hidden':'visible'});window.lifecyclePageHidden=true;document.dispatchEvent(new Event('visibilitychange'))");
    await until("document.querySelectorAll('webview').length===0", 'hidden page releases all guests');
    assert.ok(pageGuests.every(id => !webContents.fromId(id)));
    await run("window.lifecyclePageHidden=false;document.dispatchEvent(new Event('visibilitychange'))"); await ready(1);

    await window.webContents.insertCSS(await fs.readFile(path.join(root,'src/styles/themes/cyberpunk.css'),'utf8'));
    for (const theme of ['theme-bright','theme-dark','theme-dark theme-cyberpunk']) {
      await run(`viewTheme=${JSON.stringify(theme)};lifecycleRender()`); await pause();
      const button = await run("(()=>{const button=lifecycleCard(1).querySelector('.inline-html-close'),r=button.getBoundingClientRect();return {width:r.width,height:r.height,color:getComputedStyle(button).color,inside:r.left>=0&&r.right<=820}})()");
      assert.ok(button.width>=24 && button.height>=24 && button.inside);
      await fs.writeFile(path.join(parent,`html-lifecycle-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    }
    (await run('lifecycleIds()')).forEach(id => openIds.add(id));
    await run('renderView(null)'); await pause();
    assert.ok([...openIds].every(id => !webContents.fromId(id)), 'no visited guest survives leaving the conversation');
    assert.equal(webContents.getAllWebContents().filter(view=>view.getType()==='webview').length, 0, 'all preview guests are disposed');
    console.log('HTML lifecycle passed: 200 Turns, visible-first loading, viewport buffers, real guest destruction, preserved nearby interaction, manual close/reopen, late reload, hidden page and 3 themes.');
  } finally {
    await run("renderView(null);delete document.visibilityState;window.lifecycleLateGuest=null;window.lifecycleFinishRead=null;"); await pause();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.ok(path.basename(directory).startsWith('html-lifecycle-'));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
};
