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
      ['retired-cyberpunk', 'cyberpunk', false, null, 'dark', 'rgb(26, 26, 26)', 'rgb(240, 237, 231)'],
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

    const wave = await boot.webContents.executeJavaScript(`(() => {
      const rhythm = document.querySelector('.cardbush-startup-rhythm'), bars = [...rhythm.children];
      const animations = bars.map(bar => bar.getAnimations()[0]);
      animations.forEach(animation => animation.pause());
      return [0, 120, 450, 960].map(time => {
        animations.forEach(animation => { animation.currentTime = time; });
        const bounds = rhythm.getBoundingClientRect();
        return bars.map((bar, index) => { const box = bar.getBoundingClientRect(); return {
          height: bar.offsetHeight, top: bounds.top, visibleHeight: box.height,
          inside: box.top >= bounds.top && box.bottom <= bounds.bottom,
          delay: animations[index].effect.getTiming().delay,
          layoutAnimation: animations[index].effect.getKeyframes().some(frame => 'height' in frame || 'width' in frame),
        }; });
      });
    })()`);
    for (const frame of wave) for (const bar of frame) {
      assert.equal(bar.height, 22, 'startup wave has fixed layout dimensions');
      assert.ok(bar.inside && bar.delay <= 0 && !bar.layoutAnimation);
    }
    assert.equal(new Set(wave.map(frame => frame[0].top)).size, 1);
    assert.ok(new Set(wave.map(frame => Math.round(frame[0].visibleHeight))).size > 1);
    boot.webContents.debugger.attach('1.3');
    await boot.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(50);
    assert.equal(await boot.webContents.executeJavaScript("document.querySelector('.cardbush-startup-rhythm').getAnimations({subtree:true}).length"), 0);
    boot.webContents.debugger.detach();

    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/appearance.css'), 'utf8'));
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
    for (const theme of ['theme-bright', 'theme-dark']) {
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
    console.log('Startup presentation passed: light/dark/system/custom and retired-theme migration palettes, first mount without collapse, theme layout stability and subsequent sidebar motion.');
  } finally {
    boot.destroy();
    assert.ok(directory.startsWith(path.join(root, 'tmp', 'startup-presentation-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
