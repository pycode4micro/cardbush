const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/search/conversationSearch.css'), 'utf8'));
  await run(`
    const SearchReact = require(${JSON.stringify(require.resolve('react'))});
    window.searchEvents = [];
    window.searchConversations = [
      { id: 'one', title: '优化渲染性能', preview: '会话保持原位', updatedAt: '2026-09-15T12:00:00Z', projectId: 'cardbush', projectDir: 'D:/proj/cardbush' },
      { id: 'two', title: '更新投放脚本参数', preview: '只在摘要里出现的预算', updatedAt: '2026-09-15T11:00:00Z', projectId: 'ads' },
      { id: 'three', title: '[$video-face-stylizer](<C:/local/SKILL.md>)', preview: '视频处理', updatedAt: '2026-09-15T10:00:00Z' },
      ...Array.from({ length: 12 }, (_, index) => ({ id: 'recent-' + index, title: '近期对话 ' + (index + 1), preview: '长期任务', updatedAt: '2026-09-14T00:00:00Z' })),
    ];
    window.searchProjects = [{ id: 'cardbush', title: 'cardbush', rootPath: 'D:/proj/cardbush' },
      { id: 'ads', title: '广告报表', rootPath: 'D:/ads' }];
    function SearchFixture() {
      const controller = views.useConversationSearch();
      const [state, setState] = SearchReact.useState({ collapsed: false, language: 'zh', conversations: searchConversations });
      window.updateSearchFixture = update => setState(current => ({ ...current, ...update }));
      const noop = () => {};
      return h(SearchReact.Fragment, null,
        h('main', { className: 'desktop-shell', style: { paddingTop: 36 } },
          !state.collapsed && h(views.ChatSidebar, { language: state.language, section: 'chat', activeConversationId: 'one',
            projects: searchProjects, conversations: state.conversations, changeReportsByConversation: {},
            onSectionChange: noop, onConversationChange: noop, onCreateConversation: () => searchEvents.push('new'),
            onAddProject: noop, onProjectAction: noop, onDeleteConversation: noop, onRenameConversation: async () => true,
            onOpenConversationChanges: noop, onOpenSettings: () => searchEvents.push('settings'),
            onOpenSearch: controller.show }),
          h('section', { className: 'main-stage', style: { padding: 24, display: 'flex', flexDirection: 'column' } },
            h('h2', null, '优化渲染性能'),
            h('div', { id: 'search-fixture-transcript', style: { overflow: 'auto', height: 440 } },
              Array.from({ length: 30 }, (_, i) => h('p', { key: i }, '会话记录 ' + i + '：搜索时保留当前内容和滚动位置。'))),
            h('textarea', { id: 'search-fixture-draft', defaultValue: '尚未发送的草稿', style: { marginTop: 'auto', minHeight: 80 } }),
            h('button', { 'data-shortcut-recorder': 'fixture' }, '快捷键设置'))),
        controller.open && h(views.ConversationSearchDialog, { language: state.language, conversations: state.conversations,
          projects: searchProjects, runningConversationIds: new Set(['one']), onClose: controller.close,
          onOpenConversation: id => searchEvents.push(id), onCreateConversation: () => searchEvents.push('new'),
          onAddProject: () => searchEvents.push('project'), onOpenFiles: () => searchEvents.push('files') }));
    }
    views.saveKeyboardShortcuts({}); renderView(h(SearchFixture));
    window.setSearchQuery = value => {
      const input = document.querySelector('[data-conversation-search] input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    void 0;
  `);
  await until("!!document.querySelector('[data-shortcut=searchConversations]')", 'Recent search icon');
  await run("document.querySelector('.app').style.width = '100%'");
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(35);
  };
  const open = async () => {
    await run("document.querySelector('#search-fixture-draft').focus()");
    await key('F', ['control']);
    await until("!!document.querySelector('[data-conversation-search][open]')", 'native Ctrl F opens search');
  };
  const close = async () => {
    await key('Escape');
    await until("!document.querySelector('[data-conversation-search]')", 'Escape closes search');
  };
  const query = async value => { await run(`setSearchQuery(${JSON.stringify(value)})`); await pause(45); };
  const selected = () => run("document.querySelector('[data-conversation-search] [aria-selected=true]')?.dataset.searchConversation || document.querySelector('[data-conversation-search] [aria-selected=true]')?.dataset.searchAction");

  assert.deepEqual(await run("[...document.querySelectorAll('.sidebar-nav .nav-row')].map(node => node.textContent)"), ['新会话']);
  assert.equal(await run("document.querySelector('[data-shortcut=searchConversations]').textContent"), '');
  assert.equal(await run("document.querySelector('[data-shortcut=searchConversations]').getAttribute('aria-keyshortcuts')"), 'Control+F');
  assert.match(await run("document.querySelector('[data-shortcut=searchConversations]').closest('.section-header').textContent"), /最近/);
  assert.equal(await run("getComputedStyle(document.querySelector('[data-shortcut=searchConversations]')).opacity"), '1');
  await run(`window.searchDraftNode = document.querySelector('#search-fixture-draft');
    searchDraftNode.focus(); searchDraftNode.setSelectionRange(2, 5);
    window.searchTranscriptNode = document.querySelector('#search-fixture-transcript'); searchTranscriptNode.scrollTop = 210;`);
  await open();
  assert.equal(await run("document.activeElement.matches('[data-conversation-search] input')"), true);
  assert.equal(await run("document.querySelectorAll('[data-search-conversation]').length"), 9, 'bounded recent list');
  assert.equal(await run("document.querySelector('[data-search-conversation=three] .conversation-search-title').textContent"), 'video-face-stylizer');
  await key('Tab'); await key('Tab');
  assert.equal(await run("!!document.activeElement.closest('[data-conversation-search]')"), true, 'modal contains Tab focus');
  await close();
  assert.deepEqual(await run(`({ sameDraft: searchDraftNode === document.querySelector('#search-fixture-draft'),
    sameTranscript: searchTranscriptNode === document.querySelector('#search-fixture-transcript'),
    focus: document.activeElement === searchDraftNode, draft: searchDraftNode.value,
    selection: [searchDraftNode.selectionStart, searchDraftNode.selectionEnd], scroll: searchTranscriptNode.scrollTop })`),
  { sameDraft: true, sameTranscript: true, focus: true, draft: '尚未发送的草稿', selection: [2, 5], scroll: 210 });

  await run(`window.searchEditable = document.createElement('div'); searchEditable.contentEditable = 'true';
    searchEditable.textContent = '继续编辑原来的草稿'; document.querySelector('.main-stage').append(searchEditable);
    searchEditable.focus(); const selectedRange = document.createRange();
    selectedRange.setStart(searchEditable.firstChild, 2); selectedRange.setEnd(searchEditable.firstChild, 6);
    getSelection().removeAllRanges(); getSelection().addRange(selectedRange);`);
  await key('F', ['control']);
  await until("!!document.querySelector('[data-conversation-search][open]')", 'contenteditable composer opens search');
  await close();
  assert.equal(await run("document.activeElement === searchEditable && getSelection().toString() === '编辑原来'"), true, 'contenteditable draft selection is restored');
  await run('searchEditable.remove()');

  await run("document.querySelector('[data-shortcut=searchConversations]').click()");
  await until("!!document.querySelector('[data-conversation-search][open]')", 'icon opens search');
  await query('预算');
  assert.equal(await selected(), 'two', 'summary matching');
  await run(`document.querySelector('[data-conversation-search] input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))`);
  assert.deepEqual(await run('searchEvents'), [], 'IME confirmation must not navigate');
  await query('广告报表');
  assert.equal(await run("document.querySelectorAll('[data-search-conversation]').length"), 1, 'project name matching');
  await key('Return');
  await until("!document.querySelector('[data-conversation-search]')", 'Enter selects a result');
  assert.deepEqual(await run('searchEvents'), ['two']);

  await open();
  await key('Down');
  assert.equal(await selected(), 'two');
  await run("updateSearchFixture({ conversations: searchConversations.map(item => item.id === 'three' ? { ...item, updatedAt: '2026-09-15T13:00:00Z' } : item) })");
  await pause(50);
  assert.equal(await selected(), 'two', 'stream updates retain the selected conversation identity');
  await key('Return');
  assert.equal(await run('searchEvents.at(-1)'), 'two');
  await open(); await key('3', ['control']);
  assert.equal(await run('searchEvents.at(-1)'), 'two', 'number shortcuts follow the displayed order');
  await open(); await key('P', ['control']);
  assert.equal(await run('searchEvents.at(-1)'), 'files', 'file shortcut works inside the palette');
  await open(); await run("document.querySelector('[data-search-action=project]').click()");
  assert.equal(await run('searchEvents.at(-1)'), 'project');
  await open(); await query('不存在的会话');
  assert.equal(await run("document.querySelector('.conversation-search-empty').textContent"), '没有匹配的会话');
  await run("document.querySelector('[data-search-action=new]').click()");
  assert.equal(await run('searchEvents.at(-1)'), 'new');

  await open();
  const backdrop = await run("(() => { const r = document.querySelector('dialog').getBoundingClientRect(); return { x: Math.round(r.left)-12, y: Math.round(r.top)+20 }; })()");
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...backdrop });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...backdrop });
  await until("!document.querySelector('[data-conversation-search]')", 'backdrop dismisses');
  await run("document.querySelector('[data-shortcut-recorder]').focus()");
  await key('F', ['control']);
  assert.equal(await run("!!document.querySelector('[data-conversation-search]')"), false, 'do not steal shortcut recording');
  await run("window.otherSearchModal = document.createElement('dialog'); document.querySelector('.app').append(otherSearchModal); otherSearchModal.showModal()");
  await key('F', ['control']);
  assert.equal(await run("!!document.querySelector('[data-conversation-search]')"), false, 'do not layer over another modal');
  await run('otherSearchModal.close(); otherSearchModal.remove(); updateSearchFixture({ collapsed: true })');
  await pause(40); await open(); await close();
  assert.equal(await run("!!document.querySelector('.sidebar')"), false, 'shortcut works without a sidebar');

  await run("views.saveKeyboardShortcuts({searchConversations:{key:'k',ctrl:true}}); updateSearchFixture({ collapsed: false })");
  await until("document.querySelector('[data-shortcut=searchConversations]')?.getAttribute('aria-keyshortcuts')==='Control+K'", 'search button follows shortcut preferences');
  await run("document.querySelector('#search-fixture-draft').focus()"); await key('F', ['control']);
  assert.equal(await run("!!document.querySelector('[data-conversation-search]')"), false, 'old shortcut no longer opens search');
  await key('K', ['control']); await until("!!document.querySelector('[data-conversation-search][open]')", 'remapped shortcut');
  await close();
  await run("views.saveKeyboardShortcuts({}); updateSearchFixture({ conversations: searchConversations })");

  for (const theme of ['theme-bright', 'theme-dark']) {
    await run(`document.querySelector('.app').className = 'app ${theme}'`);
    await open(); await key('Down'); await key('Down');
    const bounds = await run(`(() => { const d = document.querySelector('dialog'), r = d.getBoundingClientRect(), s = getComputedStyle(d); return {
      width: r.width, contained: r.top >= 36 && r.bottom < innerHeight && r.left > 0 && r.right < innerWidth,
      color: s.color, background: s.backgroundColor, overflow: d.scrollWidth > d.clientWidth }; })()`);
    assert.equal(bounds.width, 520);
    assert.equal(bounds.contained, true);
    assert.equal(bounds.overflow, false);
    assert.notEqual(bounds.color, bounds.background);
    fs.writeFileSync(path.join(root, 'tmp/conversation-search-' + theme + '.png'), (await window.capturePage()).toPNG());
    await close();
  }
  await run("updateSearchFixture({ language: 'en', conversations: [] })"); await pause(30); await open();
  assert.equal(await run("document.querySelector('dialog').getAttribute('aria-label')"), 'Search chats');
  assert.equal(await selected(), 'new');
  await close();
  await run("updateSearchFixture({ language: 'zh', conversations: Array.from({length: 1000}, (_, i) => ({id: 'large-' + i, title: '批量测试 ' + i, preview: '', updatedAt: ''})) })");
  await pause(40); await open(); await query('批量');
  assert.equal(await run("document.querySelectorAll('[data-search-conversation]').length"), 50, 'bounded rendering for large history');
  for (const [width, height] of [[360, 540], [900, 320]]) {
    window.setSize(width, height); await pause(150);
    assert.equal(await run("(() => { const d = document.querySelector('dialog'), r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 36 && r.bottom <= innerHeight && d.scrollWidth <= d.clientWidth; })()"), true, 'palette fits small/short windows');
    await key('Up');
    assert.equal(await run("(() => { const o = document.querySelector('dialog [aria-selected=true]').getBoundingClientRect(), l = document.querySelector('.conversation-search-list').getBoundingClientRect(); return o.top >= l.top - 1 && o.bottom <= l.bottom + 1; })()"), true, 'selection scrolls only the results');
  }
  await close();
  assert.equal(await run('searchTranscriptNode.scrollTop'), 210);
  window.setSize(1200, 800);
  console.log('Conversation search passed: sidebar placement, Ctrl+F/remapping/collapsed sidebar, matching, keyboard and pointer selection, quick actions, IME/modal guards, focus/draft/scroll preservation, live updates, bounded results and responsive light/dark layouts.');
};
