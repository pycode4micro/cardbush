const assert = require('node:assert/strict');
const fs = require('node:fs');

module.exports = async function testConversationTitleRendering({ run, until, pause, window }) {
  await run(`
    window.titleNoop = () => {};
    window.titleRenames = [];
    window.titleFixtures = [
      { id: 'legacy', title: '[$video-face-stylizer](<C...', expected: 'video-face-stylizer' },
      { id: 'complete', title: '[$face-tools](<C:/plugins/face-tools/plugin.json>) 检查连接', expected: 'face-tools 检查连接' },
      { id: 'long', title: '[$a-very-long-plugin-name-for-testing-layout](<C:/plugins/long/plugin.json>) 验证渲染与省略', expected: 'a-very-long-plugin-name-for-testing-layout 验证渲染与省略' },
      { id: 'plain', title: '普通标题 [待办]', expected: '普通标题 [待办]' },
    ];
    window.titleConversations = titleFixtures.map(item => ({ ...item, preview: '', updatedAt: '2026-09-12T00:00:00Z' }));
    window.showTitleFixture = index => renderView(h('div', { className: 'desktop-shell' },
      h(views.ChatSidebar, {
        language: 'zh', section: 'chat', activeConversationId: titleFixtures[index].id,
        projects: [], conversations: titleConversations, changeReportsByConversation: {}, onlyTalkMode: true,
        onOnlyTalkModeChange: titleNoop, onSectionChange: titleNoop, onConversationChange: titleNoop,
        onCreateConversation: titleNoop, onAddProject: titleNoop, onProjectAction: titleNoop,
        onDeleteConversation: titleNoop, onRenameConversation: async (id, title) => { titleRenames.push({ id, title }); return true; },
        onOpenConversationChanges: titleNoop, onOpenSettings: titleNoop,
      }),
      h('main', { className: 'main-stage' }, h('div', { className: 'chat-panel' },
        h(views.TopBar, { title: titleFixtures[index].title, language: 'zh', inspectorOpen: false, onToggleInspector: titleNoop }))),
    ));
    showTitleFixture(0);
    undefined;
  `);
  for (const theme of ['theme-bright', 'theme-dark']) {
    for (const width of [760, 1180]) {
      window.setSize(width, 760);
      for (let index = 0; index < 4; index++) {
        await run(`window.viewTheme = '${theme}'; showTitleFixture(${index}); undefined;`);
        await until(`document.querySelector('.topbar h1')?.textContent === titleFixtures[${index}].expected`, 'clean header title');
        await run(`document.querySelector('.app').style.width = '${width}px'; undefined;`);
        await pause(30);
        const state = await run(`(() => {
          const title = document.querySelector('.conversation-row.active .conversation-title');
          const header = document.querySelector('.topbar h1');
          const action = document.querySelector('.topbar button');
          return { sidebar: title.textContent, label: title.getAttribute('aria-label'), tooltip: title.title,
            header: header.textContent, headerTooltip: header.title,
            overlaps: header.getBoundingClientRect().right > action.getBoundingClientRect().left,
            visible: header.getBoundingClientRect().top >= 0 && header.getBoundingClientRect().bottom < innerHeight && header.clientWidth > 0,
            links: title.querySelectorAll('a').length + header.querySelectorAll('a').length };
        })()`);
        const expected = await run(`titleFixtures[${index}].expected`);
        assert.equal(state.sidebar, expected);
        assert.equal(state.label, expected);
        assert.equal(state.tooltip, '', 'sidebar titles retain hover scrolling without a native tooltip');
        assert.equal(state.headerTooltip, expected);
        assert.equal(state.links, 0);
        assert.equal(state.overlaps, false, 'long titles must leave room for toolbar actions');
        assert.equal(state.visible, true, 'the header must remain inside the viewport');
      }
    }
  }
  await run('showTitleFixture(0)');
  await until("!!document.querySelector('.conversation-row.active .conversation-more')", 'legacy conversation');
  await run("document.querySelector('.conversation-row.active .conversation-more').click()");
  await until("!!document.querySelector('.sidebar-menu')", 'rename menu');
  await run("[...document.querySelectorAll('.sidebar-menu button')].find(button => button.textContent.includes('重命名')).click()");
  await until("!!document.querySelector('.conversation-row input')", 'rename editor');
  assert.equal(await run("document.querySelector('.conversation-row input').value"), 'video-face-stylizer');
  await run("document.querySelector('[aria-label=保存标题]').click()");
  await until("!document.querySelector('.conversation-row input')", 'unchanged rename closes');
  assert.deepEqual(await run('titleRenames'), [], 'opening and saving a cleaned title must not silently rewrite history');
  if (process.env.CARDBUSH_CONVERSATION_TITLE_SCREENSHOT) {
    await run("window.viewTheme = 'theme-bright'; showTitleFixture(0)");
    await pause();
    await run("document.querySelector('.app').style.width = '1180px'");
    fs.writeFileSync(process.env.CARDBUSH_CONVERSATION_TITLE_SCREENSHOT,
      (await window.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 330 })).toPNG());
  }
  await run(`renderView(h(views.FeatureContentPanel, {
    language: 'zh', section: 'search', workflowValidationAvailable: false, conversations: titleConversations,
    skills: [], disabledSkillNames: new Set(), onToggleSkill: titleNoop, onReloadSkills: async () => [],
    onLoadSkillDetail: titleNoop, onCreateConversation: titleNoop, onOpenConversation: titleNoop,
  })); undefined;`);
  await until("document.querySelectorAll('.result-card h3').length === 4", 'search title results');
  assert.deepEqual(await run("[...document.querySelectorAll('.result-card h3')].map(node => node.textContent)"),
    await run('titleFixtures.map(item => item.expected)'));
  console.log('Conversation titles passed: legacy references, both themes, narrow/wide layouts, tooltips, rename and search.');
};
