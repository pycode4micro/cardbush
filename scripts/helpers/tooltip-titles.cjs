const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    (() => {
      const React=require(${JSON.stringify(require.resolve('react'))});
      const {createRoot}=require(${JSON.stringify(require.resolve('react-dom/client'))});
      window.titleFixture=document.createElement('div');
      titleFixture.style.cssText='position:fixed;right:30px;top:80px;z-index:9999';
      document.body.append(titleFixture);
      window.titleRoot=createRoot(titleFixture);
      function Fixture(){
        const [title,setTitle]=React.useState('Original help');
        const [disabled,setDisabled]=React.useState(false);
        window.setFixtureTitle=setTitle;window.setFixtureDisabled=setDisabled;
        return h('div',{title:'Parent help',style:{padding:'12px'}},
          h('button',{id:'title-control',title,disabled},h('span',null,'Action')),
          h('button',{id:'title-icon',title:'Icon action'},h('svg',{'aria-hidden':true})),
          h('form',{id:'title-address',title:'编辑网址','data-shortcut':'focusBrowserAddress'},
            h('input',{type:'url','aria-label':'网址',defaultValue:'https://example.test/search?q=hello'})),
          h('iframe',{id:'title-frame',title:'Document preview',style:{display:'none'}}));
      }
      titleRoot.render(h(React.StrictMode,null,h(Fixture)));
    })();
  `);
  await until("!!document.querySelector('#title-control[data-global-tooltip-title]')", 'new React controls are normalized before hovering');
  const point = await run("(() => {const r=document.querySelector('#title-control').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  const move = (offset=0) => window.webContents.sendInputEvent({type:'mouseMove',x:point.x+offset,y:point.y});
  const away = async () => { window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400}); await pause(40); };
  const help = text => `document.querySelector('.global-tooltip')?.textContent===${JSON.stringify(text)}`;
  const nativeTitles = "[...titleFixture.querySelectorAll('[title]:not(iframe)')].map(node=>node.title).filter(Boolean)";
  try {
    assert.deepEqual(await run(nativeTitles), [], 'parent and child native titles are both suppressed before interaction');
    assert.equal(await run("document.querySelector('#title-icon').getAttribute('aria-label')"), 'Icon action', 'title-only icon retains its accessible name');
    assert.equal(await run("document.querySelector('#title-control').getAttribute('aria-description')"), 'Original help');
    assert.equal(await run("document.querySelector('#title-frame').title"), 'Document preview', 'embedded document names are preserved');
    move(); await until(help('Original help'), 'normal hover uses the shared tooltip');
    await run("window.titleTip=document.querySelector('.global-tooltip');window.titleToggles=0;titleTip.addEventListener('beforetoggle',()=>titleToggles++);setFixtureTitle('Updated help')");
    await until(help('Updated help'), 'React title updates refresh help without another mouse move');
    assert.deepEqual(await run(nativeTitles), [], 'React cannot reintroduce native help');
    assert.equal(await run("document.querySelector('#title-control').getAttribute('aria-description')"), 'Updated help', 'accessible help follows updates while the popover is open');
    assert.equal(await run("titleTip===document.querySelector('.global-tooltip') && titleToggles===0"), true, 'live text updates do not remount or reopen the popover');
    await run('setFixtureTitle(undefined)');
    await until("!document.querySelector('.global-tooltip') && !document.querySelector('#title-control').hasAttribute('data-global-tooltip-title')", 'removing a React title removes stale help');
    assert.equal(await run("document.querySelector('#title-control').hasAttribute('aria-description')"), false, 'generated accessible help is also removed');
    await run("setFixtureTitle('Restored help')"); await pause(40); move(1);
    await until(help('Restored help'), 'title can be added again');
    for (const event of ['scroll','resize','blur']) {
      await run(`window.dispatchEvent(new Event('${event}'))`);
      await until("!document.querySelector('.global-tooltip')", `${event} dismisses custom help`);
      assert.deepEqual(await run(nativeTitles), [], `${event} cannot restore a native bubble under the stationary pointer`);
      if (event==='blur') await run("window.dispatchEvent(new Event('focus'))");
      await pause(430);
      assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'restored focus alone cannot summon help');
      await away(); move(); await until(help('Restored help'), 'explicit movement still restores help');
    }
    await run('setFixtureDisabled(true)'); await away(); move();
    await until(help('Restored help'), 'disabled controls also use custom help');
    await run("setFixtureDisabled(false);setFixtureTitle('Preparing help')"); await away(); move(); await pause(50);
    await run("setFixtureTitle('Ready help')");
    await until(help('Ready help'), 'delayed display reads the newest title');
    await run("document.querySelector('#title-control').click();setFixtureTitle('After action')"); await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'title changes cannot reopen clicked help');
    assert.deepEqual(await run(nativeTitles), [], 'clicked updates stay native-free too');
    await away(); move(); await until(help('After action'), 'new hover after click uses updated help');
    for (const theme of ['theme-bright','theme-dark']) {
      await run(`document.querySelector('.app').className='app ${theme}'`);
      await pause(150);
      assert.equal(await run("getComputedStyle(document.querySelector('.global-tooltip')).borderRadius"), '18px');
      const colors = await run("(() => {const tip=getComputedStyle(document.querySelector('.global-tooltip'));return {background:tip.backgroundColor,text:tip.color}})()");
      assert.notEqual(colors.background, colors.text);
      fs.writeFileSync(path.join(root,'tmp',`tooltip-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await run("setFixtureTitle('https://example.test/search?q='+'long-query-'.repeat(160))");
    await until("document.querySelector('.global-tooltip')?.textContent.startsWith('https://example.test/search')", 'long title refreshes');
    for (const theme of ['theme-bright','theme-dark']) {
      await run(`document.querySelector('.app').className='app ${theme}'`);
      const bounds = await run(`(() => {const tip=document.querySelector('.global-tooltip'),text=tip.querySelector('span'),r=tip.getBoundingClientRect();
        return {width:r.width,height:r.height,left:r.left,right:r.right,viewport:innerWidth,radius:parseFloat(getComputedStyle(tip).borderRadius),
          textHeight:text.clientHeight,fullTextHeight:text.scrollHeight};})()`);
      assert.ok(bounds.height <= 80 && bounds.width <= 360, 'long unbroken URLs cannot cover the page');
      assert.ok(bounds.left >= 8 && bounds.right <= bounds.viewport - 8, 'help stays within the window');
      assert.ok(bounds.fullTextHeight > bounds.textHeight, 'long help is visibly truncated');
      assert.ok(bounds.radius < bounds.height / 2, 'multiline help keeps rounded corners instead of becoming a circle');
      fs.writeFileSync(path.join(root,'tmp',`tooltip-long-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await away();
    const addressPoint = await run("(() => {const r=document.querySelector('#title-address input').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    window.webContents.sendInputEvent({type:'mouseMove',...addressPoint});
    await until("document.querySelector('.global-tooltip')?.textContent==='编辑网址Ctrl + L'", 'address help is a compact action and shortcut');
    await run("document.querySelector('#title-address input').focus()");
    await until("!document.querySelector('.global-tooltip')", 'programmatic address focus dismisses help immediately');
    window.webContents.sendInputEvent({type:'mouseMove',x:addressPoint.x+1,y:addressPoint.y});
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'});
    await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'pointer movement and caret navigation cannot reopen help while editing');
    await run("document.querySelector('#title-address input').blur();setFixtureTitle('After action')");
    await away(); move(); await until(help('After action'), 'ordinary help resumes after editing');
    await run("window.titleDialog=document.createElement('dialog');titleDialog.innerHTML='<button title=\"Dialog help\" aria-label=\"Dialog action\">Dialog action</button>';document.body.append(titleDialog);titleDialog.showModal()");
    const dialogPoint = await run("(() => {const r=titleDialog.querySelector('button').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
    window.webContents.sendInputEvent({type:'mouseMove',...dialogPoint});
    await until(help('Dialog help'), 'modal controls also use the shared tooltip');
    assert.equal(await run("titleDialog.querySelector('button').title==='' && document.querySelector('.global-tooltip').matches(':popover-open')"), true, 'modal help is native-free and visible in the top layer');
    await run('titleDialog.close();titleDialog.remove()');
    await away(); move(); await until(help('After action'), 'help works again after closing a modal');
    await run('titleRoot.unmount()');
    await until("!document.querySelector('.global-tooltip')", 'unmounting an active control removes its popover');
  } finally {
    await run("titleRoot.unmount();titleFixture.remove();window.titleDialog?.remove();document.querySelector('.app').className='app theme-bright'");
    await away();
  }
  console.log('Tooltip title ownership passed: dynamic React titles, deletion, native suppression, activation, disabled controls, modal top layer, accessibility and themes.');
};
