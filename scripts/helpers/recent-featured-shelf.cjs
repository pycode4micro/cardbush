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
    document.querySelector('.recent-bar-list').click();
    const drawer=document.querySelector('.recent-turn-drawer');
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
    await wait(async () => {
      const g=await shelf(); return g.count===3 && g.rows===1 && Math.abs(g.left)<2 && Math.abs(g.right)<2 &&
        await read("!document.querySelector('.desktop-shell').getAnimations().length");
    },'three cards fill one row beside the list at 1180px');
    fs.writeFileSync(path.join(project,'tmp','featured-shelf-docked.png'),(await win.webContents.capturePage()).toPNG());
    const cover = '.desktop-covers > button:first-child';
    const hoveredCovers = () => read("Array.from(document.querySelectorAll('.desktop-covers > button'), card => Number(getComputedStyle(card, '::after').opacity))");
    win.webContents.sendInputEvent({ type:'mouseMove', ...await center(cover) });
    await wait(async () => {
      const [first, ...rest] = await hoveredCovers();
      return first === 1 && rest.every(opacity => opacity === 0);
    }, 'only the cover under the pointer is shaded');
    fs.writeFileSync(path.join(project,'tmp','featured-cover-hover.png'),(await win.webContents.capturePage()).toPNG());
    win.webContents.sendInputEvent({ type:'mouseMove', ...await center('.recent-bar-list') });
    await wait(async () => (await hoveredCovers()).every(opacity => opacity === 0), 'leaving restores the cover');
    await moveTo('.featured-step[data-step="next"]');
    await wait(async () => (await shelf()).last,'next reveals the fourth card');
    assert.ok(await read('!!document.querySelector('+JSON.stringify(open)+')'),'browsing keeps the docked list open');
    await moveTo('.featured-step[data-step="previous"]');
    await wait(() => read("document.querySelector('.desktop-covers').scrollLeft<1"),'previous returns to the first card');
    // Reopening a partially dismissed popover must not let the old exit clear the new list.
    await read(`(() => {
      document.querySelector('.recent-bar-list').click();
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
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:120,y:115});
    await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"),'clicking the narrow page dismisses its overlay');
    win.setContentSize(480,700);
    await wait(async () => (await shelf()).count===1,'a single card fits the smallest shelf');
  } finally { win.webContents.debugger.detach(); }
};
