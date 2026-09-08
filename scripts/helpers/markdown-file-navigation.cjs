const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  const filePath = 'C:\\Users\\fixture\\task-workspace\\拍摄脚本-3.mp4.md';
  const content = `[📄 拍摄脚本-3.mp4.md](${filePath})\n\n[空链接]() [不支持的链接](javascript:alert%281%29)`;
  const pageUrl = window.webContents.getURL();
  await run(`
    window.openedFiles = [];
    window.recordFileOpen = event => openedFiles.push(event.detail.target);
    addEventListener('cardbush:open-inspector', recordFileOpen);
    renderView(h('div', null,
      h('textarea', { id: 'preserved-draft', defaultValue: '尚未发送的草稿' }),
      h(views.MessageFileReferenceScope, { workspaceRoot: 'D:/fixture' },
        h(views.MarkdownContent, { content: ${JSON.stringify(content)}, language: 'zh' }))));
  `);
  await until("document.querySelector('.local-file-reference')?.textContent.includes('拍摄脚本-3.mp4.md')", 'Windows file link metadata');
  assert.equal(await run(`document.querySelectorAll('a[href=""]').length`), 0, 'no empty href can navigate back to the app');
  await run("window.savedDraft = document.getElementById('preserved-draft'); document.querySelector('.local-file-reference').click()");
  assert.deepEqual(await run('openedFiles'), [filePath], 'the exact Windows destination is routed to the inspector');
  assert.equal(window.webContents.getURL(), pageUrl, 'clicking a file never navigates the main frame');
  assert.equal(await run("savedDraft === document.getElementById('preserved-draft') && savedDraft.value === '尚未发送的草稿'"), true, 'file navigation preserves the mounted draft');
  const dialogsBefore = await run('errorDialogs.length');
  await run("document.querySelector('.markdown-link-error').click()");
  await until(`errorDialogs.length === ${dialogsBefore + 1}`, 'invalid link error dialog');
  assert.equal(await run('errorDialogs.at(-1).title'), '无法打开链接');
  assert.equal(await run('openedFiles.length'), 1, 'invalid links never reach file/browser navigation');
  assert.equal(window.webContents.getURL(), pageUrl);
  await run("removeEventListener('cardbush:open-inspector', recordFileOpen)");

  await run(`preview(${JSON.stringify(filePath)})`);
  await until(`reads.some(read => read.path === ${JSON.stringify(filePath)})`, 'double-extension Markdown file read');
  await run(`resolveReads(${JSON.stringify(filePath)}, ${JSON.stringify('# 拍摄脚本\n\n| 镜号 | 内容 |\n| --- | --- |\n| 01 | 场景描述 |')})`);
  await until("document.querySelector('.markdown-inspector-preview h1')?.textContent === '拍摄脚本'", 'file opens as Markdown rather than video');
  assert.equal(await run("!!document.querySelector('.markdown-inspector-preview table')"), true);

  await run(`
    window.previewShouldFail = false;
    window.previewGeneration = 0;
    window.previewFailures = 0;
    window.FailingPreview = () => {
      if (previewShouldFail) throw new Error('fixture preview rendering failed');
      return h('p', { id: 'healthy-preview' }, '预览已恢复');
    };
    window.showBoundaryFixture = () => renderView(h('div', null,
      h('textarea', { id: 'boundary-draft', defaultValue: '保留当前会话草稿' }),
      h(views.InspectorErrorBoundary, {
        key: previewGeneration, target: 'D:/fixture/broken.md', language: 'zh',
        onError: () => { previewFailures++; },
        onRetry: () => { previewShouldFail = false; previewGeneration++; showBoundaryFixture(); },
      }, h(FailingPreview))));
    showBoundaryFixture();
  `);
  await until("!!document.getElementById('healthy-preview')", 'preview initially healthy');
  const beforeFailure = await run('errorDialogs.length');
  await run("window.retainedDraft = document.getElementById('boundary-draft'); previewShouldFail = true; showBoundaryFixture()");
  await until("document.querySelector('.inspector-preview-error')?.textContent.includes('fixture preview rendering failed')", 'preview error stays inside its boundary');
  await until(`errorDialogs.length === ${beforeFailure + 1}`, 'preview render error dialog');
  assert.equal(await run("retainedDraft === document.getElementById('boundary-draft') && retainedDraft.value === '保留当前会话草稿'"), true, 'a preview render error preserves sibling UI state');
  assert.equal(window.webContents.getURL(), pageUrl, 'preview exceptions never reload the main frame');
  await run("document.querySelector('.inspector-preview-error button').click()");
  await until("!!document.getElementById('healthy-preview')", 'retry remounts only the failed preview');
  assert.equal(await run("retainedDraft === document.getElementById('boundary-draft')"), true);
  await run('renderView(null)');
  await pause();
  console.log('File navigation passed: Windows Markdown path, empty href prevention, error dialogs, retained draft and isolated preview retry.');
};
