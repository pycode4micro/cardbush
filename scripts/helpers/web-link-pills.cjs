const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = async ({ win, read, until, pause }) => {
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
  for (const documentMode of [false, true]) for (const theme of ['dark', 'bright']) {
    win.setSize(390, 700);
    await read(`window.showWebLinks('${theme}',${documentMode})`);
    await until(`document.querySelectorAll('a.web-link').length===5`);
    assert.deepEqual(await read(`Array.from(document.querySelectorAll('.web-link-title'),x=>x.textContent).slice(0,3)`),
      ['开发者文档','example.org','网站页面标题']);
    assert.equal(await read(`document.querySelector('a[href^="mailto:"]').classList.contains('web-link')`), false);
    assert.equal(await read(`document.querySelector('a[href="#heading"]').classList.contains('web-link')`), false);
    assert.equal(await read(`document.querySelector('a[href="https://example.org/image"]').classList.contains('web-link')`), false, 'linked images keep their media renderer');
    assert.ok(await read(`document.querySelector('a[href="https://example.org/image"] img') !== null`));
    const state = await read(`Array.from(document.querySelectorAll('a.web-link'),a=>{
      const r=a.getBoundingClientRect(),s=getComputedStyle(a),icon=a.querySelector('.browser-site-icon').getBoundingClientRect();
      return {left:r.left,right:r.right,view:innerWidth,radius:s.borderRadius,decoration:s.textDecorationLine,
        iconWidth:icon.width,iconHeight:icon.height,label:a.getAttribute('aria-label'),address:a.getAttribute('aria-description'),title:a.title};
    })`);
    for (const item of state) {
      assert.ok(item.left>=0 && item.right<=item.view, `pill fits narrow ${theme} viewport: ${JSON.stringify(item)}`);
      assert.equal(item.decoration,'none');
      assert.equal(item.radius,'999px');
      assert.equal(item.iconWidth,16);
      assert.equal(item.iconHeight,16);
      assert.ok(item.title.includes(item.address) && item.label, 'the complete address and name remain accessible');
    }
    assert.ok(await read(`(()=>{const s=document.querySelector('a[href="https://example.org/long"] .web-link-title');return s.scrollWidth>s.clientWidth&&getComputedStyle(s).textOverflow==='ellipsis'})()`), 'long titles truncate inside the capsule');
    await until(`!!document.querySelector('.web-link .browser-site-icon img')?.complete`);
    win.webContents.focus();
    await read(`document.querySelector('.web-link').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await until(`document.activeElement.getAttribute('href')==='https://example.org/path?q=one#section'`);
    assert.equal(await read(`getComputedStyle(document.activeElement).outlineStyle`),'solid', 'keyboard focus is visible: '+await read(`JSON.stringify({focused:document.hasFocus(),visible:document.activeElement.matches(':focus-visible'),accent:getComputedStyle(document.activeElement).getPropertyValue('--accent')})`));
    await read('window.opens.length=0');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await until(`window.opens.at(-1)==='https://example.org/path?q=one#section'`);
    const bounds=await read(`(()=>{const r=document.querySelector('.web-link').getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+10)}})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...bounds}); await pause();
    assert.equal(await read(`getComputedStyle(document.querySelector('.web-link')).textDecorationLine`),'none','hover does not restore underlining');
    // A failed icon must keep an accessible, clickable link with stable geometry.
    await read(`document.querySelector('.web-link .browser-site-icon img').dispatchEvent(new Event('error'))`);
    await until(`!!document.querySelector('.web-link .browser-site-icon svg')`);
    assert.equal(await read(`document.querySelector('.web-link').textContent`),'开发者文档');
    writeFileSync(resolve('tmp/web-links-'+theme+(documentMode?'-document':'-chat')+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    win.webContents.debugger.detach();
  }
};
