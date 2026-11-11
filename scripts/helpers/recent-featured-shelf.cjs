const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({win, read, wait, visible, project}) => {
  const open = '.recent-turn-drawer:popover-open';
  const shelf = () => read(`(() => {
    const track=document.querySelector('.desktop-covers'), bounds=track.getBoundingClientRect();
    const cards=Array.from(track.children, node=>node.getBoundingClientRect());
    const shown=cards.filter(r=>r.left>=bounds.left-1 && r.right<=bounds.right+1);
    return {count:shown.length, rows:new Set(cards.map(r=>r.top)).size, left:shown[0]?.left-bounds.left,
      right:bounds.right-shown.at(-1)?.right, last:shown.includes(cards.at(-1))};
  })()`);
  const center = selector => read(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  const moveTo = async selector => {
    const point = await center(selector);
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});
  };
  const motion = () => read(`(() => {
    const drawer=document.querySelector('.recent-turn-drawer');
    if (drawer.matches(':popover-open')) document.querySelector('.recent-panel-close').click();
    else document.querySelector('.recent-bar-list').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    const slide=drawer.getAnimations().find(a=>a.transitionProperty==='translate');
    return {sliding:!!slide, contents:!!drawer.querySelector('.recent-session-rows')};
  })()`);
  win.webContents.debugger.attach('1.3');
  const preference = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features:[{name:'prefers-reduced-motion',value}],
  });
  try {
    await wait(async () => (await shelf()).count===4,'four cards fill the closed shelf');
    await preference('no-preference');
    assert.ok((await motion()).sliding,'opening the drawer starts a slide');
    await visible('.recent-session-rows');
    await wait(async () => {const g=await shelf();return g.count===4 && g.rows===1 && Math.abs(g.left)<2 && Math.abs(g.right)<2;},
      'the floating list leaves all four featured cards in place');
    const cover = '.desktop-covers > button:last-child';
    const hoveredCovers = () => read("Array.from(document.querySelectorAll('.desktop-covers > button'), card => Number(getComputedStyle(card, '::after').opacity))");
    win.webContents.sendInputEvent({type:'mouseMove', ...await center(cover)});
    await wait(async () => {const states=await hoveredCovers(); return states.at(-1)===1 && states.slice(0,-1).every(v=>v===0);},
      'only the cover under the pointer is shaded');
    await moveTo('.desktop-library h1');
    await wait(()=>read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'a page click dismisses the flyout');
    await motion(); await visible('.recent-session-rows');
    await wait(() => read("!document.querySelector('.recent-turn-drawer').getAnimations().length"),'reopened list has settled');
    // Reopening a partially dismissed popover must not let the old exit clear the new list.
    await read(`(() => {
      document.querySelector('.recent-panel-close').click();
      const slide=document.querySelector('.recent-turn-drawer').getAnimations().find(a=>a.transitionProperty==='translate');
      if (!slide) return;
      slide.pause(); slide.currentTime=slide.effect.getTiming().duration/2;
    })()`);
    await wait(() => read("document.querySelector('.recent-bar-list').getAttribute('aria-expanded')==='false'"),'closing is announced');
    assert.ok(await read("!!document.querySelector('.recent-session-rows')"),'the list remains mounted during exit');
    await motion();
    await wait(() => read("document.querySelector('.recent-bar-list').getAttribute('aria-expanded')==='true' && !document.querySelector('.recent-turn-drawer').getAnimations().length"),'rapid reopen completes');
    await visible('.recent-session-rows');
    const closing=await motion();
    assert.ok(closing.sliding && closing.contents,'closing slides the visible list out');
    await wait(async () => (await shelf()).count===4 && await read("!document.querySelector('.recent-session-rows')"),'closed list releases content and restores four cards');
    await preference('reduce');
    assert.equal((await motion()).sliding,false,'reduced motion opens immediately');
    await visible('.recent-session-rows');
    assert.equal((await motion()).sliding,false,'reduced motion closes immediately');
    await wait(() => read("!document.querySelector('.recent-session-rows')"),'instant dismissal releases the contents');
    await motion();
    win.setContentSize(590, 700);
    await wait(async () => (await shelf()).count===2 &&
      await read("document.querySelector('.recent-turn-drawer:popover-open')?.popover==='auto'"),'narrow overlay keeps the shelf at two cards');
    await read("document.querySelector('.featured-step[data-step=next]').click()");
    await wait(async ()=>(await shelf()).last,'next reveals the last card on a narrow shelf');
    await wait(() => read("document.querySelector('.featured-step[data-step=next]').disabled && !document.querySelector('.featured-step[data-step=previous]').disabled"), 'the last page has settled');
    await read("document.querySelector('.featured-step[data-step=previous]').click()");
    await wait(()=>read("document.querySelector('.desktop-covers').scrollLeft<1"),'previous returns to the first card');
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:570,y:115});
    await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"),'clicking the narrow page dismisses its overlay');
    win.setContentSize(480,700);
    await wait(async () => (await shelf()).count===1,'a single card fits the smallest shelf');
  } finally { win.webContents.debugger.detach(); }
};
