const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const originalSize = window.getContentSize();
  const style = await window.webContents.insertCSS('.app { width:100% !important; }');
  await run(`
    window.resizeSavedProps = { ...chatProps }; window.resizeSavedTheme = window.viewTheme;
    updateChat({ language:'zh', loading:false, historyLoading:false, draft:'', messages:[
      {id:'resize-user',role:'user',content:'检查窗口还原后的输入框'},
      {id:'resize-answer',role:'assistant',content:'输入框应按当前宽度和内容计算高度。'},
    ], onDraftChange:draft => updateChat({draft}) });
    window.composerSize = () => {
      const input=document.querySelector('textarea[data-composer-input]');
      return {height:input.getBoundingClientRect().height,width:input.clientWidth,
        scrollHeight:input.scrollHeight,inlineHeight:input.style.height,value:input.value,
        surface:document.querySelector('.composer-surface').getBoundingClientRect().height};
    };
    void 0;
  `);
  try {
    assert.equal(await run("CSS.supports('field-sizing', 'content')"), true, 'bundled Chromium supports intrinsic textarea sizing');
    await until("!!document.querySelector('.message-list textarea') || !!document.querySelector('.composer-dock textarea')", 'conversation composer');
    const baseline = await run('composerSize()');
    await run(`window.resizeInput = document.querySelector('textarea[data-composer-input]');
      resizeInput.focus(); document.querySelector('.composer-stack').style.width='64px';
      dispatchEvent(new Event('resize'));`);
    await pause(100);
    const temporary = await run('composerSize()');
    // A window resize and the inspector's following layout commit happen in
    // different frames. Restoring the pane must remeasure without another
    // window resize, draft change, or remount.
    await run("document.querySelector('.composer-stack').style.removeProperty('width')");
    await pause(200);
    const restored = await run('composerSize()');
    console.log('Composer restore geometry:', JSON.stringify({baseline,temporary,restored}));
    fs.writeFileSync(path.join(root, 'tmp/composer-window-restored.png'), (await window.capturePage()).toPNG());
    assert.ok(restored.height <= baseline.height + 1, 'empty composer shrinks after its pane width settles');
    assert.equal(await run("document.querySelector('textarea[data-composer-input]') === resizeInput && document.activeElement === resizeInput"), true, 'width changes retain the input and focus');

    const draft = '窗口大小变化后保留草稿与光标，输入框应重新计算换行。'.repeat(4);
    await run(`updateChat({draft:${JSON.stringify(draft)}})`);
    await until(`composerSize().value === ${JSON.stringify(draft)}`, 'draft loaded');
    await run('resizeInput.focus(); resizeInput.setSelectionRange(5, 12)');
    const wideDraft = await run('composerSize()');
    await run("document.querySelector('.composer-stack').style.width='240px'");
    await pause(150);
    const narrowDraft = await run('composerSize()');
    assert.ok(narrowDraft.height > wideDraft.height, 'wrapping drafts grow when the pane narrows without a window resize');
    await run("document.querySelector('.composer-stack').style.removeProperty('width')");
    await pause(150);
    assert.ok(Math.abs((await run('composerSize()')).height - wideDraft.height) <= 1, 'draft shrinks back after the pane widens');
    assert.deepEqual(await run('({value:resizeInput.value,start:resizeInput.selectionStart,end:resizeInput.selectionEnd})'), {value:draft,start:5,end:12});

    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`window.viewTheme=${JSON.stringify(theme)};updateChat({draft:''})`);
      for (const [width, height] of [[1920,1040],[1180,760],[960,620],[1180,760]]) {
        window.setContentSize(width, height);
        await pause(120);
        assert.ok((await run('composerSize()')).height <= baseline.height + 1, `empty composer after ${width}x${height}`);
      }
    }
    await run(`updateChat({draft:${JSON.stringify('多行草稿\n'.repeat(50))}})`);
    await until('composerSize().height > 100', 'long draft grows');
    assert.ok((await run('composerSize()')).height <= 220, 'long drafts remain bounded');
    assert.equal(await run("getComputedStyle(resizeInput).overflowY"), 'auto', 'long drafts can scroll');
    await run("updateChat({draft:''})");
    await until(`composerSize().height <= ${baseline.height + 1}`, 'clearing the draft restores compact height');

    // Opening an inspector narrows the composer without changing the viewport.
    // Check actual hit targets and SVG geometry, including the running states.
    await run(`
      window.resizeSavedShadowOpener = window.cardbushDesktop.openShadowWindow;
      window.cardbushDesktop.openShadowWindow = async () => {};
      window.toolbarGeometry = () => {
        const footer = document.querySelector('.composer-footer');
        const send = footer.querySelector('.send-button');
        const rect = send.getBoundingClientRect();
        const bounds = footer.getBoundingClientRect();
        return {
          send: { width: rect.width, height: rect.height, inside: rect.left >= bounds.left && rect.right <= bounds.right + 1,
            hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === send },
          icons: [...footer.querySelectorAll('svg, img')].filter(svg => svg.getClientRects().length).map(svg => {
            const style = getComputedStyle(svg);
            return { name: svg.getAttribute('class'), width: parseFloat(style.width), height: parseFloat(style.height) };
          }),
          clipped: [...footer.querySelectorAll('button')].filter(button => {
            const box = button.getBoundingClientRect();
            const group = button.parentElement.getBoundingClientRect();
            return box.left < group.left - 1 || box.right > group.right + 1;
          }).map(button => button.className),
        };
      };
      updateChat({ shadowAvailable: true, queuedMessageCount: 3, permissionMode: 'all_free', selectedModel: 'long-model',
        availableModels: [{id:'long-model',provider:'deepseek',modelName:'deepseek-v4-1-with-a-long-model-name',apiKey:'',baseUrl:''}] });
    `);
    for (const [theme, language] of [['theme-dark', 'zh'], ['theme-bright', 'en']]) {
      await run(`window.viewTheme=${JSON.stringify(theme)}; updateChat({language:${JSON.stringify(language)}})`);
      for (const width of [460, 340, 280, 240]) {
        await run(`document.querySelector('.composer-stack').style.width='${width}px'`);
        for (const state of ['send', 'stop', 'stopping']) {
          await run(`updateChat({draft:'', sending:${state !== 'send'}, stopping:${state === 'stopping'}, activeTurnId:${JSON.stringify(state === 'send' ? '' : 'toolbar-turn')}})`);
          await until(`!!document.querySelector('.send-button .lucide-${state === 'send' ? 'arrow-up' : state === 'stop' ? 'square' : 'loader-circle'}')`, state + ' icon');
          const geometry = await run('toolbarGeometry()');
          const label = `${theme}, ${width}px, ${state}: ${JSON.stringify(geometry)}`;
          assert.ok(geometry.send.width >= 28 && Math.abs(geometry.send.width - geometry.send.height) < 0.5, 'circular send/stop target: ' + label);
          assert.ok(geometry.send.inside && geometry.send.hit, 'send/stop remains visible and clickable: ' + label);
          assert.deepEqual(geometry.clipped, [], 'toolbar buttons are not partially clipped: ' + label);
          for (const icon of geometry.icons) assert.ok(Math.abs(icon.width - icon.height) < 0.5, 'icons retain their aspect ratio: ' + label);
        }
        if (width === 340) fs.writeFileSync(path.join(root, `tmp/composer-toolbar-${theme}.png`), (await window.capturePage()).toPNG());
      }
    }
    await run("document.querySelector('.composer-stack').style.removeProperty('width')");
    assert.equal(await run("getComputedStyle(document.querySelector('.permission-center-button span')).display !== 'none' && getComputedStyle(document.querySelector('.model-select span')).display !== 'none'"), true, 'wide composer restores labels');
    await run("updateChat({messages:[], sending:false, stopping:false, activeTurnId:'', draft:'', queuedMessageCount:0})");
    await until("!!document.querySelector('.welcome-composer .send-button .lucide-arrow-up')", 'welcome composer');
    await run("document.querySelector('.composer-stack').style.width='240px'");
    const welcome = await run('toolbarGeometry()');
    assert.equal(welcome.send.width, welcome.send.height, 'welcome send target remains circular');
    assert.ok(welcome.send.inside && welcome.send.hit, 'welcome send is visible and clickable');
    assert.deepEqual(welcome.clipped, [], 'welcome toolbar fits');
    await run("document.querySelector('.composer-stack').style.removeProperty('width')");
    console.log('Composer resize passed: pane recovery, stable caret/draft, bounded long drafts, narrow send/stop/spinner hit targets, icon proportions, welcome/history, restored labels and themes.');
  } finally {
    window.setContentSize(...originalSize);
    await run('window.viewTheme=resizeSavedTheme; window.cardbushDesktop.openShadowWindow=window.resizeSavedShadowOpener; updateChat(resizeSavedProps)');
    await window.webContents.removeInsertedCSS(style);
  }
};
