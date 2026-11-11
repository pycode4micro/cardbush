const assert = require('node:assert/strict');

module.exports = async ({win, read, wait, visible, click, showQuickPanel, row}) => {
  const drawer = '.recent-turn-drawer:popover-open', menu = '.sidebar-context-menu[role=menu]';
  const pin = row + ' .conversation-pin', archive = row + ' .conversation-archive';
  const item = key => '[data-sidebar-menu-item="' + key + '"]';
  const rects = () => read(`(() => {
    const panel = document.querySelector('${drawer}'), list = panel.querySelector('.recent-turn-scroll');
    return [panel, list, ...list.querySelectorAll('[data-recent-session]')].map(node => {
      const r = node.getBoundingClientRect();
      return [r.x,r.y,r.width,r.height,node.scrollWidth,node.scrollHeight,node.scrollTop].map(Math.round);
    });
  })()`);
  const pointer = async (selector, button) => {
    await visible(selector);
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
      return {x,y};
    })()`);
    win.webContents.sendInputEvent({type:'mouseMove', ...point});
    await wait(() => read(`document.querySelector(${JSON.stringify(selector)})?.matches(':hover') && document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x},${point.y}))`), 'pointer reaches ' + selector);
    if (button) for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type, button, clickCount:1, ...point});
  };
  win.focus(); win.webContents.focus();
  for (const width of [1400, 680]) {
    win.setContentSize(width, 740);
    await wait(() => read(`innerWidth === ${width}`), 'updated viewport');
    const layout = width === 1400 ? 'docked' : 'drawer';
    await wait(() => read(`document.querySelector('.desktop-shell').dataset.sidebarLayout === '${layout}' && !document.querySelector('.sidebar').getAnimations().length`), 'sidebar anchor settles at the new width');
    // Changing between docked and overlay modes can finish a previous light-dismiss.
    await showQuickPanel();
    await click('[data-recent-tab=sessions]');
    await visible(row);
    await wait(() => read(`document.querySelector('${drawer}').getAnimations().every(a => a.playState !== 'running') && document.querySelector('${drawer}').getBoundingClientRect().right<=innerWidth`), 'drawer has settled');
    const original = await rects();
    await pointer(row);
    const target = width === 1400 ? row : pin;
    await pointer(target, 'right');
    await visible(item('pin'));
    assert.deepEqual(await rects(), original, 'right-click preserves drawer, rows and scroll extent at width ' + width);
    await pointer(item('workspace'), 'left');
    await visible(item('workspace:none'));
    await pointer(item('workspace:none'));
    assert.deepEqual(await rects(), original, 'submenu stays outside scroll layout');
    await pointer(item('pin'), 'left');
    const pinned = width === 1400;
    await wait(() => read(`document.querySelector('${pin}').getAttribute('aria-pressed') === '${pinned}'`), 'menu updates pin state');
    assert.equal(await read(`!!document.querySelector('${pin} .lucide-pin-off')`), pinned, 'pin artwork reflects the available action');
    for (const selector of [pin, archive]) assert.ok(await read(`document.querySelector('${selector} svg').getBoundingClientRect().width >= 18`));
    assert.ok(await read(`document.querySelector('${row}').firstElementChild.matches('.recent-row-copy') && !document.querySelector('${row} small')`));
  }
  await read(`document.querySelector('${row}').focus();void 0`);
  const key = (keyCode, modifiers = []) => {
    for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type, keyCode, modifiers});
  };
  key('F10', ['shift']);
  await visible(item('rename'));
  key('Escape');
  await wait(() => read(`!document.querySelector('${menu}') && document.activeElement.matches('${row}') && !!document.querySelector('${drawer}')`), 'Escape returns keyboard focus to the row');
  await pointer(row);
  await pointer(pin, 'left');
  await wait(() => read(`!!document.querySelector('${pin} .lucide-pin-off')`), 'inline pin updates immediately');
  win.setContentSize(1400, 800);
  await visible(row);
};
