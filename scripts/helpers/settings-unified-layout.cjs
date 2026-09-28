const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual settings pages at both sides of their responsive breakpoints.
module.exports = async ({ run, until, pause, window: win, root }) => {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  await run(`
    const sandboxCommand = cardbushDesktop.productHostCommand;
    const apps = { revision:1, serviceEnabled:true, plugins:['chrome','computer-use','fixture'].map(id => ({
      id, name:id, description:'Capability configuration', source:'bundled', installed:true, enabled:true,
      version:'1.0.0', config:{}, capabilities:[], components:[]
    })) };
    cardbushDesktop.productHostCommand = async command => command.kind === 'apps.get'
      ? {protocol:'cardbush.product_host_ipc.v1',ok:true,value:apps} : command.kind === 'mcp.get'
      ? {protocol:'cardbush.product_host_ipc.v1',ok:true,value:{revision:1,servers:[]}} : sandboxCommand(command);
    cardbushDesktop.readBrowserConfiguration = async () => ({ revision:1, startPage:'https://www.google.com/' });
    cardbushDesktop.sshConnections = { list:async () => [{id:'fixture',name:'Development server',host:'fixture.invalid',username:'developer',port:22,defaultDirectory:'/workspace',authentication:'agent',status:'connected'}] };
    settingsProps.projects=[];
    settingsProps.settings.proxy={mode:'none',httpProxy:'',httpsProxy:'',noProxy:''};
    renderSettings();
  `);
  const pages = ['appearance', 'profile', 'browser', 'computer-use', 'models', 'shortcuts', 'usage', 'ssh', 'runtime', 'proxy', 'cache', 'diagnostics', 'mcp'];
  const inspect = `(() => {
    const content = document.querySelector('.settings-content');
    const visible = node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const cards = [...content.querySelectorAll('.settings-card,.settings-surface,.plugin-installed-section,.plugin-featured-section')].filter(visible);
    return {
      overflow:content.scrollWidth > content.clientWidth + 1,
      cards:cards.map(node=>({ radius:getComputedStyle(node).borderRadius, background:getComputedStyle(node).backgroundColor })),
      overflowControls:[...content.querySelectorAll('input,textarea,select,button')].filter(visible).filter(node=>{
        const card=node.closest('.settings-card,.settings-surface,.plugin-installed-section,.plugin-featured-section');
        if(!card) return false;
        const a=node.getBoundingClientRect(), b=card.getBoundingClientRect();
        return a.left < b.left-1 || a.right > b.right+1;
      }).map(node=>node.getAttribute('aria-label') || node.textContent.trim() || node.className),
      overlappingRows:[...content.querySelectorAll('.settings-select-row,.settings-switch,.settings-radio,.keyboard-settings-row')].filter(visible).filter(row=>{
        const [a,b]=[...row.children].filter(visible).map(node=>node.getBoundingClientRect());
        return a && b && Math.min(a.right,b.right)>Math.max(a.left,b.left)+1 && Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)+1;
      }).map(row=>row.textContent.slice(0,60))
    };
  })()`;
  for (const [width, theme, language] of [[1200, 'dark', 'zh'], [760, 'bright', 'en'], [480, 'dark', 'en']]) {
    win.setContentSize(width, 850);
    await run(`settingsTheme=${JSON.stringify(theme)};settingsProps.language=${JSON.stringify(language)};renderSettings()`);
    let reference;
    for (const page of pages) {
      if (!await run("!!document.querySelector('.settings-nav')")) {
        await run("document.querySelector('.window-sidebar-toggle').click()");
        await until("!!document.querySelector('.settings-nav')");
      }
      await run(`document.querySelector('[data-settings-section="${page}"]').click()`);
      await until(`document.querySelector('[data-settings-section="${page}"]').getAttribute('aria-current') === 'page'`);
      if (width < 900) {
        await run("document.querySelector('.window-sidebar-toggle').click()");
        await until("!document.querySelector('.settings-sidebar')");
      }
      await pause(100);
      await run("document.querySelector('.settings-content').scrollTop=0");
      const state = await run(inspect);
      assert.equal(state.overflow, false, `${page} at ${width}px: no horizontal page overflow`);
      assert.deepEqual(state.overflowControls, [], `${page} at ${width}px: controls stay inside their cards`);
      assert.deepEqual(state.overlappingRows, [], `${page} at ${width}px: labels and controls do not overlap`);
      assert.ok(state.cards.length, `${page}: settings use grouped cards`);
      if (page === 'appearance') reference = state.cards[0];
      for (const card of state.cards) assert.deepEqual(card, reference, `${page}: card surface matches Appearance & language`);
      if (['profile', 'browser', 'models', 'shortcuts', 'ssh', 'mcp', 'usage', 'runtime', 'diagnostics'].includes(page)) {
        fs.writeFileSync(path.join(root, `tmp/settings-unified-${page}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
      if (page === 'proxy') {
        await run("document.getElementById('proxy-tab-plugins').click()"); await pause(100);
        const proxy = await run(inspect);
        assert.equal(proxy.overflow, false, 'plugin proxies fit the settings column');
        assert.deepEqual(proxy.overflowControls, [], 'plugin proxy controls fit their cards');
        fs.writeFileSync(path.join(root, `tmp/settings-unified-proxy-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('Unified settings layout passed: 13 pages, shared card surfaces, dark/light themes, Chinese/English and narrow controls without overlap or overflow.');
};
