const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/inspector/inspectorWorkspace.css'), 'utf8'));
  await run(`
    window.inspectorActions = [];
    window.startProps = {
      language: 'zh', filesAvailable: true, shadowUnavailableReason: '',
      onOpenFiles: () => inspectorActions.push('files'),
      onOpenShadow: () => inspectorActions.push('shadow'),
      onOpenBookmark: () => inspectorActions.push('bookmark'),
    };
    window.showInspectorStart = (width = 620) => renderView(h('aside', {
      className: 'right-inspector', style: { width, height: 700, flex: 'none', maxWidth: 'none' },
    }, h('header', { className: 'right-inspector-toolbar' }, h('strong', null)),
      h('div', { className: 'right-inspector-body' },
        h(views.InspectorActions, startProps))));
    showInspectorStart();
  `);
  await until("document.querySelectorAll('[data-inspector-action]').length === 2", 'new-tab tools');
  await run("startProps.onOpenReview = () => inspectorActions.push('review'); showInspectorStart()");
  await until("document.querySelectorAll('[data-inspector-action]').length === 3", 'project review remains reachable without file changes');
  for (const theme of ['theme-dark', 'theme-bright']) {
    for (const width of [620, 320]) {
      await run(`window.viewTheme = ${JSON.stringify(theme)}; showInspectorStart(${width})`);
      await pause();
      const layout = await run(`(() => {
        const body = document.querySelector('.right-inspector-body').getBoundingClientRect();
        const actions = document.querySelector('.right-inspector-start-actions').getBoundingClientRect();
        return { topAligned: Math.abs(actions.y - body.y) < 2,
          columns: getComputedStyle(document.querySelector('.inspector-start-tools')).gridTemplateColumns.split(' ').length,
          contained: [...document.querySelectorAll('[data-inspector-action]')].every(button => {
            const bounds = button.getBoundingClientRect();
            const text = button.querySelector('strong');
            return bounds.left >= body.left && bounds.right <= body.right && text.scrollWidth <= text.clientWidth;
          }) };
      })()`);
      assert.deepEqual(layout, { topAligned: true, columns: width > 500 ? 2 : 1, contained: true }, `${theme} ${width}px layout`);
    }
  }
  for (const id of ['review', 'files', 'shadow']) {
    await run(`document.querySelector('[data-inspector-action=${id}]').click()`);
  }
  assert.deepEqual(await run('inspectorActions'), ['review', 'files', 'shadow']);
  await run(`Object.assign(startProps, { filesAvailable: false, shadowUnavailableReason: '当前任务结束后可创建 Shadow 对话' }); showInspectorStart()`);
  await until("document.querySelector('[data-inspector-action=shadow]').disabled", 'unavailable actions');
  await run("document.querySelector('[data-inspector-action=files]').click(); document.querySelector('[data-inspector-action=shadow]').click()");
  assert.deepEqual(await run('inspectorActions'), ['review', 'files', 'shadow'], 'unavailable actions do not dispatch');
  assert.equal(await run("document.querySelector('[data-inspector-action=shadow]').title"), '当前任务结束后可创建 Shadow 对话');
  assert.equal(await run("document.querySelector('.inspector-bookmark-entry').disabled"), false);
  await run(`window.viewTheme = 'theme-dark'; Object.assign(startProps, { filesAvailable: true, shadowUnavailableReason: '' }); showInspectorStart()`);
  await pause();
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'inspector-start.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 620, height: 700 })).toPNG());
  console.log('Inspector start page passed: always-visible toggle, action routing, unavailable states, top-aligned layout and narrow widths in both themes.');
};
