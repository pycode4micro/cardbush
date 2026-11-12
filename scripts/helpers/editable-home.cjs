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
  try {
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
    const before = await js(order);
    await click(web+' [data-home-action=earlier]');
    const key = before.at(-1);
    assert.equal((await js(order)).at(-2), key);
    await js(`(() => { const source=document.querySelector('${web} .home-drag'),target=document.querySelector('[data-home-block="native:featured"]');
      const dataTransfer=new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));
      target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); })()`);
    assert.equal((await js(order))[0], key, 'drag and keyboard-accessible buttons reorder the same layout');
    await click(add); await click('[data-home-native=recent]');
    await click('[data-home-add=html]');
    await field('.component-import input:not([type=file])','Board counter');
    await field('.component-import textarea','<button onclick="this.textContent=42">41</button>', 'HTMLTextAreaElement');
    await click('.component-import [type=submit]');
    await wait('!!document.querySelector("[data-kind=html]") && !document.querySelector("dialog[open]")');
    assert.equal(requests.length, 0, 'layout editing keeps remote pages unloaded');
    await capture('home-layout-edit');
    const saved = await js(order);
    await click(done);
    await js(`document.querySelector('${web}').scrollIntoView()`);
    const guest = () => win.webContents.mainFrame.frames.find(frame => frame.url.startsWith(origin));
    const poll = async (condition, label) => {
      for (let i=0;i<120;i++) {if (await condition()) return; await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error(label);
    };
    await poll(() => guest()?.executeJavaScript('!!document.querySelector("a")'), 'website loaded');
    assert.equal(await guest().executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'7');
    assert.deepEqual(await guest().executeJavaScript('[typeof cardbushDesktop,typeof require]'),['undefined','undefined']);
    assert.ok(await js(`document.querySelector('${web} iframe').credentialless`));
    await guest().executeJavaScript('document.querySelector("a").click()');
    await poll(() => guest()?.url.endsWith('/next'), 'same-site links work in the website card');
    assert.equal(requests[0].referer, undefined);
    assert.ok(requests.every(request => !request.cookie));
    await js(`document.querySelector('${html}').scrollIntoView()`);
    await wait('!!document.querySelector("[data-kind=html] iframe")');
    const custom = () => win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc');
    await poll(() => custom()?.executeJavaScript('!!document.querySelector("button")'), 'custom HTML visible');
    assert.equal(await custom().executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'42');
    await reload(); await wait('!!document.querySelector("[data-kind=html]")');
    assert.deepEqual(await js(order),saved,'all placements and hidden sections survive a restart');
    assert.deepEqual(await js(`(()=>{const s=document.querySelector('${web}').style;return [s.getPropertyValue('--block-span'),s.getPropertyValue('--block-height'),s.getPropertyValue('--block-column')]})()`),['8','480px','3']);
    win.setMinimumSize(420,400); win.setSize(520,640);
    await wait('innerWidth < 550');
    await wait(`Math.abs(document.querySelector('${web}').getBoundingClientRect().width - document.querySelector('.home-board').getBoundingClientRect().width) < 2`);
    await edit(); await click(web+' [data-home-action=remove]'); await click(add); await click('[data-home-native=recent]');
    assert.ok((await js(order)).includes('native:recent'));
    await click(done);
    await visible('.home-board[data-editing=false]');
    assert.equal(await js("!!document.querySelector('.desktop-library [data-home-action]')"),false);
    console.log('Editable Home passed: native visibility, drag/button ordering, sizes, real web navigation, HTML interaction, sandbox and reload.');
  } finally {
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
  }
};
