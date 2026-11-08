const assert = require('node:assert/strict');

module.exports = async ({run, until, window}) => {
  await run(`
    window.cardbushDesktop.isMaximized = async () => false;
    window.railCollapsed = false;
    window.railToggleCalls = 0;
    window.showRail = () => renderView([
      h(views.WindowFrame, {key:'frame',language:'zh',sidebarCollapsed:railCollapsed,menus:[],onError:error=>failures.push(String(error))}),
      h('main', {key:'shell',className:'desktop-shell' + (railCollapsed?' sidebar-is-collapsed':''),'data-sidebar-layout':'docked'},
        h(views.WindowSidebarToggle,{language:'zh',collapsed:railCollapsed,onToggle:()=>{railToggleCalls++;railCollapsed=!railCollapsed;showRail();}}),
        h('aside',{className:'sidebar'},h('div',{className:'sidebar-panel-content'},h('button',{className:'desktop-search'},'搜索'))))
    ]);
    showRail();
  `);
  const toggle = '.desktop-shell > .window-sidebar-toggle';
  await until("!!document.querySelector('.desktop-shell > .window-sidebar-toggle')", 'navigation toggle is ready immediately');
  assert.ok(await run("!document.querySelector('.window-frame .window-sidebar-toggle') && !document.querySelector('.window-brand').closest('button')"), 'the brand is static');
  assert.ok(await run("!!document.querySelector('[data-history-action=back]').closest('.window-frame')"), 'Back stays in the title bar');
  const rect = await run("document.querySelector('.window-sidebar-toggle').getBoundingClientRect().toJSON()");
  const point = {x:Math.round(rect.x+rect.width/2), y:Math.round(rect.y+rect.height/2)};
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await until("railCollapsed && document.querySelector('.sidebar').getBoundingClientRect().width === 48", 'mouse collapses to the icon rail');
  assert.equal(await run("document.activeElement.matches('.window-sidebar-toggle')"),true);
  assert.equal(await run("document.querySelector('.window-sidebar-toggle').getAttribute('aria-expanded')"),'false');
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  await until("!railCollapsed && !!document.querySelector('.window-brand')", 'Space expands the navigation');
  assert.equal(await run('railToggleCalls'),2);
  await run("railCollapsed=true;showRail()");
  await until("document.querySelector('.window-sidebar-toggle').getAttribute('aria-expanded') === 'false'", 'external changes update the accessible state');
  await run("document.querySelector('" + toggle + "').click();document.querySelector('" + toggle + "').click()");
  await until("railToggleCalls === 4 && railCollapsed", 'rapid reversal uses the current state');
  await run('renderView(null)');
};
