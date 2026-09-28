const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, click, choose, edit, pause, window, root }) => {
  await click('外观与语言');
  await until("document.querySelectorAll('[name=theme-mode]').length === 3");
  assert.equal(await run("document.body.textContent.includes('赛博朋克')"), false);
  const select = async (name, value) => {
    const selector = '[name=' + name + '] + [role=combobox]';
    await run('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center", behavior:"instant"})');
    await pause(60);
    await choose(selector, value);
    await pause(40);
  };
  const mode = async value => {
    await run("document.querySelector('[name=theme-mode][value=" + value + "]').click()");
    await until("settingsProps.themePreference === " + JSON.stringify(value));
  };
  const color = async (name, value) => {
    const selector = '[name=appearance-' + name + ']';
    await run('document.querySelector(' + JSON.stringify(selector) + ').focus()');
    await edit(selector, value);
    await pause(30);
    await run('document.querySelector(' + JSON.stringify(selector) + ').dispatchEvent(new FocusEvent("focusout", {bubbles:true}))');
  };
  const toggle = title => run('Array.from(document.querySelectorAll(".settings-switch")).find(el => el.querySelector("strong").textContent === ' + JSON.stringify(title) + ').querySelector("input").click()');
  await mode('dark');
  await color('accent', '#B99A68');
  await until("getComputedStyle(document.querySelector('.app')).getPropertyValue('--accent') === '#B99A68'");
  await color('background', '#202124');
  await color('foreground', '#EEEEEE');
  await until("getComputedStyle(document.querySelector('.app')).color === 'rgb(238, 238, 238)'");
  await color('foreground', 'invalid');
  assert.equal(await run("settingsProps.settings.appearance.shared.foreground"), '#EEEEEE');
  await run("document.querySelector('.appearance-advanced').open = true");
  await toggle('分别设置浅色和深色模式');
  await mode('light');
  await color('background', '#FAFAFA');
  await color('foreground', '#222222');
  await select('appearance-font', 'serif');
  await mode('dark');
  await until("document.querySelector('[name=appearance-background]').value === '#202124'");
  assert.equal(await run("settingsProps.settings.appearance.dark.font"), 'system');
  await toggle('分别设置浅色和深色模式');
  await toggle('分别设置浅色和深色模式');
  await mode('light');
  await until("document.querySelector('[name=appearance-background]').value === '#FAFAFA'");
  assert.equal(await run("settingsProps.settings.appearance.light.font"), 'serif', 're-enabling independent modes retains each profile');
  await mode('dark');
  await select('content-font', 'serif');
  await select('code-font', 'courier');
  await select('interface-style', 'medium');
  await select('content-style', 'italic');
  await select('code-style', 'medium');
  await edit('[name=interface-size]', '18');
  await edit('[name=code-size]', '17');
  await until("settingsProps.settings.appearance.interfaceSize === 18");
  // These nodes use the real chat/source/diff selectors inside the live app.
  await run("(() => { const probe = document.createElement('div'); probe.id = 'appearance-probe'; probe.style.cssText = 'position:fixed;left:-2000px;width:500px'; probe.innerHTML = '<div class=\"markdown-content\"><p>中文正文 Sample</p><div class=\"markdown-code-block\"><pre><code>const sample = 1;</code></pre></div></div><div class=\"diff-lines\"><div class=\"diff-line addition\"><span class=\"diff-marker\"></span><span class=\"diff-line-number old\"></span><span class=\"diff-line-number new\">1</span><span class=\"diff-prefix\">+</span><code>const sample = 1;</code></div></div>'; document.querySelector('.app').append(probe); })()");
  const type = await run("(() => { const p = getComputedStyle(document.querySelector('#appearance-probe p')), c = getComputedStyle(document.querySelector('#appearance-probe pre code')), d = getComputedStyle(document.querySelector('#appearance-probe .diff-line code')); return { family:p.fontFamily, style:p.fontStyle, codeFamily:c.fontFamily, codeSize:c.fontSize, diffSize:d.fontSize, weight:c.fontWeight, label:getComputedStyle(document.querySelector('.appearance-row strong')).fontSize }; })()");
  assert.match(type.family, /serif/); assert.equal(type.style, 'italic');
  assert.match(type.codeFamily, /Courier New/); assert.equal(type.codeSize, '17px'); assert.equal(type.diffSize, '17px'); assert.equal(type.weight, '500');
  assert.ok(parseFloat(type.label) > 16, 'interface size scales typography');
  await select('diff-indicators', 'symbols');
  await until("getComputedStyle(document.querySelector('#appearance-probe .diff-line')).backgroundColor === 'rgba(0, 0, 0, 0)'");
  assert.equal(await run("getComputedStyle(document.querySelector('#appearance-probe .diff-prefix')).visibility"), 'visible');
  await select('diff-indicators', 'color');
  await until("getComputedStyle(document.querySelector('#appearance-probe .diff-prefix')).visibility === 'hidden'");
  await select('reduced-motion', 'on');
  await until("document.documentElement.dataset.reduceMotion === 'true'");
  await select('reduced-motion', 'off');
  await until("document.documentElement.dataset.reduceMotion === 'false'");
  await toggle('半透明侧边栏');
  await until("document.querySelector('.app').dataset.translucentSidebar === 'false'");
  await toggle('使用指针光标');
  assert.equal(await run("getComputedStyle(document.querySelector('[name=theme-mode]')).cursor"), 'default');
  const before = await run("getComputedStyle(document.querySelector('.app')).getPropertyValue('--text-soft')");
  await edit('[name=appearance-contrast]', '90');
  await until("settingsProps.settings.appearance.contrast === 90");
  assert.notEqual(await run("getComputedStyle(document.querySelector('.app')).getPropertyValue('--text-soft')"), before);
  const saved = await run("JSON.parse(localStorage.getItem('cardbush_appearance'))");
  await run("settingsProps.settings.appearance = views.readAppearance(); renderSettings()");
  await until("settingsProps.settings.appearance.codeSize === 17");
  assert.deepEqual(await run('settingsProps.settings.appearance'), saved);
  await click('恢复外观默认设置');
  await until("settingsProps.settings.appearance.interfaceSize === 14 && settingsProps.settings.appearance.shared.accent === ''");
  await run("document.querySelector('#appearance-probe').remove(); document.querySelector('.appearance-advanced').open = false; document.querySelector('.settings-content').scrollTop = 0");
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  for (const theme of ['dark', 'light']) {
    await mode(theme);
    await pause(200);
    window.webContents.invalidate(); await pause(100);
    fs.writeFileSync(path.join(root, 'tmp', 'appearance-settings-' + theme + '.png'), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  }
  await mode('dark');
  await run("document.querySelector('.appearance-advanced').open = true; document.querySelector('.appearance-advanced').scrollIntoView({block:'start'})");
  window.webContents.invalidate(); await pause(150);
  fs.writeFileSync(path.join(root, 'tmp', 'appearance-settings-advanced.png'), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  for (const width of [700, 480, 360]) {
    window.setSize(width, 850); await pause(140);
    const geometry = await run("(() => { const panel = document.querySelector('.settings-content'), rect = panel.getBoundingClientRect(); return {scroll:panel.scrollWidth, width:panel.clientWidth, controls:[...panel.querySelectorAll('input, [role=combobox]')].filter(el=>el.getClientRects().length).map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})),left:rect.left,right:rect.right}; })()");
    assert.ok(geometry.scroll <= geometry.width + 1, 'appearance has no horizontal scroll at ' + width + ': ' + JSON.stringify(geometry));
    assert.ok(geometry.controls.every(el => el.left >= geometry.left - 1 && el.right <= geometry.right + 1), 'controls fit at ' + width);
  }
  await run("settingsProps.language = 'en'; renderSettings()");
  await until("document.body.textContent.includes('Reduce motion')");
  assert.equal(await run("document.querySelector('.appearance-settings-stack').textContent.includes('高级')"), false);
};
