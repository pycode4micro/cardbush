const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const content = [
    '## 已复现（有实验证据）', '',
    '| # | 位置 | 问题 |', '| --- | --- | --- |',
    '| 1 | `src/capture/FrameEncoder.cs:83-96` | **MJPEG 每行只转换左侧 75%**：`quads = rowBytes >> 2` 让循环只处理了一部分像素，右侧内容没有写入。 |',
    '| 2 | `src/server/Ws.js` · `close()/_destroy()` | **断开的接收端不被清理**：`close()` 先置 `closed=true`，socket 关闭后仍然残留在队列中。 |',
    '| 3 | `src/server/Ws.js` · `pump()` | **拥塞时不是丢帧而是积压**：write 返回 `false` 后仍被下一次提交调用，不能只看表格左侧。 |',
    '| 4 | `FrameEncoder.cs:113` + `TcpSink.cs:107,182` | **复用编码缓冲 + 锁外异步 Send → 混合帧**：`EncodeFrame.Payload.BufferWithoutAnyBreakOpportunityAtAll` 在发送完成之前就被覆盖。 |',
    '| 5 | [MjpegTailHarnessWithAVeryLongFileName.cs](C:/fixture/MjpegTailHarnessWithAVeryLongFileName.cs) | The receive queue keeps the entire previous payload until the consumer finishes. [Details](https://example.invalid/' + 'long-path-segment'.repeat(8) + ') |',
    '', '表格后的正文继续使用原来的阅读宽度。',
  ].join('\n');
  window.setSize(1500, 960);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/appearance.css'), 'utf8'));
  await run(`
    window.tableMessage = { id: 'table-answer', conversationId: 'table-session', turnId: 'table-turn',
      role: 'assistant', status: 'completed', content: ${JSON.stringify(content)},
      createdAt: '2026-09-28T00:00:01Z', metadata: { transcript_kind: 'assistant_final' } };
    window.tableWidth = 1200;
    window.showTableFixture = (patch = {}) => {
      Object.assign(chatProps, { loading: false, historyLoading: false, activeConversationId: 'table-session',
        conversation: { id: 'table-session', title: '表格布局' }, language: 'zh', messages: [tableMessage] }, patch);
      renderView(h('section', { className: 'main-stage', style: { width: tableWidth + 'px', flex: '1 1 auto' } }, h(views.ChatPanel, chatProps)));
    };
    showTableFixture();
    window.tableGeometry = () => {
      const wrapper = document.querySelector('.markdown-table-scroll');
      const prose = wrapper.closest('.markdown-content');
      const item = wrapper.closest('.message-list-item');
      const scroller = document.querySelector('.message-list');
      return { table: wrapper.getBoundingClientRect().toJSON(), prose: prose.getBoundingClientRect().toJSON(),
        composer: document.querySelector('.composer-stack').getBoundingClientRect().toJSON(),
        available: item.getBoundingClientRect().toJSON(), overflow: wrapper.scrollWidth - wrapper.clientWidth,
        paneOverflow: scroller.scrollWidth - scroller.clientWidth,
        rows: [...wrapper.querySelectorAll('tbody tr')].map(row => row.getBoundingClientRect().height),
        cellsOverflow: [...wrapper.querySelectorAll('th,td')].map(cell => cell.scrollWidth - cell.clientWidth) };
    };
    undefined;
  `);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 5", 'screenshot table renders');
  for (const theme of ['theme-dark', 'theme-bright']) {
    await run(`viewTheme = ${JSON.stringify(theme)}; showTableFixture()`);
    for (const [width, inset] of [[1200, 0], [980, 0], [900, 0], [780, 0], [520, 0], [360, 0], [1200, 340]]) {
      await run(`tableWidth = ${width}; showTableFixture(); document.querySelector('.app').style.width = '${width}px';
        document.querySelector('.chat-content-frame').style.setProperty('--work-summary-content-inset', '${inset}px');`);
      await pause(280);
      const box = await run('tableGeometry()');
      const label = theme + ' / ' + width + 'px / inset ' + inset;
      assert.ok(await run("(() => { const wrapper = document.querySelector('.markdown-table-scroll'); return getComputedStyle(wrapper.querySelector('table')).color === getComputedStyle(wrapper).color; })()"), label + ': table text inherits the readable theme color');
      assert.ok(box.overflow <= 1 && box.paneOverflow <= 1, label + ': all table columns fit without horizontal scrolling: ' + JSON.stringify(box));
      assert.ok(box.cellsOverflow.every(overflow => overflow <= 1), label + ': cell contents stay visible');
      assert.ok(box.table.left >= box.available.left - 1 && box.table.right <= box.available.right + 1,
        label + ': table stays inside the reading pane, clear of sidebar/scrollbar');
      assert.ok(Math.abs(box.prose.width - Math.min(box.available.width, 704)) <= 1,
        label + ': prose uses the narrower reading width');
      assert.ok(Math.abs(box.composer.left - box.prose.left) <= 1 && Math.abs(box.composer.right - box.prose.right) <= 1,
        label + ': composer and prose stay aligned');
      assert.ok(Math.abs(box.table.width - Math.min(box.available.width, 908)) <= 1,
        label + ': table keeps its previous boundaries independently of prose width');
      assert.ok(box.rows.some(height => height > 48), label + ': longer explanations wrap across lines');
      if (box.available.width > box.prose.width + 20) {
        assert.ok(box.table.width > box.prose.width + 10, label + ': wide panes lend spare width to the table');
        assert.ok(Math.abs(box.table.left + box.table.width / 2 - box.prose.left - box.prose.width / 2) < 1,
          label + ': extension is balanced');
      }
      if (theme === 'theme-dark' && width === 1200 && !inset) {
        window.webContents.invalidate(); await pause(100);
        fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tmp', 'markdown-table-wrapped.png'), (await window.webContents.capturePage()).toPNG());
      }
    }
  }
  // Streaming uses the same table layout as the finished answer.
  await run(`tableWidth = 1200; document.querySelector('.app').style.width = '1200px';
    document.querySelector('.chat-content-frame').style.setProperty('--work-summary-content-inset', '0px');
    showTableFixture({ messages: [{ ...tableMessage, status: 'streaming', metadata: {} }], sending: true, activeTurnId: 'table-turn' });`);
  await until("!!document.querySelector('.assistant-active-transcript .markdown-table-scroll')", 'streaming table');
  await pause(280);
  const live = await run('tableGeometry()');
  assert.ok(live.overflow <= 1 && live.table.width > live.prose.width + 10, 'streaming table wraps and uses the same extension');
  // User/quoted tables and the inspector do not borrow the outer pane width.
  for (const role of ['user', 'assistant']) {
    const quoted = role === 'assistant' ? content.split('\n').map(line => '> ' + line).join('\n') : content;
    await run(`showTableFixture({ sending: false, activeTurnId: '', messages: [{ ...tableMessage, role: '${role}', content: ${JSON.stringify(quoted)} }] })`);
    await until(`!!document.querySelector('.${role === 'user' ? 'user-bubble' : 'markdown-content blockquote'} .markdown-table-scroll')`, 'bounded table');
    assert.equal(await run("getComputedStyle(document.querySelector('.markdown-table-scroll')).marginLeft"), '0px', 'nested/user table stays within its own surface');
  }
  await run(`renderView(h('aside', { className: 'subagent-inspector-section', style: { width: '340px' } },
    h(views.MarkdownContent, { content: ${JSON.stringify(content)}, language: 'en' })))`);
  await until("document.querySelectorAll('.markdown-table-scroll tbody tr').length === 5", 'inspector table');
  assert.ok(await run("(() => { const table = document.querySelector('.markdown-table-scroll'); return table.scrollWidth <= table.clientWidth + 1; })()"), 'inspector wraps the same content');
  await run('renderView(null)');
  console.log('Markdown table layout passed: wrapped Chinese/English, code and file links, balanced expansion, narrow/docked panes, streaming and bounded nested tables.');
};
