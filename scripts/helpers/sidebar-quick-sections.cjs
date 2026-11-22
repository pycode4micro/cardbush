const assert = require('node:assert/strict');

module.exports = async function testSidebarQuickSections({ run, until, window }) {
  const toggle = '.recent-inline-toggle';
  const list = '.recent-inline-sessions';
  const pinned = list + ' [data-recent-group=pinned]';
  const projects = list + ' [data-recent-group=projects]';
  const recent = list + ' [data-workspace-drop=recent]';
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => run(query(selector) + '.click(); void 0');
  const titles = selector => run('Array.from(document.querySelectorAll(' + JSON.stringify(selector) + '), row => row.textContent)');

  window.setContentSize(480, 500);
  await run(`
    localStorage.setItem('cardbush_pinned_conversation_ids', JSON.stringify(['pinned-chat']));
    window.quickOpened = [];
    window.showQuickSectionsFixture = (expanded, language = 'zh') => {
      const conversations = [
        {id:'pinned-chat', title:'Pinned chat', projectId:'pinned-project', projectDir:'C:/fixture/pinned'},
        {id:'project-chat', title:'Project conversation', projectId:'project', projectDir:'C:/fixture/project'},
        ...Array.from({length:8}, (_, i) => ({id:'recent-' + i, title:'Recent conversation ' + i})),
      ].map((chat, index) => ({...chat, preview:'', updatedAt:new Date(Date.UTC(2026, 0, 20 - index)).toISOString()}));
      const projects = [
        {id:'pinned-project', title:'Pinned project', rootPath:'C:/fixture/pinned', pinned:true},
        {id:'project', title:'Project with a long title that fits within the sidebar', rootPath:'C:/fixture/project'},
        {id:'archived', title:'Archived project', rootPath:'C:/fixture/archived', archived:true},
      ];
      const noop = () => {};
      const open = id => quickOpened.push(id);
      renderView(h('div', {
        className:'desktop-shell' + (expanded ? '' : ' sidebar-is-collapsed'),
        'data-sidebar-layout':'drawer',
      }, h(views.ChatSidebar, {
        showQuickSections:expanded, language, section:'home', activeConversationId:'',
        projects, conversations, changeReportsByConversation:{},
        quickNavigation:inline => h(views.RecentConversationBar, {
          inline, language, assistantName:'Assistant', conversations, selectedId:'',
          notices:[], openNotice:noop, onRecentList:noop, open,
        }),
        onSectionChange:noop, onConversationChange:open, onAddProject:noop, onProjectAction:noop,
        onRenameProject:async () => null, onDeleteConversation:noop, onRenameConversation:async () => true,
        onOpenConversationChanges:noop, onOpenSettings:noop, onOpenSearch:noop,
        onOpenProject:noop, onOpenTabWorkspace:noop,
      })));
    };
    showQuickSectionsFixture(true);
  `);
  await until(query(toggle) + "?.getAttribute('aria-expanded') === 'true'", 'Quick sections are expanded by default');
  assert.ok(await run(query('button.recent-inline-toggle[aria-label="快速"]:not([title],[interestfor],[aria-haspopup]) .recent-inline-chevron') + ' !== null'));
  assert.equal(await run('document.querySelectorAll(".recent-bar-list").length'), 1);
  assert.equal(await run('document.getElementById(' + query(toggle) + ".getAttribute('aria-controls')) === " + query(list)), true);
  assert.deepEqual(await titles(pinned + ' h3, ' + projects + ' h3, ' + recent + ' h3'), ['置顶', '项目', '最近会话']);
  assert.deepEqual(await titles(pinned + ' .project-title, ' + pinned + ' .conversation-title-text'), ['Pinned project', 'Pinned chat']);
  assert.deepEqual(await titles(projects + ' .project-title'), ['Project with a long title that fits within the sidebar']);
  assert.equal((await titles(recent + ' .conversation-title-text')).length, 6);

  await click(projects + ' .project-row');
  await until(query(projects + ' .conversation-row') + '?.checkVisibility()', 'project conversations are reachable inline');
  assert.equal((await titles(list + ' .conversation-title-text')).filter(title => title === 'Project conversation').length, 1);
  await click(projects + ' .conversation-row');
  await click(pinned + ' .conversation-row');
  assert.deepEqual(await run('quickOpened'), ['project-chat', 'pinned-chat']);
  await click(recent + ' .recent-turn-more');
  await until('document.querySelectorAll(' + JSON.stringify(recent + ' .conversation-row') + ').length === 8', 'more recent conversations can be shown');
  assert.ok(await run(`(() => {
    const nav = document.querySelector('.sidebar-nav'), footer = document.querySelector('.sidebar-footer');
    return nav.scrollHeight > nav.clientHeight && nav.scrollWidth <= nav.clientWidth &&
      footer.getBoundingClientRect().bottom <= document.querySelector('.sidebar').getBoundingClientRect().bottom + 1;
  })()`), 'a short, narrow sidebar scrolls and keeps its footer accessible');

  await click(toggle);
  await until(query(list) + '?.hidden', 'Quick sections are collapsible');
  await run("window.originalQuickButton = document.querySelector('.recent-bar-list'); originalQuickButton.focus(); showQuickSectionsFixture(false, 'en'); void 0");
  await until('!' + query(toggle) + ' && !!' + query('.sidebar-is-collapsed .recent-bar-list'), 'the compact rail keeps Quick access');
  assert.ok(await run("document.activeElement === originalQuickButton"), 'Quick access keeps keyboard focus across layouts');
  await run("showQuickSectionsFixture(true, 'en'); void 0");
  await until(query(toggle) + "?.getAttribute('aria-label') === 'Quick access'", 'the disclosure updates with the language');
  assert.equal(await run(query(toggle) + ".getAttribute('aria-expanded')"), 'false', 'collapsing the rail preserves the disclosure choice');
  await click(toggle);
  await until(query(pinned + ' .conversation-row') + '?.checkVisibility()', 'pinned conversations return after reopening');
  assert.deepEqual(await titles(pinned + ' h3, ' + projects + ' h3'), ['Pinned', 'Projects']);
  await run(query(toggle + ' .recent-inline-chevron') + '.dispatchEvent(new MouseEvent("click", {bubbles:true})); void 0');
  await until(query(list) + '?.hidden', 'the chevron is part of the same disclosure button');
  assert.deepEqual(await run('quickOpened'), ['project-chat', 'pinned-chat']);
  await run("showQuickSectionsFixture(false, 'en'); void 0");
  await until(query('.recent-bar-list[interestfor]') + ' !== null', 'compact Quick retains its native hover target');
  await click('.recent-bar-list');
  assert.deepEqual(await run('quickOpened'), ['project-chat', 'pinned-chat', 'pinned-chat']);
  console.log('Sidebar Quick sections passed: default expanded, pinned and project navigation, scrolling, collapse, compact rail, and language switching.');
};
