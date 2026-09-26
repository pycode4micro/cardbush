const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.tooltipClicks=0;
    window.tooltipFixture=document.createElement('div');
    tooltipFixture.style.cssText='position:fixed;right:30px;top:80px;z-index:9999;display:flex;gap:16px';
    tooltipFixture.innerHTML='<button id="tooltip-before">Before</button><button id="tooltip-action" title="Activation help" aria-describedby="tooltip-description"><span>Activate</span></button><button id="tooltip-after">After</button><span id="tooltip-description" hidden>Existing description</span>';
    document.body.append(tooltipFixture);
    document.querySelector('#tooltip-action').onclick=()=>tooltipClicks++;
    undefined;
  `);
  const button = await run("(() => {const r=document.querySelector('#tooltip-action').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  const mouse = (type, extra = {}) => window.webContents.sendInputEvent({type,...button,...extra});
  const key = (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    if (keyCode === 'Enter' || keyCode === 'Space') window.webContents.sendInputEvent({type:'char',keyCode:keyCode === 'Enter' ? '\r' : ' ',modifiers});
    window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  };
  const tooltipVisible = "document.querySelector('.global-tooltip')?.textContent==='Activation help'";
  try {
    mouse('mouseMove');
    await until(tooltipVisible, 'hover before activation shows help');
    mouse('mouseDown',{button:'left',clickCount:1});
    await until("!document.querySelector('.global-tooltip')", 'press immediately dismisses help');
    mouse('mouseMove',{x:button.x+1}); await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'holding the mouse does not reopen help');
    mouse('mouseUp',{button:'left',clickCount:1,x:button.x+1});
    await until('tooltipClicks===1', 'real mouse click activates the control');
    mouse('mouseMove',{x:button.x+2}); await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'movement within the clicked control does not reopen help');
    assert.equal(await run("document.querySelector('#tooltip-action').hasAttribute('title')"), false, 'native title cannot replace the dismissed tooltip');
    assert.equal(await run("document.querySelector('#tooltip-action').getAttribute('aria-describedby')"), 'tooltip-description', 'existing accessible description is retained');
    window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400});
    await until("document.querySelector('#tooltip-action').title==='Activation help'", 'leaving restores the native title');
    mouse('mouseMove');
    await until(tooltipVisible, 'leaving and reentering enables a new hover');
    await run("document.querySelector('#tooltip-action').click()");
    await until("!document.querySelector('.global-tooltip')", 'click without pointerdown also dismisses help');
    mouse('mouseMove',{x:button.x+1}); await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'click-only activation remains dismissed');
    window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400});
    await pause(40); mouse('mouseMove'); await pause(50);
    await run("document.querySelector('#tooltip-action').click()"); await pause(430);
    assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'activation cancels a tooltip that has not appeared yet');
    window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400});
    for (const keyCode of ['Enter', 'Space']) {
      await run("document.querySelector('#tooltip-before').focus()"); key('Tab');
      await until(tooltipVisible, 'keyboard navigation exposes help');
      const previous = await run('tooltipClicks');
      key(keyCode);
      await until(`tooltipClicks===${previous+1} && !document.querySelector('.global-tooltip')`, `${keyCode} activation dismisses help`);
      await pause(430);
      assert.equal(await run("!!document.querySelector('.global-tooltip')"), false, 'retained keyboard focus does not reopen activated help');
    }
    key('Tab'); key('Tab',['shift']);
    await until(tooltipVisible, 'new keyboard navigation restores help after activation');
  } finally {
    await run('tooltipFixture.remove()');
    window.webContents.sendInputEvent({type:'mouseMove',x:700,y:400});
  }
};
