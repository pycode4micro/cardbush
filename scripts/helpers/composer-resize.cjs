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
    console.log('Composer resize passed: transient narrow pane recovery, content wrapping, stable caret/draft, repeated viewport restoration, themes and bounded long drafts.');
  } finally {
    window.setContentSize(...originalSize);
    await run('window.viewTheme=resizeSavedTheme; updateChat(resizeSavedProps)');
    await window.webContents.removeInsertedCSS(style);
  }
};
