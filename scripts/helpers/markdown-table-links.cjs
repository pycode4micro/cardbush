const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const originalBounds = window.getBounds();
  window.setSize(1280, 800);
  await run(`
    window.originalFileTableChatProps = { ...chatProps };
    window.fileTablePaths = Array.from({ length: 10 }, (_, i) =>
      'D:/table-link-fixture/storage/jst_product_image_gallery/images/' + i + '/52206bcbb0553d27_d94ec7ad8313b9d' + i + '.jpg');
    window.fileTableContent = [
      '10 个原厂编码在本地图库中全部命中，图片文件都存在于本机，状态为 ready。', '',
      '| 排名 | 原厂编码 | 颜色 | 本地图片路径 |', '| --- | --- | --- | --- |',
      ...fileTablePaths.map((path, i) => '| ' + (i + 1) + ' | KSU5202W012' + i + ' | 云白色 | ' + String.fromCharCode(96) + path + String.fromCharCode(96) + ' |'),
      '', '以上图片可点击查看。',
    ].join('\\n');
    window.fileTableInspections = [];
    window.originalFileTableInspect = cardbushDesktop.inspectLocalReference;
    window.fileTableDebugBatches = [];
    window.originalFileTableDebug = { config: cardbushDesktop.windowScrollDiagnosticConfig, write: cardbushDesktop.writeDebugLog };
    cardbushDesktop.windowScrollDiagnosticConfig = async () => ({ runId: 'table-link-test', expiresAt: Date.now() + 60000 });
    cardbushDesktop.writeDebugLog = async (scope, batch) => { fileTableDebugBatches.push({ scope, batch }); };
    cardbushDesktop.inspectLocalReference = path => new Promise(resolve => {
      fileTableInspections.push({ path, resolve });
    });
    window.fileTableMessage = { id: 'file-table-answer', conversationId: 'file-table-session', turnId: 'file-table-turn',
      role: 'assistant', status: 'completed', content: fileTableContent,
      createdAt: '2026-10-10T02:09:21Z', metadata: { transcript_kind: 'assistant_final' } };
    window.showFileTable = patch => {
      Object.assign(chatProps, { loading: false, historyLoading: false, sending: false,
        activeConversationId: 'file-table-session', conversation: { id: 'file-table-session', title: '表格链接' },
        language: 'zh', messages: [fileTableMessage], ...patch });
      renderView(h('section', { className: 'main-stage', style: { width: '900px', flex: '1 1 auto' } }, h(views.ChatPanel, chatProps)));
    };
    window.fileTableTrace = [];
    window.fileTableNodes = new WeakMap();
    window.fileTableNextId = 1;
    window.fileTableNodeId = node => {
      if (!node) return null;
      if (!fileTableNodes.has(node)) fileTableNodes.set(node, fileTableNextId++);
      return fileTableNodes.get(node);
    };
    window.recordFileTable = label => {
      const wrapper = document.querySelector('.markdown-table-scroll');
      const scroller = document.querySelector('.message-list');
      if (!wrapper || !scroller) return;
      fileTableTrace.push({ label, at: Math.round(performance.now()), tableId: fileTableNodeId(wrapper),
        table: wrapper.getBoundingClientRect().toJSON(), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight,
        rows: [...wrapper.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height),
        links: [...wrapper.querySelectorAll('.local-file-reference, .local-file-reference-pending, .local-file-reference-unavailable')].map(link =>
          ({ id: fileTableNodeId(link), label: link.textContent, className: link.className })),
      });
    };
    showFileTable();
  `);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 10 && fileTableInspections.length === 10", 'ten pending table file references');
  await pause(160);
  const pendingWidths = [];
  for (const width of [360, 520, 900]) {
    await run(`document.querySelector('.app').style.width = '${width}px'; document.querySelector('.main-stage').style.width = '${width}px';`);
    await pause(80);
    pendingWidths.push(await run(`(() => {
      const wrapper = document.querySelector('.markdown-table-scroll');
      return { width: ${width}, height: wrapper.getBoundingClientRect().height, overflow: document.querySelector('.message-list').scrollWidth - document.querySelector('.message-list').clientWidth };
    })()`));
  }
  await run(`
    recordFileTable('pending');
    window.fileTableObserver = new ResizeObserver(() => recordFileTable('resize'));
    fileTableObserver.observe(document.querySelector('.markdown-table-scroll'));
  `);
  for (let i = 0; i < 10; i++) {
    await run(`fileTableInspections[${i}].resolve({ path: fileTablePaths[${i}], name: fileTablePaths[${i}].split('/').pop(), kind: 'file' });`);
    await pause(45);
  }
  await until("document.querySelectorAll('.markdown-table-scroll .local-file-reference').length === 10", 'ten resolved table file references');
  await run("recordFileTable('resolved'); fileTableObserver.disconnect(); window.retainedFileTable = document.querySelector('.markdown-table-scroll'); void 0;");
  for (const pending of pendingWidths) {
    await run(`document.querySelector('.app').style.width = '${pending.width}px'; document.querySelector('.main-stage').style.width = '${pending.width}px';`);
    await pause(80);
    const resolved = await run(`(() => {
      const wrapper = document.querySelector('.markdown-table-scroll');
      return { height: wrapper.getBoundingClientRect().height, overflow: document.querySelector('.message-list').scrollWidth - document.querySelector('.message-list').clientWidth };
    })()`);
    assert.equal(resolved.height, pending.height, pending.width + 'px: file resolution keeps table geometry in a narrow pane too');
    assert.ok(pending.overflow <= 1 && resolved.overflow <= 1, pending.width + 'px: file labels never overflow the chat pane');
  }
  for (let i = 0; i < 8; i++) {
    await run("fileTableMessage = { ...fileTableMessage, content: fileTableMessage.content + ' 补充。' }; showFileTable();");
    await pause(35);
    assert.equal(await run("document.querySelector('.markdown-table-scroll') === retainedFileTable"), true, 'table DOM survives text updates');
  }
  await pause(260);
  await run("recordFileTable('settled'); fileTableObserver.disconnect();");
  const first = await run('fileTableTrace');
  const summary = { pendingHeight: first.find(entry => entry.label === 'pending').table.height,
    resolvedHeight: first.find(entry => entry.label === 'resolved').table.height,
    resizeHeights: first.filter(entry => entry.label === 'resize').map(entry => entry.table.height),
    tableIds: [...new Set(first.map(entry => entry.tableId))], inspections: await run('fileTableInspections.length') };
  assert.equal(summary.pendingHeight, summary.resolvedHeight, 'resolving a table file never replaces a long path with a shorter layout');
  assert.ok(summary.resizeHeights.every(height => height === summary.resolvedHeight), 'staggered file resolutions preserve table height');
  assert.equal(summary.inspections, 10, 'each complete path is inspected once');
  console.log('Table link trace: ' + JSON.stringify(summary));
  await run(`
    renderView(null);
  `);
  await pause(40);
  await run(`
    window.cachedFileTablePendingMounts = 0;
    window.cachedFileTableObserver = new MutationObserver(entries => {
      for (const entry of entries) for (const node of entry.addedNodes) {
        if (!(node instanceof Element)) continue;
        cachedFileTablePendingMounts += Number(node.matches('.local-file-reference-pending')) + node.querySelectorAll('.local-file-reference-pending').length;
      }
    });
    cachedFileTableObserver.observe(document.getElementById('root'), { childList: true, subtree: true });
    showFileTable();
  `);
  await until("document.querySelectorAll('.markdown-table-scroll a.local-file-reference').length === 10", 'cached file references on remount');
  await pause(40);
  assert.equal(await run('cachedFileTablePendingMounts'), 0, 'cached references never flash a pending placeholder on remount');
  assert.equal(await run('fileTableInspections.length'), 10, 'remount does not re-inspect cached references');
  await run('cachedFileTableObserver.disconnect()');
  await run(`
    window.fileTableStreamInspections = [];
    cardbushDesktop.inspectLocalReference = async path => {
      fileTableStreamInspections.push(path);
      await new Promise(resolve => setTimeout(resolve, 30));
      return path.endsWith('.jpg') ? { path, name: path.split('/').pop(), kind: 'file' } : null;
    };
    fileTableTrace = [];
    window.fileTableStreamContent = fileTableContent.replaceAll('table-link-fixture', 'table-link-streaming');
    fileTableMessage = { ...fileTableMessage, status: 'streaming', content: '' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });
  `);
  const length = await run('fileTableStreamContent.length');
  for (let i = 24; i < length + 24; i += 24) {
    await run(`fileTableMessage = { ...fileTableMessage, content: fileTableStreamContent.slice(0, ${i}) };
      showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });`);
    await pause(24);
    await run("recordFileTable('chunk')");
  }
  await pause(160);
  await run("recordFileTable('stream-resolved')");
  const stream = await run('fileTableTrace');
  const streamPaths = await run('fileTableStreamInspections');
  assert.equal(streamPaths.length, 10, 'streaming inspects only the ten complete paths, never path prefixes');
  assert.ok(streamPaths.every(path => path.endsWith('.jpg')), 'partial paths are never promoted to file links');
  assert.ok(stream.every((entry, index) => index === 0 || entry.table.height >= stream[index - 1].table.height), 'streamed table grows without repeatedly shrinking between path/link syntax');
  console.log('Streaming table trace: ' + JSON.stringify({ inspections: streamPaths.length,
    partialPaths: streamPaths.filter(path => !path.endsWith('.jpg')).slice(0, 4),
    tableIds: [...new Set(stream.map(entry => entry.tableId))], heights: stream.map(entry => entry.table.height) }));
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/markdown-table-link-trace.json'), JSON.stringify({ summary, trace: first, stream, streamPaths }, null, 2));
  await run(`
    fileTableMessage = { ...fileTableMessage, content: fileTableStreamContent.split('\\n').slice(0, -2).join('\\n') };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });
  `);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 9", 'unfinished tail is withheld while streaming');
  await run("fileTableMessage = { ...fileTableMessage, status: 'completed' }; showFileTable();");
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 10", 'completion commits the last row without a final newline');
  assert.equal(await run('fileTableStreamInspections.length'), 10, 'completion reuses the complete-path cache');
  await run(`
    window.finishedTableContent = fileTableMessage.content;
    fileTableMessage = { ...fileTableMessage, status: 'streaming', content: finishedTableContent + '\\n' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });
  `);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 10", 'newline commits the last row before completion');
  await run(`fileTableMessage = { ...fileTableMessage, content: finishedTableContent + '\\n   ' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });`);
  await pause(40);
  assert.equal(await run("document.querySelectorAll('.markdown-table-scroll tbody tr').length"), 10, 'trailing spaces never uncommit an already-rendered row');
  await run(`
    fileTableMessage = { ...fileTableMessage, content: '| 项目 | 文档 |\\n| --- | --- |\\n| 示例 | [访问](https://example.invalid/docs' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });
  `);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 0", 'unfinished web link row is buffered too');
  await run(`fileTableMessage = { ...fileTableMessage, content: fileTableMessage.content + ') |\\n' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });`);
  await until("document.querySelector('.markdown-table-scroll a')?.getAttribute('href') === 'https://example.invalid/docs'", 'complete web links retain their exact destinations');
  await run(`
    fileTableMessage = { ...fileTableMessage, status: 'streaming', content: '正文继续显示。\\n\\n' + String.fromCharCode(96).repeat(3) + 'md\\n| 示例 | 值 |\\n| --- | --- |\\n| 保留 | https://example.invalid/path' };
    showFileTable({ sending: true, activeTurnId: 'file-table-turn', activeAssistantMessageId: 'file-table-answer' });
  `);
  await until("document.querySelector('pre code')?.textContent.includes('| 保留 | https://example.invalid/path')", 'table-looking code remains literal while streaming');
  await run("renderView(null)");
  await pause(40);
  const logs = await run('fileTableDebugBatches');
  const records = logs.flatMap(({ batch }) => batch.records ?? []);
  assert.ok(records.some(record => record.label === 'markdown-table-render' && record.target?.messageId === 'file-table-answer'), 'diagnostics identify the message that rendered the table');
  assert.ok(records.some(record => record.label === 'geometry' && record.tables?.some(table => table.pendingFiles > 0)), 'diagnostics record pending table link counts and dimensions');
  assert.ok(records.some(record => record.label === 'file-reference-inspection' && record.stage === 'resolved'), 'diagnostics correlate path inspections with table layout');
  fs.writeFileSync(path.join(root, 'tmp/markdown-table-link-diagnostics.json'), JSON.stringify(logs, null, 2));
  await run(`
    cardbushDesktop.inspectLocalReference = originalFileTableInspect;
    cardbushDesktop.windowScrollDiagnosticConfig = originalFileTableDebug.config;
    cardbushDesktop.writeDebugLog = originalFileTableDebug.write;
    Object.assign(chatProps, originalFileTableChatProps);
    updateChat({});
  `);
  window.setBounds(originalBounds, false);
  console.log('Table file links passed: stable pending/resolved geometry, cached remounts, no partial-path inspections, streaming rows, completion, code literals and bounded diagnostics.');
};
