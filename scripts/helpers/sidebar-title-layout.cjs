// Real sidebar and native input, isolated from the product profile and Runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testSidebarTitleLayout({ run, until, pause, window, root }) {
  window.setSize(1200, 800);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/themes/cyberpunk.css'), 'utf8'));
  await run(`
    localStorage.setItem('cardbush_pinned_conversation_ids', JSON.stringify(['sidebar-short']));
    const sidebarNoop = () => {};
    window.sidebarSelections = [];
    window.sidebarTitles = [
      '这项目的服务现在还运行着么', '正在执行很长的项目验证与截图任务标题',
      '等待确认这项操作的执行结果和下一步处理', '短标题',
      'very-long-unbroken-conversation-title-for-layout-regression',
    ];
    const sidebarIds = ['sidebar-active', 'sidebar-running', 'sidebar-waiting', 'sidebar-short', 'sidebar-long'];
    renderView(h(views.ChatSidebar, {
      language: 'zh', section: 'chat', activeConversationId: 'sidebar-active',
      runningConversationIds: new Set(['sidebar-running']),
      attentionByConversation: { 'sidebar-waiting': { sessionId: 'sidebar-waiting', kind: 'waiting', updatedAt: '2026-09-05T00:00:00Z' } },
      projects: [{ id: 'fixture-project', title: 'apex', rootPath: 'D:/fixture-project' }],
      conversations: sidebarIds.map((id, index) => ({
        id, title: sidebarTitles[index], projectId: 'fixture-project', projectDir: 'D:/fixture-project',
        preview: '', updatedAt: '2026-09-05T00:00:00Z',
      })),
      changeReportsByConversation: {}, onlyTalkMode: false,
      onOnlyTalkModeChange: sidebarNoop, onSectionChange: sidebarNoop,
      onConversationChange: id => sidebarSelections.push(id),
      onCreateConversation: sidebarNoop, onAddProject: sidebarNoop, onProjectAction: sidebarNoop,
      onDeleteConversation: sidebarNoop, onRenameConversation: async () => true,
      onOpenConversationChanges: sidebarNoop, onOpenSettings: sidebarNoop,
    }));
    window.sidebarRow = index => [...document.querySelectorAll('.conversation-row')]
      .find(row => row.querySelector('.conversation-title')?.getAttribute('aria-label') === sidebarTitles[index]);
    window.sidebarGeometry = index => {
      const row = sidebarRow(index), title = row.querySelector('.conversation-title');
      const text = title.querySelector('.conversation-title-text');
      const pin = row.querySelector('.conversation-pin'), menu = row.querySelector('.conversation-more');
      const s = getComputedStyle(title), rect = node => node.getBoundingClientRect();
      const actions = Number.parseFloat(s.getPropertyValue('--conversation-title-hover-actions'));
      const fade = Number.parseFloat(s.getPropertyValue('--conversation-title-trailing-fade'));
      const edge = rect(title).right - actions;
      return {
        mask: s.maskImage, animation: getComputedStyle(text).animationName,
        pinOpacity: getComputedStyle(pin).opacity, menuOpacity: getComputedStyle(menu).opacity,
        buttonWidth: rect(pin).width, clearance: rect(pin).left - edge, fade,
        rowWidth: rect(row).width, textRight: rect(text).right,
        titleRect: rect(title).toJSON(), rowRect: rect(row).toJSON(), pinRect: rect(pin).toJSON(),
        titleLayout: [s.width, s.paddingLeft, s.marginLeft, s.flex, s.boxSizing, getComputedStyle(row).gap],
        overflow: Number(title.dataset.overflowWidth), fullyVisibleEnd: edge - fade,
        actionColor: getComputedStyle(pin).color, titleColor: getComputedStyle(title).color,
      };
    };
    undefined;
  `);
  await until("document.querySelectorAll('.conversation-row').length === 5", 'sidebar fixture rows');
  const moveAway = async () => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 450, y: 10 });
    await pause(130);
    await until("[...document.querySelectorAll('.conversation-pin')].every(button => getComputedStyle(button).opacity === '0')", 'idle actions settle');
  };
  const hover = async index => {
    const point = await run(`(() => { const r = sidebarRow(${index}).getBoundingClientRect(); return { x: Math.round(r.x + 70), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await pause(130);
    await until(`getComputedStyle(sidebarRow(${index}).querySelector('.conversation-pin')).opacity === '1'`, 'hover actions settle');
    return point;
  };
  for (const theme of ['theme-dark', 'theme-light', 'theme-cyberpunk']) {
    for (const width of [220, 256, 320]) {
      await moveAway();
      await run(`document.querySelector('.app').className = 'app ${theme}'; document.querySelector('.app').style.setProperty('--sidebar-width', '${width}px'); undefined;`);
      await pause(320);
      for (const index of [0, 1, 2, 4]) {
        await moveAway();
        const rest = await run(`sidebarGeometry(${index})`);
        assert.equal(rest.pinOpacity, '0', 'idle rows hide actions');
        assert.ok(Math.abs(rest.titleRect.right - (rest.rowRect.right - ([1, 2].includes(index) ? 36 : 8))) <= 1,
          'idle titles must use all available space, including the former 24px width-cap loss');
        await hover(index);
        const geometry = await run(`sidebarGeometry(${index})`);
        assert.equal(geometry.pinOpacity, '1');
        assert.equal(geometry.menuOpacity, '1');
        assert.equal(geometry.buttonWidth, 22, 'do not shrink button hit targets');
        assert.ok(geometry.clearance >= 2 && geometry.clearance <= 4,
          'mask must end just before the actual buttons: ' + JSON.stringify(geometry));
        assert.ok(geometry.fade <= 6, 'fade must not hide another full glyph');
        assert.equal(geometry.rowWidth, rest.rowWidth, 'hover must not relayout the row');
        if (geometry.overflow > 0) {
          await run(`sidebarRow(${index}).querySelector('.conversation-title-text').getAnimations().forEach(animation => animation.finish()); undefined;`);
          const end = await run(`sidebarGeometry(${index})`);
          assert.ok(Math.abs(end.textRight - end.fullyVisibleEnd) <= 2.5,
            'last glyph must stop outside the fade without extra blank space: ' + JSON.stringify(end));
        }
        if (theme === 'theme-cyberpunk' && index === 0) {
          assert.equal(geometry.actionColor, geometry.titleColor, 'selected yellow rows need dark actions');
        }
      }
    }
  }
  await moveAway();
  await hover(3);
  assert.equal(await run('sidebarGeometry(3).mask'), 'none', 'short titles need no mask');
  assert.equal(await run('sidebarGeometry(3).animation'), 'none', 'short titles need no marquee');
  await moveAway();
  await run("document.querySelector('.app').style.setProperty('--sidebar-width', '256px')");
  await pause(320);
  await until('sidebarGeometry(0).overflow > 0', 'action lane truncates the fixture title');
  const idleMask = await run('sidebarGeometry(0).mask');
  const point = await hover(0);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await moveAway();
  assert.equal(await run('sidebarGeometry(0).mask'), idleMask, 'mouse selection restores the full idle mask');
  assert.equal(await run('sidebarGeometry(0).animation'), 'none', 'pointer focus must not retain the action mask');
  assert.equal(await run('sidebarGeometry(0).pinOpacity'), '0');
  assert.deepEqual(await run('sidebarSelections'), ['sidebar-active']);
  await run("sidebarRow(0).querySelector('.conversation-more').click()");
  await until("!!sidebarRow(0).querySelector('.sidebar-menu')", 'conversation menu opens');
  await until("sidebarGeometry(0).menuOpacity === '1'", 'menu action lane finishes its transition');
  assert.equal(await run('sidebarGeometry(0).menuOpacity'), '1', 'open menus keep their action lane');
  await run("sidebarRow(0).querySelector('.conversation-more').click()");
  await until("!sidebarRow(0).querySelector('.sidebar-menu')", 'conversation menu closes');
  // The hidden offscreen test window needs focus emulation to receive keyboard input.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await run("sidebarRow(1).querySelector('.conversation-pin').focus()");
  await until("sidebarRow(1).querySelector('.conversation-pin').matches(':focus-visible')", 'keyboard focus');
  await until("sidebarGeometry(1).pinOpacity === '1' && sidebarGeometry(1).menuOpacity === '1'", 'keyboard action lane finishes its transition');
  assert.equal(await run('sidebarGeometry(1).pinOpacity'), '1');
  assert.equal(await run('sidebarGeometry(1).menuOpacity'), '1', 'keyboard focus reveals both actions');
  assert.equal(await run("getComputedStyle(sidebarRow(1).querySelector('.conversation-running-indicator')).opacity"), '0',
    'status must not overlap focused actions');
  await run("document.activeElement.blur()");
  window.webContents.debugger.detach();
  if (process.env.CARDBUSH_SIDEBAR_SCREENSHOT) {
    await run("document.querySelector('.app').style.setProperty('--sidebar-width', '256px')");
    await pause(320);
    await hover(0);
    fs.writeFileSync(process.env.CARDBUSH_SIDEBAR_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    console.log('Sidebar screenshot: ' + process.env.CARDBUSH_SIDEBAR_SCREENSHOT);
  }
  console.log('Sidebar titles passed: themes, widths, hover/status/pinned rows, marquee endpoint, pointer focus, keyboard and menus.');
};
