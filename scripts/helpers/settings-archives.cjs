const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, window: win, root, click, edit }) => {
  await run(`
    window.archiveRestores = [];
    window.sidebarOpenedConversations = [];
    window.sidebarProjectActions = [];
    settingsProps.onProjectAction = (action, project) => {
      sidebarProjectActions.push({action,id:project.id});
      if (action === 'archive') {
        settingsProps.projects = settingsProps.projects.map(item => item.id === project.id ? {...item,archived:true} : item);
        renderSettings();
      }
    };
    settingsProps.projects = [{ id:'archived-project', title:'归档项目', rootPath:'C:/fixture/project', archived:true }];
    settingsProps.conversations = [
      { id:'archive-a', title:'待归档会话', preview:'', updatedAt:'2026-09-19T10:00:00Z' },
      { id:'archive-b', title:'项目里的归档会话', preview:'', updatedAt:'2026-09-18T10:00:00Z', projectId:'archived-project', projectDir:'C:/fixture/project' },
      { id:'archive-c', title:'保留归档', preview:'', updatedAt:'2026-09-17T10:00:00Z' },
    ];
    settingsProps.onRestoreProjects = ids => {
      archiveRestores.push(ids);
      settingsProps.projects = settingsProps.projects.map(item => ids.includes(item.id) ? { ...item, archived:false } : item);
      renderSettings();
    };
    archiveFixture.setArchived(['archive-b','archive-c','deleted-id'], true);
    renderSettings(); setSettingsActive(false);
  `);
  await until("!!Array.from(document.querySelectorAll('.conversation-row')).find(row => row.textContent.includes('待归档会话'))");
  await run(`Array.from(document.querySelectorAll('.conversation-row')).find(row => row.textContent.includes('待归档会话'))
    .querySelector('.conversation-archive').click();`);
  await until("!Array.from(document.querySelectorAll('.conversation-row')).some(row => row.textContent.includes('待归档会话'))");
  assert.deepEqual(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey))'), ['archive-b','archive-c','deleted-id','archive-a']);
  assert.deepEqual(await run('sidebarOpenedConversations'), [], 'direct archive must not open the conversation');
  assert.equal(await run("!!document.querySelector('.sidebar-context-menu,.conversation-more')"), false, 'archive is a direct action without a menu');
  await run('setSettingsActive(true)');
  await click('数据与维护');
  await until("document.querySelectorAll('.archive-manager-row').length === 3");
  assert.equal(await run("document.querySelectorAll('[data-archive-id=deleted-id]').length"), 0);

  await edit('.archive-manager-search input', '待归档');
  await until("document.querySelectorAll('.archive-manager-row').length === 1");
  await run("document.querySelector('[data-archive-id=archive-a] button').click()");
  await until("document.querySelector('.archive-manager-empty')?.textContent.includes('没有匹配')");
  assert.equal(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey)).includes("archive-a")'), false);
  assert.equal(await run("Array.from(document.querySelectorAll('.conversation-row')).some(row => row.textContent.includes('待归档会话'))"), true, 'restoration immediately reaches the mounted sidebar');
  await edit('.archive-manager-search input', '');

  // Failed persistence must leave the item available and display a useful error.
  await run(`window.archiveSetItem = localStorage.setItem;
    localStorage.setItem = (key,value) => { if(key === archiveFixture.storageKey) throw Error('fixture storage full'); archiveSetItem(key,value); };
    document.querySelector('[data-archive-id=archive-c] button').click();`);
  await until("document.querySelector('.archive-manager [role=alert]')?.textContent.includes('storage full')");
  assert.equal(await run("!!document.querySelector('[data-archive-id=archive-c]')"), true);
  await run('localStorage.setItem = archiveSetItem; void 0');
  await run("document.querySelector('[data-archive-id=archive-b] button').click()");
  await until("!document.querySelector('[data-archive-id=archive-b]')");
  assert.deepEqual(await run('archiveRestores'), [['archived-project']], 'restoring a chat also makes its archived parent visible');
  assert.equal(await run('settingsProps.projects[0].archived'), false);
  assert.equal(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey)).includes("archive-c")'), true, 'other archived chats stay archived');

  await run('setSettingsActive(false)');
  await until("!!document.querySelector('.project-row .row-archive')");
  await run("document.querySelector('.project-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:40,clientY:300}))");
  await until("!!document.querySelector('.sidebar-context-menu')");
  assert.equal(await run("['在资源管理器中打开','重命名项目','移除'].every(label=>document.querySelector('.sidebar-context-menu').textContent.includes(label))"), true, 'project actions remain in the context menu');
  await run("document.querySelector('.project-row .row-archive').click()");
  await until("!document.querySelector('.project-row')");
  assert.deepEqual(await run('sidebarProjectActions'), [{action:'archive',id:'archived-project'}], 'direct project archive dispatches exactly once');
  assert.equal(await run("!!document.querySelector('.sidebar-context-menu,.sidebar-menu,.row-more')"), false, 'project archive closes menus and removes the old dots');
  await run("archiveFixture.setArchived(['archive-a','archive-b'], true); setSettingsActive(true)");
  await run("document.querySelectorAll('.archive-manager-tabs button')[1].click()");
  await until("!!document.querySelector('[data-archive-id=archived-project]')");
  await run("document.querySelector('[data-archive-id=archived-project] button').click()");
  await until("document.querySelector('.archive-manager-empty')?.textContent.includes('暂无已归档项目')");
  assert.equal(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey)).includes("archive-b")'), true, 'project restoration preserves individually archived chats');
  await run("document.querySelectorAll('.archive-manager-tabs button')[0].click()");

  // Unmount/remount settings and sidebar. Only persisted archive metadata survives.
  await run('renderComposer()');
  await until("!document.querySelector('.archive-manager')");
  await run("settingsProps.initialSection = 'cache'; renderSettings()");
  await until("document.querySelectorAll('.archive-manager-row').length === 3");
  await edit('.archive-manager-search input', '归档');
  await click('恢复搜索结果');
  await until("document.querySelectorAll('.archive-manager-row').length === 0");
  assert.deepEqual(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey))'), ['deleted-id']);
  await edit('.archive-manager-search input', '');
  assert.equal(await run("document.querySelector('.archive-manager-toolbar > button').disabled"), true);

  // Bound the list and restore all matching entries, including subsequent pages.
  await run(`settingsProps.conversations = Array.from({length:25}, (_,i) => ({id:'paged-'+i,
    title:'归档测试 '+i+'：很长的标题用于检查窄窗口布局', preview:'', updatedAt:'2026-09-19T10:00:00Z'}));
    archiveFixture.setArchived(settingsProps.conversations.map(item=>item.id),true); renderSettings();`);
  await until("document.querySelectorAll('.archive-manager-row').length === 20");
  await click('下一页');
  await until("document.querySelectorAll('.archive-manager-row').length === 5");
  await run("document.querySelector('.settings-content').scrollTop=0");
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(root,'tmp/settings-archives-dark.png'), (await win.webContents.capturePage()).toPNG());
  await run("settingsProps.language='en'; settingsTheme='bright'; renderSettings()");
  win.setContentSize(760,850);
  await until("document.querySelector('.archive-manager-toolbar > button')?.textContent.includes('Restore all')");
  assert.equal(await run("Array.from(document.querySelectorAll('.archive-manager,.archive-manager-row')).every(el=>el.scrollWidth<=el.clientWidth+1)"), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.join(root,'tmp/settings-archives-light.png'), (await win.webContents.capturePage()).toPNG());
  await click('Restore all');
  await until("document.querySelector('.archive-manager-empty')?.textContent.includes('No archived chats')");
  assert.deepEqual(await run('JSON.parse(localStorage.getItem(archiveFixture.storageKey))'), ['deleted-id']);
  console.log('Archives passed: real sidebar archive, persisted remount, search, single/bulk restoration, parent projects, write failure, pagination and responsive bilingual settings.');
};
