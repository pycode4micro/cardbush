const assert = require('node:assert/strict');
const { createServer } = require('node:http');

module.exports = async function verifyBoard({win, js, wait, click, reload, capture}) {
  const requests = [];
  const site = createServer((req, res) => {
    requests.push({url:req.url, cookie:req.headers.cookie, referer:req.headers.referer});
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<button onclick="this.textContent=7">6</button><a href="/next">Next</a>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + site.address().port;
  const done = '[data-home-action=done]', add = '[data-home-action=add]';
  const visible = selector => wait(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`);
  const edit = () => require('./open-home-editor.cjs')(js, visible, click);
  const web = '.home-block[data-kind=web]', html = '.home-block[data-kind=html]';
  const order = '[...document.querySelectorAll("[data-home-block]")].map(node=>node.dataset.homeBlock)';
  async function field(selector, value, tag = 'HTMLInputElement') {
    await js(`(() => {const node=document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(${tag}.prototype,'value').set.call(node,${JSON.stringify(value)});
      node.dispatchEvent(new Event('${tag === 'HTMLSelectElement' ? 'change' : 'input'}',{bubbles:true}))})()`);
  }
  const mouse = (type, x, y) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y, button:'left', buttons:type === 'mouseReleased' ? 0 : 1, clickCount:1,
  });
  async function resize(edge, dx, dy, cancel = false) {
    const selector = web + ' [data-home-resize=' + edge + ']';
    const {x,y,step} = await js(`(async()=>{const handle=document.querySelector('${selector}');
      handle.scrollIntoView({block:'center',behavior:'instant'}); await new Promise(requestAnimationFrame);
      const r=handle.getBoundingClientRect();
      if (document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)!==handle) throw Error('Resize grip obscured: '+document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200));
      const board=handle.closest('.home-board'); return {x:r.x+r.width/2,y:r.y+r.height/2,
        step:(board.clientWidth+parseFloat(getComputedStyle(board).columnGap))/12};})()`);
    await mouse('mousePressed',x,y);
    await mouse('mouseMoved',x+dx*step,y+dy);
    await wait(`!!document.querySelector('${web}').style.getPropertyValue('--resize-height')`);
    if (cancel) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    }
    await mouse('mouseReleased',x+dx*step,y+dy);
    await wait(`!document.querySelector('${web}').style.getPropertyValue('--resize-height')`);
  }
  try {
    win.webContents.debugger.attach();
    await win.webContents.session.cookies.set({url:origin, name:'home_fixture', value:'private', sameSite:'lax'});
    assert.equal(await js("!!document.querySelector('.desktop-library [data-home-action]')"),false,'home opens without editing controls');
    await edit();
    await click('[data-history-action=back]'); await visible('.components-app [data-home-action=edit]');
    await click('[data-nav-section=home]'); await visible('.home-board[data-editing=false]');
    await edit(); await click(add); await click('[data-home-add=web]');
    await field('dialog [name=address]', 'file:///fixture');
    await click('dialog[open] [type=submit]');
    await wait('!!document.querySelector("dialog [aria-invalid=true]")');
    await field('dialog [name=address]', origin); await field('dialog [name=title]', 'Board website');
    await click('dialog[open] [type=submit]'); await wait('!!document.querySelector('+JSON.stringify(web)+')');
    await field(web+' select', '8', 'HTMLSelectElement');
    await field(web+' label:nth-of-type(2) select', '480', 'HTMLSelectElement');
    await field(web+' [name=column]', '3', 'HTMLSelectElement');
    await resize('corner',-1,-40,true);
    assert.equal(await js(`document.querySelector('${web} select').value`),'8','Escape cancels the width preview');
    await resize('corner',-2,-36);
    assert.deepEqual(await js(`[...document.querySelectorAll('${web} select')].map(el=>el.value)`),['6','444','3']);
    const before = await js(order);
    await click(web+' [data-home-action=earlier]');
    const key = before.at(-1);
    assert.equal((await js(order)).at(-2), key);
    await js(`(() => { const body=document.querySelector('${web} .home-block-body');body.scrollIntoView({block:'center'});
      const box=body.getBoundingClientRect();const source=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
      if (!source?.draggable) throw Error('Card body does not accept drag');
      const target=document.querySelector('[data-home-block="native:featured"]');
      const dataTransfer=new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); })()`);
    assert.equal((await js(order))[0], key, 'drag and keyboard-accessible buttons reorder the same layout');
    await click(add); await click('[data-home-native=recent]');
    await click('[data-home-add=html]');
    await field('.component-import input:not([type=file])','Board counter');
    await field('.component-import textarea',`<button onclick="this.textContent=42">41</button><a href="${origin}/widget-link" target="_blank"><span>Schedule</span></a>`, 'HTMLTextAreaElement');
    await click('.component-import [type=submit]');
    await wait('!!document.querySelector("[data-kind=html]") && !document.querySelector("dialog[open]")');
    assert.equal(requests.length, 0, 'layout editing keeps remote pages unloaded');
    await capture('home-layout-edit');
    const saved = await js(order);
    await click(done);
    await js(`document.querySelector('${web}').scrollIntoView()`);
    const standalone = () => require('electron').webContents.getAllWebContents().find(w=>w.getType()==='webview' && w.getURL()===origin+'/');
    const poll = async (condition, label) => {
      for (let i=0;i<120;i++) {if (await condition()) return; await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error(label);
    };
    await poll(()=>standalone()?.executeJavaScript('window.top===self && !!document.querySelector("button")'),'saved website opens directly in the card');
    assert.equal(await js(`!!document.querySelector('${web} iframe')`),false);
    const website=standalone();
    assert.equal(await website.executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'7');
    assert.deepEqual(await website.executeJavaScript('[typeof cardbushDesktop,typeof require]'),['undefined','undefined']);
    assert.equal(await js(`!!document.querySelector('${web} .component-embed-bar')`),false);
    await website.executeJavaScript('document.querySelector("a").click()');
    await poll(() => website.getURL().endsWith('/next'), 'same-site links work in the website card');
    assert.equal(requests[0].referer, undefined);
    assert.ok(requests.every(request => !request.cookie));
    await js(`document.querySelector('${html}').scrollIntoView()`);
    await wait('!!document.querySelector("[data-kind=html] iframe")');
    const custom = () => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    await poll(() => custom()?.executeJavaScript('!!document.querySelector("button")'), 'custom HTML visible');
    assert.equal(await custom().executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'42');
    const widget = custom();
    await widget.executeJavaScript('document.querySelector("a").click()');
    assert.equal(await js("!!document.querySelector('#right-inspector')?.checkVisibility()"),false,'widget scripts cannot open tabs on their own');
    const link = await widget.executeJavaScript('(()=>{const r=document.querySelector("a span").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    const frame = await js(`(()=>{const el=document.querySelector('${html} iframe');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x,y:r.y};})()`);
    win.focus();
    await mouse('mousePressed',frame.x+link.x,frame.y+link.y); await mouse('mouseReleased',frame.x+link.x,frame.y+link.y);
    await wait("document.querySelector('#right-inspector')?.checkVisibility()");
    await poll(()=>requests.some(req=>req.url === '/widget-link'),'user link opens the target URL in the built-in browser');
    assert.equal(widget.url,'about:srcdoc','the component remains on Home');
    await reload(); await wait('!!document.querySelector("[data-kind=html]")');
    assert.deepEqual(await js(order),saved,'all placements and hidden sections survive a restart');
    assert.deepEqual(await js(`(()=>{const s=document.querySelector('${web}').style;return [s.getPropertyValue('--block-span'),s.getPropertyValue('--block-height'),s.getPropertyValue('--block-column')]})()`),['6','444px','3']);
    win.setMinimumSize(420,400); win.setSize(520,640);
    await wait('innerWidth < 550');
    await wait(`Math.abs(document.querySelector('${web}').getBoundingClientRect().width - document.querySelector('.home-board').getBoundingClientRect().width) < 2`);
    await edit();
    await resize('corner',1,-20);
    assert.deepEqual(await js(`[...document.querySelectorAll('${web} select')].map(el=>el.value)`),['6','424','3'],'single-column height changes preserve wide screen span');
    await click(web+' [data-home-action=remove]'); await click(add); await click('[data-home-native=recent]');
    assert.ok((await js(order)).includes('native:recent'));
    await click(done);
    await visible('.home-board[data-editing=false]');
    assert.equal(await js("!!document.querySelector('.desktop-library [data-home-action]')"),false);
    console.log('Editable Home passed: native visibility, drag/button ordering, sizes, real web navigation, HTML interaction, sandbox and reload.');
  } finally {
    win.webContents.debugger.detach();
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
  }
};
