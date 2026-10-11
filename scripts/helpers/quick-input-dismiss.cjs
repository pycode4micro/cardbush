const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, guest, guestId }) => {
  const click = async selector => {
    const point = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause();
  };
  const reopen = async () => {
    await click('.inspector-cover-input-toggle');
    await until('!!document.querySelector(".inspector-quick-input textarea")', 'quick input reopens');
    await until('document.activeElement===document.querySelector(".inspector-quick-input textarea")', 'reopening focuses the draft');
  };
  await run('coverUpdate({draft:"outside click draft"});void 0');
  await click('.inspector-quick-input textarea');
  assert.equal(await run('coverWorkspace.quickInputOpen'), true, 'clicking the draft keeps quick input open');
  await click('.quick-input-status');
  assert.equal(await run('coverWorkspace.quickInputOpen'), true, 'preview expansion stays inside quick input');
  await click('.quick-input-status');
  const draft = await run('document.querySelector(".inspector-quick-input textarea").value');
  const openPreview = async () => {
    await click('.inspector-quick-input textarea');
    await run('coverPreview(true);void 0');
    await until('!!document.querySelector(".image-preview-dialog")', 'image preview opens above the floating conversation');
  };
  const verifyPreviewClosed = async () => {
    await until('!document.querySelector(".image-preview-dialog")', 'only the image preview closes');
    await pause();
    assert.equal(await run('coverWorkspace.quickInputOpen'), true, 'closing a portal preview keeps the floating conversation open');
    assert.equal(await run('document.querySelector(".inspector-quick-input textarea").value'), draft, 'image modal preserves the draft');
    assert.equal(await run('coverWorkspace.inspectorCover'), true);
    assert.equal(await run('document.querySelector("webview").getWebContentsId()'), guestId);
  };
  await openPreview();
  await click('.image-preview-close');
  await verifyPreviewClosed();
  await openPreview();
  // A native guest can emit a late focus event while a portal modal is open.
  await run('document.querySelector("webview").dispatchEvent(new FocusEvent("focusin",{bubbles:true}));void 0');
  const backdropPoint = await run('(()=>{const r=document.querySelector(".image-preview-backdrop").getBoundingClientRect();return {x:Math.round(r.x+4),y:Math.round(r.y+4)}})()');
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...backdropPoint });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...backdropPoint });
  await verifyPreviewClosed();
  await openPreview();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await verifyPreviewClosed();
  await click('.right-inspector-toolbar');
  await until('!coverWorkspace.quickInputOpen && !document.querySelector(".inspector-quick-input")', 'outside host click dismisses quick input');
  assert.equal(await run('coverWorkspace.inspectorCover'), true, 'dismissal leaves the browser in cover mode');
  assert.equal(await run('document.querySelector(".main-stage textarea").value'), 'outside click draft', 'outside click preserves the draft');
  assert.equal(await run('coverStops'), 0, 'outside click does not stop the running turn');
  await reopen();
  await click('.inspector-cover-input-toggle');
  await until('!coverWorkspace.quickInputOpen', 'Input toggle closes once instead of reopening');
  await reopen();
  const point = await guest.executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  // Offscreen input does not perform cross-process hit testing. Transfer native
  // guest focus explicitly, then deliver the click to the real guest renderer.
  await run('document.querySelector(".right-inspector-tab-page.active webview").focus();void 0');
  guest.focus();
  guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until('!coverWorkspace.quickInputOpen', 'native page focus dismisses quick input');
  assert.equal(await guest.executeJavaScript('window.pageClicks'), 2, 'the original page click still executes');
  assert.equal(await run('document.querySelector("webview").getWebContentsId()'), guestId, 'dismissal retains the browser document');
  assert.equal(await run('coverStops'), 0, 'page click leaves the running turn intact');
  await reopen();
  assert.equal(await run('document.querySelector(".inspector-quick-input textarea").value'), 'outside click draft', 'reopening restores the draft');
  await run('coverUpdate({draft:""});void 0');
  console.log('Quick input dismissal passed: image preview close/backdrop/Escape isolation, internal clicks, host and native guest clicks, draft/task preservation, toggle and reopening.');
};
