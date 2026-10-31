const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testProjectHoverPreview({ run, until, pause, window, root }) {
  window.setSize(1100, 760);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/components/hover-preview.css'), 'utf8'));
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    await run('renderView(null)');
    await pause(50);
    await run(`
      localStorage.setItem('cardbush_pinned_conversation_ids', JSON.stringify(['project-chat-6']));
      localStorage.setItem('cardbush_archived_conversation_ids', JSON.stringify(['project-archived']));
      window.projectSelections = []; window.projectRenames = [];
      window.projectRenameFailure = null; window.projectRenameWait = null;
      window.projectProps = {
        language: 'zh', section: 'chat', activeConversationId: '',
        runningConversationIds: new Set(['project-chat-5']),
        attentionByConversation: { 'project-chat-4': { sessionId: 'project-chat-4', kind: 'interaction', updatedAt: '2026-10-30T00:00:00Z' } },
        projects: [{ id: 'hover-project', title: 'CardBush', rootPath: 'D:/fixture/cardbush' },
          { id: 'empty-project', title: 'Empty project', rootPath: 'D:/fixture/empty' }],
        conversations: [...Array.from({length: 7}, (_, i) => ({ id: 'project-chat-' + i,
          title: i === 6 ? 'A long recent conversation title that wraps across the project card without overflowing' : 'Conversation ' + i,
          preview: 'Summary only', updatedAt: new Date(Date.UTC(2026, 9, 25 + i)).toISOString(),
          projectId: 'hover-project', projectDir: 'D:/fixture/cardbush' })),
          { id: 'project-archived', title: 'Archived conversation', preview: '', updatedAt: '2026-11-01T00:00:00Z', projectId: 'hover-project' },
          { id: 'outside-project', title: 'Unrelated conversation', preview: '', updatedAt: '2026-11-02T00:00:00Z' }],
        changeReportsByConversation: {}, onSectionChange: () => {},
        onConversationChange: id => projectSelections.push(id), onCreateConversation: () => {},
        onAddProject: () => {}, onProjectAction: () => {}, onDeleteConversation: () => {},
        onRenameConversation: async () => true, onOpenConversationChanges: () => {},
        onOpenSettings: () => {}, onOpenSearch: () => {},
        onRenameProject: async (project, title) => {
          projectRenames.push({id: project.id, title});
          if (projectRenameWait) await projectRenameWait;
          if (projectRenameFailure) return projectRenameFailure;
          projectProps.projects = projectProps.projects.map(item => item.id === project.id ? {...item, title} : item);
          showProjectFixture(); return null;
        },
      };
      window.showProjectFixture = patch => { Object.assign(projectProps, patch); renderView(h(views.ChatSidebar, projectProps)); };
      window.projectRow = id => document.querySelector('[data-workspace-drop="' + id + '"] .project-row');
      window.projectInput = value => {
        const input = document.querySelector('.project-hover-name-form input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      };
      showProjectFixture();
    `);
    await until("!!projectRow('hover-project')", 'project fixture mounted');
    const hoverProject = async (id = 'hover-project') => {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 12 });
      await pause(160);
      const point = await run(`(() => { const r = projectRow('${id}').getBoundingClientRect(); return {x: Math.round(r.left + 50), y: Math.round(r.top + r.height / 2)}; })()`);
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      await until("!!document.querySelector('.project-hover-preview:popover-open')", 'project hover card');
    };
    const escape = async () => {
      await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
      await pause(80);
    };
    await hoverProject();
    assert.equal(await run("document.querySelector('.project-hover-count').textContent"), '7 次聊天', 'count includes pinned chats and excludes archives and other projects');
    assert.deepEqual(await run("[...document.querySelectorAll('.project-hover-conversation')].map(el => el.dataset.conversationId)"), ['project-chat-6', 'project-chat-5', 'project-chat-4'], 'only the three latest summaries appear, including the pinned chat');
    assert.match(await run("document.querySelector('[data-conversation-id=project-chat-5] .project-hover-conversation-meta').textContent"), /运行中/);
    assert.equal(await run("document.querySelector('.project-hover-preview').textContent.includes('D:/fixture')"), false, 'no unrelated paths or settings in the card');
    const cardPoint = await run("(() => { const r = document.querySelector('.project-hover-preview').getBoundingClientRect(); return {x: Math.round(r.left+40), y:Math.round(r.top+30)}; })()");
    window.webContents.sendInputEvent({ type: 'mouseMove', ...cardPoint });
    await pause(170);
    assert.equal(await run("!!document.querySelector('.project-hover-preview:popover-open')"), true, 'card remains reachable from its trigger');
    await run("document.querySelector('.project-hover-more').click()");
    await until("document.querySelectorAll('.project-hover-conversation').length === 6", 'more progressively reveals another three');
    await run("document.querySelector('.project-hover-more').click()");
    await until("document.querySelectorAll('.project-hover-conversation').length === 7 && !document.querySelector('.project-hover-more')", 'last page removes the more button');
    await run("document.querySelector('[data-conversation-id=project-chat-4]').click()");
    await until("!document.querySelector('.project-hover-preview')", 'opening a conversation dismisses the card');
    assert.deepEqual(await run('projectSelections'), ['project-chat-4']);
    await hoverProject();
    assert.equal(await run("document.querySelectorAll('.project-hover-conversation').length"), 3, 'reopening restores the compact initial list');
    await run("document.querySelector('.project-hover-name').click()");
    await until("document.activeElement === document.querySelector('.project-hover-name-form input')", 'inline edit focuses and selects the name');
    await run("projectInput('Cancelled name')");
    await escape();
    assert.equal(await run("document.querySelector('.project-hover-name strong').textContent"), 'CardBush', 'Escape cancels without renaming');
    assert.equal(await run('projectRenames.length'), 0);
    await run("document.querySelector('.project-hover-name').click()");
    await until("!!document.querySelector('.project-hover-name-form input')", 'edit for keyboard cancel');
    await run("projectInput('Another cancelled name')");
    await run("const cancel = document.querySelector('.project-hover-name-form button[type=button]'); cancel.focus(); cancel.click()");
    await until("document.activeElement === document.querySelector('.project-hover-name')", 'cancel action returns keyboard focus to the project name');
    assert.equal(await run('projectRenames.length'), 0, 'moving focus to Cancel must not save on blur');
    await run("document.querySelector('.project-hover-name').click()");
    await until("!!document.querySelector('.project-hover-name-form input')", 'reopen rename');
    await run("projectInput('  ')");
    await run("document.querySelector('.project-hover-name-form').requestSubmit()");
    await until("document.querySelector('.project-hover-error')?.textContent.includes('名称')", 'empty names stay in the editor');
    assert.equal(await run('projectRenames.length'), 0);
    await run("projectInput('Renamed project'); projectRenameFailure = 'Fixture save failure'");
    await run("document.querySelector('.project-hover-name-form').requestSubmit()");
    await until("document.querySelector('.project-hover-error')?.textContent === 'Fixture save failure'", 'failed save stays editable');
    await run("projectRenameFailure = null; projectRenameWait = new Promise(resolve => window.completeProjectRename = resolve); document.querySelector('.project-hover-name-form').requestSubmit()");
    await until("document.querySelector('.project-hover-name-form').getAttribute('aria-busy') === 'true'", 'save is pending');
    await run("document.querySelector('.project-hover-name-form').requestSubmit()");
    assert.equal(await run('projectRenames.length'), 2, 'pending save is deduplicated');
    await run('completeProjectRename(); projectRenameWait = null');
    await until("document.querySelector('.project-hover-name strong')?.textContent === 'Renamed project'", 'inline save updates the name');
    assert.equal(await run("projectRow('hover-project').querySelector('.project-title').textContent.trim()"), 'Renamed project', 'sidebar and card share the persisted name');
    assert.equal(await run('projectProps.projects[0].rootPath'), 'D:/fixture/cardbush', 'inline name edit preserves the workspace path');
    await run("document.querySelector('.project-hover-name').click()");
    await until("!!document.querySelector('.project-hover-name-form input')", 'edit for blur save');
    await run("projectInput('Saved on blur')");
    await run("document.querySelector('.project-hover-more').focus()");
    await until("document.querySelector('.project-hover-name strong')?.textContent === 'Saved on blur'", 'blur saves without a separate dialog');
    for (const theme of ['theme-dark', 'theme-light']) {
      await run(`document.querySelector('.app').className = 'app ${theme}'; showProjectFixture({language: 'en'});`);
      await until("document.querySelector('.project-hover-count')?.textContent === '7 chats'", 'mounted card follows language changes');
      await run("document.querySelector('.app').className = 'app ' + '" + theme + "'");
      await pause(320);
      assert.equal(await run("getComputedStyle(document.querySelector('.project-hover-name')).color"),
        await run("getComputedStyle(document.querySelector('.project-hover-preview')).color"), 'project name follows the card text color in ' + theme);
      fs.writeFileSync(path.join(root, 'tmp', `project-hover-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await escape();
    await hoverProject('empty-project');
    assert.equal(await run("document.querySelector('.project-hover-count').textContent"), '0 chats');
    assert.equal(await run("document.querySelector('.project-hover-empty').textContent"), 'No chats yet');
    assert.equal(await run("document.querySelectorAll('.project-hover-conversation').length"), 0, 'switching projects never retains the previous list');
    await escape();
    window.setSize(400, 430);
    await pause(180);
    await hoverProject();
    await run("document.querySelector('.project-hover-more').click()");
    await pause(120);
    const bounds = await run("(() => {const el=document.querySelector('.project-hover-preview'), r=el.getBoundingClientRect(), l=el.querySelector('.project-hover-conversations'); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:l.scrollHeight>l.clientHeight};})()");
    assert.ok(bounds.left >= 11 && bounds.right <= bounds.width - 11 && bounds.top >= 11 && bounds.bottom <= bounds.height - 11, 'expanded card stays within a narrow, short window: ' + JSON.stringify(bounds));
    assert.ok(bounds.scroll, 'expanded conversations scroll inside the bounded card');
    await run("document.querySelector('.project-hover-conversations').scrollTop=90");
    await pause(100);
    assert.equal(await run("!!document.querySelector('.project-hover-preview:popover-open')"), true, 'internal scrolling preserves the card');
    await escape();
    console.log('Project hover passed: recent three, incremental pages, scoped counts, pinned chats, navigation, inline rename/cancel/blur/errors, themes, language and narrow scrolling.');
  } finally {
    await run("renderView(null); localStorage.removeItem('cardbush_pinned_conversation_ids'); localStorage.removeItem('cardbush_archived_conversation_ids')");
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    window.webContents.debugger.detach();
    window.setSize(1200, 800);
  }
};
