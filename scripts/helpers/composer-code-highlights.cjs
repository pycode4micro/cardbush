const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const sample = '关键词 `user_id` 和 ``含 `反引号` 的词``，\\`不高亮\\`。';
  const marks = 'Array.from(document.querySelectorAll(".composer-code-mark"),n=>n.textContent)';
  await run(`inputType(${JSON.stringify(sample)});window.originalCodeInput=document.querySelector('textarea[data-composer-input]');void 0;`);
  await until('document.querySelectorAll(".composer-code-mark").length===2', 'editable inline keywords');
  assert.deepEqual(await run(marks), ['user_id', '含 `反引号` 的词']);
  assert.equal(await run('document.querySelector("textarea[data-composer-input]").value'), sample);
  assert.equal(await run('document.querySelector(".composer-code-highlights").getAttribute("aria-hidden")'), 'true');
  assert.equal(await run('getComputedStyle(document.querySelector(".composer-code-highlights")).pointerEvents'), 'none');
  assert.equal(await run('getComputedStyle(document.querySelector(".composer-code-highlights")).userSelect'), 'none');
  assert.equal(await run('document.querySelector("textarea[data-composer-input]").selectionStart'), sample.length);
  // Closing a delimiter changes only paint: the native input and undo stack survive.
  await run('inputType("draft `user_i")');
  await window.webContents.insertText('d`');
  await until('document.querySelector(".composer-code-mark")?.textContent==="user_id"', 'native typing closes span');
  assert.equal(await run('document.querySelector("textarea[data-composer-input]")===originalCodeInput'), true);
  window.webContents.undo();
  await until('chatProps.draft==="draft `user_i"&&!document.querySelector(".composer-code-mark")', 'native undo retains raw text');
  window.webContents.redo();
  await until('chatProps.draft==="draft `user_id`"&&!!document.querySelector(".composer-code-mark")', 'native redo restores paint');
  await run(`inputType('\`<img src=x onerror=alert(1)>\`');`);
  await until('document.querySelector(".composer-code-mark")?.textContent.includes("<img")', 'HTML is literal input');
  assert.equal(await run('document.querySelectorAll(".composer-code-highlights img").length'), 0);
  const bounds = window.getBounds();
  const sizing = await window.webContents.insertCSS('.app{width:100%!important}');
  for (const theme of ['theme-bright', 'theme-dark']) {
    await run(`viewTheme=${JSON.stringify(theme)};updateChat({draft:${JSON.stringify(sample)}})`);
    window.setSize(420, 650); await until('innerWidth===420', 'narrow keyword input'); await pause(120);
    assert.ok(await run(`(()=>{const i=document.querySelector('textarea[data-composer-input]'),a=i.getBoundingClientRect(),b=document.querySelector('.composer-code-highlights').getBoundingClientRect();return Math.abs(a.left+i.clientLeft-b.left)<1&&Math.abs(a.top+i.clientTop-b.top)<1&&Math.abs(b.width-i.clientWidth)<1&&Math.abs(b.height-i.clientHeight)<1;})()`), 'paint layer follows the actual input geometry');
    assert.notEqual(await run('getComputedStyle(document.querySelector(".composer-code-mark")).backgroundColor'), 'rgba(0, 0, 0, 0)');
    await fs.writeFile(path.join(root, `tmp/composer-keywords-${theme}.png`), (await window.capturePage()).toPNG());
  }
  await run(`inputType(${JSON.stringify(Array.from({ length: 36 }, (_, i) => 'line ' + i + ' `keyword_' + i + '`').join('\n'))})`);
  await until('document.querySelectorAll(".composer-code-mark").length===36', 'long editable draft');
  await run(`(()=>{const n=document.querySelector('textarea[data-composer-input]');n.scrollTop=n.scrollHeight;})()`);
  await until(`(()=>{const i=document.querySelector('textarea[data-composer-input]');return i.scrollTop>0&&document.querySelector('.composer-code-mirror').style.transform.includes('-'+i.scrollTop+'px');})()`, 'native scrolling moves the paint layer');
  assert.ok(await run(`(()=>{const i=document.querySelector('textarea[data-composer-input]'),m=document.querySelector('.composer-code-mirror');return Math.abs(i.scrollHeight-m.scrollHeight)<2;})()`), 'long drafts retain native line wrapping');
  await run(`inputType(inputSkillLink+' \`keyword\`')`);
  await until('document.querySelector(".composer-prompt-editor")&&CSS.highlights.get("cardbush-composer-code")?.size===1', 'reference editor uses native highlights');
  assert.deepEqual(await run('Array.from(CSS.highlights.get("cardbush-composer-code"),r=>r.toString())'), ['keyword']);
  await run(`(()=>{inputSelectAll();const data=new DataTransfer();document.activeElement.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));window.codeCopied=data.getData('text/plain');})()`);
  assert.equal(await run('codeCopied'), await run('inputSkillLink+" `keyword`"'), 'copy keeps reference and Markdown source');
  await run('updateChat({draft:""});');
  await until('!!document.querySelector("textarea[data-composer-input]")&&!CSS.highlights.has("cardbush-composer-code")', 'no stale highlights after switching editor');
  window.setBounds(bounds); await window.webContents.removeInsertedCSS(sizing);
  console.log('Composer code highlights passed: raw source, native input/undo, escaped/double ticks, safe HTML, native reference/copy, themes, narrow wrapping and scrolling.');
};
