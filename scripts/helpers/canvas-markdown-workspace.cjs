const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

module.exports = async ({ run, until, clickText, selected, win, teams }) => {
  const fill = async source => {
    await run(`(()=>{const input=document.querySelector('.canvas-document-editor .md-source');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(source)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  };
  const page = () => run('canvasPages.getBushItPages().pages.find(p=>p.id===canvasPages.getBushItPages().selectedId)');
  const saved = async source => { await until(`canvasPages.getBushItPages().pages.some(p=>p.source===${JSON.stringify(source)}&&p.file?.text===p.source)`); };
  await clickText('新建文档'); await until('!!document.querySelector(".canvas-document-editor .bush-page-content")');
  await clickText('Markdown'); await until('!!document.querySelector(".canvas-document-editor .md-source")');
  const source = '# 计划文档\n\n' + Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行内容`).join('\n');
  await fill(source); await saved(source);
  const first = await page(), firstItem = (await selected()).editingId;
  assert.equal(await readFile(first.file.path, 'utf8'), source, 'editor autosaves through the existing versioned file service');
  assert.equal(await run('document.querySelector(".creation-line-numbers").textContent.split("\\n").length'), 52);
  await run('(()=>{const input=document.querySelector(".md-source");input.focus();input.setSelectionRange(8,13);input.dispatchEvent(new Event("select"));})()');
  await run('canvasSend("修改选中的几行")');
  const prompt = await run('lastCanvasPrompt');
  assert.ok(prompt.context.some(item => item.content.includes(JSON.stringify(first.file.path)) && /L\d/.test(item.content)), `Agent requests retain the selected file and source lines: ${JSON.stringify(prompt.context)}`);
  await writeFile(resolve('tmp/creation-markdown-workspace.png'), (await win.webContents.capturePage()).toPNG());
  await clickText('新建文档'); await until(`canvasPages.getBushItPages().selectedId!==${JSON.stringify(first.id)} && !!document.querySelector('.canvas-document-editor .bush-page-content')`);
  await run(`document.querySelector('[data-canvas-document-id="${firstItem}"]').click()`);
  await until(`canvasPages.getBushItPages().selectedId===${JSON.stringify(first.id)}`);
  await clickText('Markdown'); await until('document.querySelector(".md-source")?.value.includes("第 50 行内容")');
  await fill('# 本地草稿\n\n不要覆盖我的修改');
  await writeFile(first.file.path, '# Agent 新版本\n\n外部修改');
  await run(`refreshCreationFile(${JSON.stringify(first.id)})`); await until('!!document.querySelector(".creation-conflict")');
  assert.equal(await run('document.querySelector(".md-source").value'), '# 本地草稿\n\n不要覆盖我的修改');
  await clickText('保留草稿并载入新版本'); await until('!document.querySelector(".creation-conflict")');
  const manifest = await run(`testBridge.creationCanvas({action:'read',path:${JSON.stringify((await selected()).path)}})`);
  assert.ok(manifest.document.items.some(item => item.kind === 'markdown' && item.markdown.includes('不要覆盖我的修改')), 'conflicted draft remains accessible as a separate canvas document');
  assert.equal(await readFile(first.file.path, 'utf8'), '# Agent 新版本\n\n外部修改');
  await run('document.querySelector(".canvas-document-tabs>button").click()');
  await until('!document.querySelector(".canvas-document-workspace")');
  await run(`document.querySelector('[data-canvas-item="${firstItem}"] [aria-label="编辑 Markdown"]').click()`);
  await until('document.querySelector(".canvas-document-editor").textContent.includes("Agent 新版本")');

  const definition = { id: 'review-roundtrip', name: '回写流程', description: '在创作中编辑后保存回原流程', max_parallel: 1,
    nodes: [{ id: 'review', name: '复核', agent_id: 'reviewer', prompt: '原始要求', depends_on: [] }] };
  teams.push({ revision: 1, updatedAt: new Date().toISOString(), definition });
  await run(`canvasOpenDocument(canvasTeamMarkdown(${JSON.stringify(definition)}),{id:'review-roundtrip',revision:1})`);
  await until('document.querySelector(".canvas-document-editor")?.textContent.includes("原始要求")');
  await clickText('Markdown'); await until('!!document.querySelector(".canvas-document-editor .md-source")');
  const teamSource = await run('document.querySelector(".md-source").value');
  await fill(teamSource.replace('原始要求', '修改后的要求'));
  await clickText('保存到流程'); await until('document.querySelector(".bush-page-header-actions")?.textContent.includes("已保存到流程")');
  assert.equal(teams[0].revision, 2); assert.equal(teams[0].definition.nodes[0].prompt, '修改后的要求');
  await run('window.openedCanvasApp="";window.addEventListener("cardbush-open-application",event=>{window.openedCanvasApp=event.detail.id})');
  await clickText('查看流程'); assert.equal(await run('openedCanvasApp'), 'builtin:team');
  await saved(teamSource.replace('原始要求', '修改后的要求'));
  teams[0].revision = 3; teams[0].definition.nodes[0].prompt = '别处更新';
  await fill(teamSource.replace('原始要求', '再次修改'));
  await clickText('保存到流程'); await until('document.querySelector(".canvas-document-editor [role=alert]")?.textContent.includes("Definition changed")');
  assert.equal(teams[0].revision, 3); assert.equal(teams[0].definition.nodes[0].prompt, '别处更新');
  assert.ok(await run('document.querySelector(".md-source").value.includes("再次修改")'), 'Team version conflicts preserve the editable draft');
  console.log('Canvas Markdown passed: real files, source lines, autosave, multi-document selection, retained conflict drafts, Team save and concurrent revision protection.');
};
