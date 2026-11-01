const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const originalSize = window.getContentSize();
  const style = await window.webContents.insertCSS('.app { width:100% !important; }');
  await run(`
    window.permissionsSavedProps = { ...chatProps };
    window.permissionsSavedTheme = window.viewTheme;
    updateChat({ language:'zh', loading:false, historyLoading:false, messages:[], draft:'',
      permissionMode:'all_free', subagentPermissionRouting:'parent',
      onPermissionModeChange:permissionMode => updateChat({permissionMode}),
      onSubagentPermissionRoutingChange:subagentPermissionRouting => updateChat({subagentPermissionRouting}) });
    window.permissionGeometry = () => [...document.querySelectorAll('.permission-mode-row')].map(row => {
      const icon = row.querySelector(':scope > svg').getBoundingClientRect();
      const copy = row.querySelector(':scope > span').getBoundingClientRect();
      const label = row.querySelector('strong').getBoundingClientRect();
      const description = row.querySelector('small');
      return { iconWidth:icon.width, iconHeight:icon.height, iconLeft:icon.left,
        copyLeft:copy.left, copyWidth:copy.width, labelTop:label.top, iconTop:icon.top,
        descriptionClipped:description.scrollWidth > description.clientWidth + 1 ||
          description.scrollHeight > description.clientHeight + 1 };
    });
    void 0;
  `);
  const open = async () => {
    if (!await run("!!document.querySelector('.permission-mode-list')")) {
      await run("document.querySelector('.permission-center-button').click()");
    }
    await until("document.querySelectorAll('.permission-mode-row').length === 2", 'permission choices');
    await pause(100);
  };
  const check = async (label) => {
    const rows = await run('permissionGeometry()');
    assert.ok(Math.abs(rows[0].copyLeft - rows[1].copyLeft) < 1, `${label}: permission labels align`);
    assert.ok(Math.abs(rows[0].copyWidth - rows[1].copyWidth) < 1, `${label}: selected checkmark retains the same text width`);
    for (const row of rows) {
      assert.ok(row.iconWidth >= 14 && Math.abs(row.iconWidth - row.iconHeight) < 1, `${label}: shield icons stay square without shrinking`);
      assert.ok(Math.abs(row.iconTop - row.labelTop) < 4, `${label}: icons align with titles`);
      assert.equal(row.descriptionClipped, false, `${label}: permission descriptions are fully readable`);
    }
    assert.equal(await run(`(() => {
      const popup=document.querySelector('.composer-popover.permissions').getBoundingClientRect();
      const list=document.querySelector('.permission-mode-list');
      return popup.left >= 0 && popup.right <= innerWidth + 1 && popup.top >= 0 &&
        popup.bottom <= innerHeight + 1 && list.scrollWidth <= list.clientWidth + 1;
    })()`), true, `${label}: popup fits without horizontal clipping`);
  };
  try {
    for (const [language, theme, width, height, fontScale] of [
      ['zh', 'theme-dark', 1180, 760, 1],
      ['en', 'theme-bright', 640, 600, 1],
      ['zh', 'theme-bright', 640, 600, 1.3],
      ['en', 'theme-dark', 640, 480, 1.3],
    ]) {
      window.setContentSize(width, height);
      await run(`window.viewTheme=${JSON.stringify(theme)}; updateChat({language:${JSON.stringify(language)}})`);
      await pause();
      await run(`document.querySelector('.app').style.setProperty('--ui-font-scale', ${JSON.stringify(String(fontScale))})`);
      await open();
      await check(`${language}/${theme}/${width}/${fontScale}`);
      if (language === 'zh' && theme === 'theme-dark') {
        fs.writeFileSync(path.join(root, 'tmp/composer-permissions.png'), (await window.capturePage()).toPNG());
      }
      await run("document.querySelector('.permission-mode-row.mode-task_free').click()");
      await until("chatProps.permissionMode === 'task_free'", 'approval mode selected');
      await open();
      await check('approval selection');
      await run("document.querySelector('.subagent-routing-switch button:first-child').click()");
      await until("chatProps.subagentPermissionRouting === 'user'", 'unified permissions');
      await run("document.querySelector('.subagent-routing-switch button:last-child').click()");
      await until("document.querySelector('.subagent-routing-switch button:last-child').getAttribute('aria-pressed') === 'true'", 'model approval selected');
      await run("document.querySelector('.permission-mode-row.mode-all_free').click()");
      await until("chatProps.permissionMode === 'all_free'", 'full access selected');
    }
  } finally {
    await run(`document.querySelector('.app').style.removeProperty('--ui-font-scale');
      window.viewTheme=permissionsSavedTheme; updateChat(permissionsSavedProps);`);
    await window.webContents.removeInsertedCSS(style);
    window.setContentSize(...originalSize);
    await pause();
  }
};
