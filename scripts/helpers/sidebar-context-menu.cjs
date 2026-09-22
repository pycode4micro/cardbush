const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testSidebarMenu({ run, until, pause, window, root }) {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/windowMaterial.css'), 'utf8'));
  await run(`
    document.documentElement.dataset.windowMaterial = 'mica';
    window.menuMoves = [];
    window.menuNoop = () => {};
    window.showMenuFixture = (theme = 'dark', running = false) => {
      window.viewTheme = 'theme-' + theme;
      renderView(h('div', { className: 'desktop-shell' }, h(views.ChatSidebar, {
        language: 'zh', section: 'chat', activeConversationId: 'menu-chat',
        projects: [{ id: 'alpha', title: 'Alpha', rootPath: 'C:/fixture/alpha' }],
        conversations: [{ id: 'menu-chat', title: '菜单样式', preview: '', updatedAt: '2026-09-21T00:00:00Z' }],
        runningConversationIds: new Set(running ? ['menu-chat'] : []), changeReportsByConversation: {},
        onSectionChange: menuNoop, onConversationChange: menuNoop, onCreateConversation: menuNoop,
        onAddProject: menuNoop, onProjectAction: menuNoop, onDeleteConversation: menuNoop,
        onRenameConversation: async () => true, onOpenConversationChanges: menuNoop, onOpenSettings: menuNoop,
        onConversationWorkspaceChange: async (id, project) => { menuMoves.push([id, project?.id ?? null]); },
      })));
    };
    showMenuFixture(); undefined;
  `);
  const open = async (edge = false) => {
    await until("!!document.querySelector('.conversation-row.active')", 'conversation row');
    await run(`document.querySelector('.app').style.width = '100%';
      document.querySelector('.conversation-row.active').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: ${edge ? 'innerWidth - 4' : '160'}, clientY: ${edge ? 'innerHeight - 4' : '120'}
      })); undefined;`);
    await until("!!document.querySelector('.sidebar-context-menu')", 'context menu');
  };
  const key = value => run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true })); undefined;`);
  const workspace = '[data-sidebar-menu-item="workspace"]';
  const bounds = async () => {
    const rectangles = await run(`Array.from(document.querySelectorAll('.sidebar-context-menu')).map(node => {
      const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: node.scrollWidth > node.clientWidth };
    })`);
    for (const r of rectangles) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.right <= r.viewportWidth && r.bottom <= r.viewportHeight, JSON.stringify(r));
      assert.equal(r.overflow, false, 'menu content fits horizontally');
    }
  };
  window.setSize(980, 760);
  await pause(60);
  for (const theme of ['dark', 'bright']) {
    await run(`showMenuFixture('${theme}'); undefined;`);
    await pause(30); await open();
    assert.equal(await run(`document.querySelector('${workspace}').getAttribute('aria-haspopup')`), 'menu');
    await bounds();
    await pause(100);
    const crop = await run(`(()=>{const r=document.querySelector('.sidebar-context-menu').getBoundingClientRect();
      return { x: Math.floor(r.x)-8, y: Math.floor(r.y)-8, width: Math.ceil(r.width)+16, height: Math.ceil(r.height)+16 };})()`);
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'sidebar-menu-reference-' + theme + '.png'), (await window.webContents.capturePage(crop)).toPNG());
    await run(`document.querySelector('${workspace}').focus(); undefined;`);
    await key('ArrowRight');
    await until("document.querySelectorAll('.sidebar-context-menu').length === 2", 'keyboard submenu');
    assert.equal(await run('document.activeElement.dataset.sidebarMenuItem'), 'workspace:alpha');
    await bounds();
    await key('ArrowLeft');
    await until("document.querySelectorAll('.sidebar-context-menu').length === 1", 'return to parent');
    assert.equal(await run('document.activeElement.dataset.sidebarMenuItem'), 'workspace');
    await run(`document.querySelector('${workspace}').click(); undefined;`);
    await until("document.querySelectorAll('.sidebar-context-menu').length === 2", 'click submenu');
    await run(`document.querySelector('[data-sidebar-menu-item="workspace:alpha"]').click(); undefined;`);
    await until("!document.querySelector('.sidebar-context-menu')", 'selection closes menu');
  }
  assert.deepEqual(await run('menuMoves'), [['menu-chat', 'alpha'], ['menu-chat', 'alpha']]);
  await open();
  const pointer = await run(`(()=>{const r=document.querySelector('${workspace}').getBoundingClientRect(); return {x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)};})()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...pointer });
  await until("document.querySelectorAll('.sidebar-context-menu').length === 2", 'hover submenu');
  await run("document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); undefined;");
  await until("!document.querySelector('.sidebar-context-menu')", 'outside dismiss');
  window.setSize(480, 480); await pause(80); await open(true);
  await run(`document.querySelector('${workspace}').click(); undefined;`);
  await until("document.querySelectorAll('.sidebar-context-menu').length === 2", 'small submenu');
  await bounds();
  await key('Escape'); await key('Escape');
  await until("!document.querySelector('.sidebar-context-menu')", 'escape dismiss');
  await run("showMenuFixture('dark', true); undefined;"); await pause(30); await open();
  assert.equal(await run(`document.querySelector('${workspace}').disabled`), true, 'running tasks cannot switch workspaces');
  await key('End');
  assert.equal(await run('document.activeElement.dataset.sidebarMenuItem'), 'delete');
  await key('Escape');
  console.log('Sidebar menus passed: light/dark visuals, submenu hover/click/keyboard, selection, outside/Escape dismissal, small viewport and running-task protection.');
};
