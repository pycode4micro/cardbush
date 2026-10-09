const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const draft = '我需要每天整理几条适合直播的短视频，保留完整的要求和引用。\n\n视频用于产品口播、互动和有创意的展示。\n每位主播每天三条，成片控制在十五秒以内。\n';
  await run(`
    window.multilineInput = document.querySelector('[data-composer-input]');
    window.composerLayout = () => {
      const surface = document.querySelector('.composer-surface');
      const input = surface.querySelector('[data-composer-input]');
      const actions = surface.querySelector('.composer-actions');
      const rect = input.getBoundingClientRect(), bounds = surface.getBoundingClientRect();
      const style = getComputedStyle(surface), toolbar = actions.getBoundingClientRect();
      return {
        stacked: toolbar.top >= rect.bottom,
        fullWidth: Math.abs(rect.width - (surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))) < 1,
        height: bounds.height, inputHeight: rect.height, lineHeight: parseFloat(getComputedStyle(input).lineHeight),
        contained: surface.scrollWidth <= surface.clientWidth + 1 && [...surface.querySelectorAll('.composer-footer button')]
          .filter(button => button.getClientRects().length).every(button => {
            const box = button.getBoundingClientRect();
            return box.left >= bounds.left && box.right <= bounds.right + 1 && box.bottom <= bounds.bottom;
          }),
      };
    };
    updateChat({draft:${JSON.stringify(draft)}});
  `);
  await until('composerLayout().stacked && composerLayout().fullWidth', 'multiline prompt above its toolbar');
  await run('multilineInput.focus();multilineInput.setSelectionRange(5,12)');
  assert.equal(await run('composerLayout().contained'), true, 'toolbar fits under the full-width text');
  await pause(100);
  fs.writeFileSync(path.join(root, 'tmp/composer-multiline-dark.png'), (await window.webContents.capturePage()).toPNG());
  for (const width of [300, 680]) {
    await run(`document.querySelector('.composer-stack').style.width='${width}px'`);
    await pause(100);
    assert.deepEqual(await run('({stacked:composerLayout().stacked,fullWidth:composerLayout().fullWidth,contained:composerLayout().contained})'),
      {stacked:true,fullWidth:true,contained:true}, 'full-width text and reachable toolbar at ' + width);
    assert.deepEqual(await run('({same:document.querySelector("[data-composer-input]")===multilineInput,focused:document.activeElement===multilineInput,start:multilineInput.selectionStart,end:multilineInput.selectionEnd})'),
      {same:true,focused:true,start:5,end:12}, 'layout changes preserve the editor and selection');
  }
  await run('document.querySelector(".composer-stack").style.removeProperty("width");document.querySelector(".app").classList.replace("theme-dark","theme-light")');
  await pause();
  fs.writeFileSync(path.join(root, 'tmp/composer-multiline-light.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.querySelector(".app").classList.replace("theme-light","theme-dark");updateChat({draft:"短句"})');
  await until('!composerLayout().stacked', 'deleting multiline text restores the compact row');
  // This text fits a full-width line, but not the compact input beside its buttons.
  await run(`(() => {
    const input=multilineInput, surface=input.parentElement, style=getComputedStyle(surface);
    const context=document.createElement('canvas').getContext('2d');context.font=getComputedStyle(input).font;
    const fullWidth=surface.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    window.wrappedDraft='测'.repeat(Math.floor((fullWidth+input.clientWidth)/2/context.measureText('测').width));
    updateChat({draft:wrappedDraft});
  })()`);
  await until('composerLayout().stacked', 'soft wrapping expands without authored newlines');
  const stable = await run(`(async()=>{const samples=[];for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);samples.push(composerLayout());}return samples;})()`);
  assert.ok(stable.every(sample => sample.stacked && sample.fullWidth && sample.height === stable[0].height), 'a one-line expanded prompt never oscillates between layouts');
  assert.ok(stable[0].inputHeight < stable[0].lineHeight * 1.5, 'boundary fixture fits one expanded line');
  await run('document.querySelector(".composer-stack").style.setProperty("--ui-font-scale","1.4")');
  await pause(100);
  assert.equal(await run('composerLayout().stacked && composerLayout().fullWidth && composerLayout().contained'), true, 'larger fonts retain the stacked layout');
  await run('document.querySelector(".composer-stack").style.removeProperty("--ui-font-scale");updateChat({draft:""})');
  await until('!composerLayout().stacked', 'cleared input is compact');

  // References use contentEditable, including during native Shift+Enter input.
  await run('multilineInput.focus()');
  await window.webContents.insertText('@插件');
  await until('!!document.querySelector("[data-command-id=\\"application:builtin:plugins\\"]")', 'reference menu');
  await run('document.querySelector("[data-command-id=\\"application:builtin:plugins\\"]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
  await until('!!document.querySelector(".composer-context-token")', 'rich reference input');
  assert.equal(await run('composerLayout().stacked'), false, 'one reference does not expand the compact row');
  await run(`(() => { const input=document.querySelector('[data-composer-input]');input.focus();
    const range=document.createRange();range.selectNodeContents(input);range.collapse(false);
    getSelection().removeAllRanges();getSelection().addRange(range); })()`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers:['shift']});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers:['shift']});
  await until('chatProps.draft.endsWith("\\n") && composerLayout().stacked', 'native newline in reference input');
  await window.webContents.insertText(draft);
  await until('composerLayout().stacked && composerLayout().fullWidth', 'rich references also occupy the top row');
  await run(`updateChat({draft:${JSON.stringify(draft.repeat(15))}})`);
  await until('document.querySelector("textarea[data-composer-input]")?.scrollHeight > 220', 'long prompt scrolls inside the editor');
  assert.ok(await run('composerLayout().inputHeight <= 220 && composerLayout().contained'), 'long prompts remain bounded with the toolbar visible');
  await run('updateChat({draft:""})');
  await until('!composerLayout().stacked', 'compact after clearing a long prompt');
  console.log('Composer multiline passed: full-width text above toolbar, soft-wrap stability, rich references, native newline, narrow panes, font scaling, caret retention, bounded height and both themes.');
};
