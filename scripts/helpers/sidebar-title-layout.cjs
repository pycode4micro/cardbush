// Real sidebar and native input, isolated from the product profile and Runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testSidebarTitleLayout({ run, until, pause, window, root }) {
  window.setSize(1200, 800);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/appearance.css'), 'utf8'));
  await run(`
    localStorage.setItem('cardbush_pinned_conversation_ids', JSON.stringify(['sidebar-short']));
    const sidebarNoop = () => {};
    window.sidebarSelections = [];
    window.sidebarTitles = [
      '这项目的服务现在还运行着么，需要确认后台服务是否仍在执行', '正在执行很长的项目验证与截图任务标题',
      '等待确认这项操作的执行结果和下一步处理', '短标题',
      'very-long-unbroken-conversation-title-for-layout-regression',
    ];
    const sidebarIds = ['sidebar-active', 'sidebar-running', 'sidebar-waiting', 'sidebar-short', 'sidebar-long'];
    window.sidebarFixtureProps = {
      language: 'zh', section: 'chat', activeConversationId: 'sidebar-active',
      runningConversationIds: new Set(['sidebar-running']),
      attentionByConversation: { 'sidebar-waiting': { sessionId: 'sidebar-waiting', kind: 'waiting', updatedAt: '2026-09-05T00:00:00Z' } },
      projects: [{ id: 'fixture-project', title: 'apex', rootPath: 'D:/fixture-project' }],
      conversations: sidebarIds.map((id, index) => ({
        id, title: sidebarTitles[index], projectId: 'fixture-project', projectDir: 'D:/fixture-project',
        preview: '', updatedAt: '2026-09-05T00:00:00Z',
      })),
      changeReportsByConversation: {}, onSectionChange: sidebarNoop,
      onConversationChange: id => sidebarSelections.push(id),
      onCreateConversation: sidebarNoop, onAddProject: sidebarNoop, onProjectAction: sidebarNoop,
      onDeleteConversation: sidebarNoop, onRenameConversation: async () => true,
      onOpenConversationChanges: sidebarNoop, onOpenSettings: sidebarNoop,
    };
    window.showSidebarFixture = patch => {
      Object.assign(sidebarFixtureProps, patch);
      renderView(h(views.ChatSidebar, sidebarFixtureProps));
    };
    showSidebarFixture({});
    window.sidebarRow = index => [...document.querySelectorAll('.conversation-row')]
      .find(row => row.querySelector('.conversation-title')?.getAttribute('aria-label') === sidebarTitles[index]);
    window.sidebarGeometry = index => {
      const row = sidebarRow(index), title = row.querySelector('.conversation-title');
      const text = title.querySelector('.conversation-title-text');
      const pin = row.querySelector('.conversation-pin'), menu = row.querySelector('.conversation-archive');
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
  await until("document.querySelectorAll('.conversation-row .conversation-title').length === 5", 'sidebar fixture rows');
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
  for (const theme of ['theme-dark', 'theme-light']) {
    for (const width of [220, 256, 320]) {
      await moveAway();
      await run(`document.querySelector('.app').className = 'app ${theme}'; document.querySelector('.app').style.setProperty('--sidebar-width', '${width}px'); undefined;`);
      await pause(320);
      for (const index of [0, 1, 2, 4]) {
        await moveAway();
        const rest = await run(`sidebarGeometry(${index})`);
        assert.equal(rest.pinOpacity, '0', 'idle rows hide actions');
        const rightInset = index === 1 || index === 2 ? 36 : 8;
        assert.ok(Math.abs(rest.titleRect.right - (rest.rowRect.right - rightInset)) <= 1,
          'only visible status indicators reserve space beside the title');
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
  // The hidden offscreen test window needs focus emulation to receive keyboard input.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Await dispatch: fire-and-forget keyboard input could arrive after focus()
  // and advance focus again, making the accessibility assertion race the browser.
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await run("sidebarRow(1).querySelector('.conversation-pin').focus()");
  await until("sidebarRow(1).querySelector('.conversation-pin').matches(':focus-visible')", 'keyboard focus');
  await until("sidebarGeometry(1).pinOpacity === '1' && sidebarGeometry(1).menuOpacity === '1'", 'keyboard action lane finishes its transition');
  assert.equal(await run('sidebarGeometry(1).pinOpacity'), '1');
  assert.equal(await run('sidebarGeometry(1).menuOpacity'), '1', 'keyboard focus reveals both actions');
  assert.equal(await run("getComputedStyle(sidebarRow(1).querySelector('.conversation-running-indicator')).opacity"), '0',
    'status must not overlap focused actions');
  await run("document.activeElement.blur()");
  window.webContents.debugger.detach();
  await moveAway();
  for (const theme of ['theme-dark', 'theme-bright']) {
    await run(`viewTheme = ${JSON.stringify(theme)}; showSidebarFixture({ runningConversationIds: new Set(), attentionByConversation: {} })`);
    await pause(160);
    // Earlier geometry cases set this class directly, outside React's props.
    await run(`document.querySelector('.app').className = 'app ' + ${JSON.stringify(theme)}`);
    const baseline = await run('[sidebarGeometry(0), sidebarGeometry(1)]');
    await run("showSidebarFixture({ runningConversationIds: new Set(['sidebar-active', 'sidebar-running']) })");
    await until("document.querySelectorAll('.conversation-running-indicator svg').length === 2", 'running spinners');
    for (const index of [0, 1]) {
      const state = await run(`sidebarGeometry(${index})`);
      assert.equal(state.titleColor, baseline[index].titleColor, `${theme} running preserves normal title color`);
      assert.equal(state.titleRect.width, baseline[index].titleRect.width - 28, 'running reserves space for its visible spinner');
      assert.equal(state.titleRect.x, baseline[index].titleRect.x);
      assert.equal(await run(`sidebarRow(${index}).querySelector('.conversation-running-indicator svg').getAnimations().filter(animation => animation.animationName === 'cardbush-spin' && animation.playState === 'running').length`), 1,
        'running marker has one rotating spinner');
      const indicator = await run(`(() => {
        const element = sidebarRow(${index}).querySelector('.conversation-running-indicator');
        const rect = element.getBoundingClientRect();
        return { opacity: getComputedStyle(element).opacity, rect: rect.toJSON() };
      })()`);
      assert.equal(indicator.opacity, '1', 'running spinner stays visible outside hover');
      assert.ok(indicator.rect.width > 0 && indicator.rect.right <= state.rowRect.right);
      assert.ok(state.titleRect.right < indicator.rect.left, 'title must not overlap the visible spinner');
      assert.ok(Math.abs(indicator.rect.y + indicator.rect.height / 2 - state.rowRect.y - state.rowRect.height / 2) < 1,
        'rotation keeps the status centered in its row');
      assert.equal(await run(`sidebarRow(${index}).getAttribute('title')`), '会话运行中');
    }
    if (theme === 'theme-dark') {
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      window.webContents.invalidate();
      await pause(150);
      fs.writeFileSync(path.join(root, 'tmp', 'sidebar-running-spinner.png'), (await window.webContents.capturePage()).toPNG());
    }
    await run(`showSidebarFixture({ runningConversationIds: new Set(), attentionByConversation: {
      'sidebar-running': { sessionId: 'sidebar-running', kind: 'completed', updatedAt: '2026-09-05T00:00:00Z' },
    } })`);
    await until("!document.querySelector('.conversation-running-indicator')", 'completed task clears running marker');
    assert.equal(await run("document.getAnimations().filter(animation => animation.animationName === 'cardbush-spin').length"), 0,
      'completion leaves no running spinner animation');
    for (const index of [0, 1]) {
      const state = await run(`sidebarGeometry(${index})`);
      if (index === 0) assert.equal(state.titleColor, baseline[index].titleColor, `${theme} completion restores normal text color`);
      else assert.equal(await run("sidebarRow(1).classList.contains('running')"), false, 'unread completion uses normal attention styling');
      assert.equal(state.titleRect.width, baseline[index].titleRect.width - (index === 1 ? 28 : 0),
        'completion without an attention marker returns the space to the title');
    }
    assert.ok(await run("!!sidebarRow(1).querySelector('.conversation-attention-indicator.completed svg')"));
    for (const kind of ['waiting', 'error']) {
      await run(`showSidebarFixture({ attentionByConversation: { 'sidebar-running': {
        sessionId: 'sidebar-running', kind: '${kind}', updatedAt: '2026-09-05T00:00:00Z' } } })`);
      await until(`!!sidebarRow(1).querySelector('.conversation-attention-indicator.${kind}')`, kind + ' status marker');
      assert.equal((await run('sidebarGeometry(1)')).titleRect.width, baseline[1].titleRect.width - 28, kind + ' keeps status lane');
    }
    await run('showSidebarFixture({ attentionByConversation: {} })');
    await until("!sidebarRow(1).querySelector('.conversation-attention-indicator')", 'attention clears');
    assert.equal((await run('sidebarGeometry(1)')).titleColor, baseline[1].titleColor, 'viewed completion restores background title color');
    assert.equal((await run('sidebarGeometry(1)')).titleRect.width, baseline[1].titleRect.width,
      'clearing attention returns the status lane to the title');
  }
  await run("showSidebarFixture({ language: 'en', attentionByConversation: {}, runningConversationIds: new Set(['sidebar-active']) })");
  await until("sidebarRow(0).getAttribute('title') === 'Session running'", 'running tooltip follows UI language');
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(50);
    assert.equal(await run("document.querySelector('.conversation-running-indicator').getAnimations({ subtree: true }).length"), 0,
      'reduced motion retains the status icon without rotation');
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
  }
  if (process.env.CARDBUSH_SIDEBAR_SCREENSHOT) {
    await run("document.querySelector('.app').style.setProperty('--sidebar-width', '256px')");
    await pause(320);
    await hover(0);
    fs.writeFileSync(process.env.CARDBUSH_SIDEBAR_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    console.log('Sidebar screenshot: ' + process.env.CARDBUSH_SIDEBAR_SCREENSHOT);
  }
  console.log('Sidebar titles passed: themes, widths, hover/status/pinned rows, marquee endpoint, pointer focus, keyboard and menus.');
};
