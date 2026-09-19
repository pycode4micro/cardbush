const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const failures = [];
  const directory = fs.mkdtempSync(path.join(root, 'tmp', 'startup-presentation-'));
  const boot = new BrowserWindow({ show: false, width: 1180, height: 760,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'startup-presentation-fixture' } });
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*type="module"[^>]*>[\s\S]*?<\/script>/g, '')
    .replace('src="./cardbush-logo.png"', `src="${pathToFileURL(path.join(root, 'public/cardbush-logo.png')).href}"`);
  const style = { protocol: 'cardbush.appearance_style.v1', name: 'Startup fixture', base: 'light',
    colors: { background: '#e4eef7', text: '#142942', accent: '#405cad' } };
  try {
    for (const [name, preference, systemDark, custom, expectedTheme, background, color] of [
      ['bright', 'light', false, null, 'bright', 'rgb(245, 243, 239)', 'rgb(30, 28, 26)'],
      ['dark', 'dark', false, null, 'dark', 'rgb(26, 26, 26)', 'rgb(240, 237, 231)'],
      ['system-light', 'system', false, null, 'bright', 'rgb(245, 243, 239)', 'rgb(30, 28, 26)'],
      ['system-dark', 'system', true, null, 'dark', 'rgb(26, 26, 26)', 'rgb(240, 237, 231)'],
      ['cyberpunk', 'cyberpunk', false, null, 'cyberpunk', 'rgb(5, 6, 7)', 'rgb(244, 243, 220)'],
      ['custom', 'custom', false, style, 'bright', 'rgb(228, 238, 247)', 'rgb(20, 41, 66)'],
    ]) {
      const seed = `<script>localStorage.clear();localStorage.setItem('cardbush_theme_mode',${JSON.stringify(preference)});localStorage.setItem('cardbush_imported_theme_style',${JSON.stringify(JSON.stringify(custom))});const nativeMatchMedia=window.matchMedia;window.matchMedia=query=>query==='(prefers-color-scheme: dark)'?{matches:${systemDark}}:nativeMatchMedia(query);</script>`;
      const file = path.join(directory, 'index.html');
      fs.writeFileSync(file, html.replace('<script>', `${seed}<script>`));
      await boot.loadFile(file);
      const state = await boot.webContents.executeJavaScript(`(() => {const splash=document.querySelector('#cardbush-startup-splash'),s=getComputedStyle(splash);return {theme:document.documentElement.dataset.startTheme,background:s.backgroundColor,color:s.color,scheme:getComputedStyle(document.documentElement).colorScheme};})()`);
      if (state.theme !== expectedTheme || state.background !== background || state.color !== color || state.scheme !== (expectedTheme === 'bright' ? 'light' : 'dark')) failures.push({ name, state });
      fs.writeFileSync(path.join(root, 'tmp', `startup-${name}.png`), (await boot.webContents.capturePage()).toPNG());
    }

    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/themes/cyberpunk.css'), 'utf8'));
    await run(`
      window.startupPresence=[];
      const {useState,useLayoutEffect}=require(${JSON.stringify(require.resolve('react'))});
      window.StartupSurface=function StartupSurface(){
        const [open,setOpen]=useState(true);window.setStartupSidebar=setOpen;
        const presence=views.useSoftPanelPresence(open);
        useLayoutEffect(()=>{const rect=document.querySelector('.main-stage').getBoundingClientRect();startupPresence.push({...presence,left:rect.left});});
        return h('main',{className:'desktop-shell'},
          presence.mounted&&h('aside',{className:'sidebar '+(presence.visible?'soft-panel-visible':'soft-panel-hidden')},h('div',{className:'sidebar-content'},'CardBush')),
          h('section',{className:'main-stage'},h('header',{className:'topbar'},'启动布局'),h('div',{className:'chat-body'},'正文与输入区域')));
      };
      window.showStartupSurface=()=>renderView(h(StartupSurface));
      showStartupSurface();
    `);
    await until('startupPresence.length>0', 'first sidebar commit');
    await pause(350);
    const commits = await run('startupPresence');
    if (commits.some(commit => !commit.mounted || !commit.visible)) failures.push({ name: 'sidebar-first-mount', commits });
    const first = await run("document.querySelector('.main-stage').getBoundingClientRect().left");
    for (const theme of ['theme-bright', 'theme-dark', 'theme-dark theme-cyberpunk']) {
      await run(`window.viewTheme=${JSON.stringify(theme)};showStartupSurface()`);
      await pause(50);
      assert.equal(await run("document.querySelector('.main-stage').getBoundingClientRect().left"), first, 'theme changes do not move the sidebar or reading surface');
    }
    await run('setStartupSidebar(false)');
    await until("!document.querySelector('.sidebar')", 'sidebar can still close');
    await run('setStartupSidebar(true)');
    await until("document.querySelector('.sidebar')?.classList.contains('soft-panel-visible')", 'sidebar can still reopen');
    await pause(260);
    assert.equal(await run("document.querySelector('.main-stage').getBoundingClientRect().left"), first, 'reopened sidebar preserves its width');
    assert.deepEqual(failures, [], 'startup must preserve saved theme colors and the initially expanded sidebar');
    console.log('Startup presentation passed: light/dark/system/cyberpunk/custom palettes, first mount without collapse, theme layout stability and subsequent sidebar motion.');
  } finally {
    boot.destroy();
    assert.ok(directory.startsWith(path.join(root, 'tmp', 'startup-presentation-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
