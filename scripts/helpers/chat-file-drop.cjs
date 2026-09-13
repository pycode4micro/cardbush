const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    // The product runs on a secure origin; this isolated data: page needs Node's equivalent API.
    if (!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:require('node:crypto').randomUUID,configurable:true});
    window.dropOriginalProps = {...chatProps};
    window.dropOriginalDesktop = {...cardbushDesktop};
    window.attachmentInspections = []; window.dropSends = []; window.savedDropImages = [];
    cardbushDesktop.saveImageDataUrl = async (dataUrl,name) => {savedDropImages.push({dataUrl,name});return {path:'C:/drop-fixture/'+name,name};};
    cardbushDesktop.getPathForFile = file => file.fixturePath || '';
    cardbushDesktop.inspectAttachments = async paths => {
      attachmentInspections.push(paths);
      return paths.map(path => ({path,name:path.split('/').pop(),kind:path.endsWith('/frames')?'folder':'file',size:12}));
    };
    window.fileTransfer = names => {
      const transfer = new DataTransfer();
      for (const name of names) {
        const file = new File(['fixture'], name, {type:'application/octet-stream'});
        Object.defineProperty(file,'fixturePath',{value:'C:/drop-fixture/'+name});
        transfer.items.add(file);
      }
      return transfer;
    };
    window.dropEvent = (selector,type,transfer,relatedTarget=null) => {
      const event = new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer,relatedTarget});
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    };
    updateChat({draft:'Keep this draft',onDraftChange:draft=>updateChat({draft}),onSend:async text=>dropSends.push(text)});
  `);
  await pause();
  assert.equal(await run(`dropEvent('.welcome-hero h2','dragenter',fileTransfer(['notes.txt','clip.mp4','frames']))`), true);
  await until("!!document.querySelector('.chat-body > .composer-file-drop-overlay')", 'welcome body accepts files');
  assert.equal(await run(`(() => {
    const body=document.querySelector('.chat-body'),overlay=document.querySelector('.composer-file-drop-overlay');
    return overlay.offsetWidth===body.clientWidth-10 && overlay.offsetHeight===body.clientHeight-10;
  })()`), true, 'drop indicator covers the conversation body without changing its layout');
  await run(`
    dropEvent('[data-composer-input]','dragenter',fileTransfer(['notes.txt']));
    dropEvent('.welcome-hero h2','dragleave',fileTransfer(['notes.txt']),document.querySelector('[data-composer-input]'));
  `);
  assert.equal(await run("!!document.querySelector('.composer-file-drop-overlay')"), true, 'moving between body children keeps the drop target active');
  assert.equal(await run(`dropEvent('[data-composer-input]','drop',fileTransfer(['notes.txt','clip.mp4','frames']))`), true);
  await until("document.querySelectorAll('.composer-file-attachment').length === 3", 'mixed files and folder attached');
  assert.equal(await run('attachmentInspections.length'), 1, 'one file drop follows exactly one attachment pipeline');
  assert.equal(await run('chatProps.draft'), 'Keep this draft');
  assert.deepEqual(await run('dropSends'), [], 'dropping only prepares attachments, never sends a message');
  assert.equal(await run("!!document.querySelector('.composer-file-drop-overlay')"), false);
  await run(`
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
    const imageTransfer=new DataTransfer();imageTransfer.items.add(new File([png],'dropped.png',{type:'image/png'}));
    dropEvent('.welcome-hero','drop',imageTransfer);
  `);
  await until("document.querySelectorAll('.composer-image-preview').length === 1", 'image dropped over conversation enters the attachment strip');
  assert.equal(await run('savedDropImages.length'), 1);
  await run("document.querySelector('.composer-image-preview').click()");
  await until("!!document.querySelector('.image-preview-dialog')", 'dropped image can be previewed');
  await run("document.querySelector('.image-preview-close').click()");
  await until("!document.querySelector('.image-preview-dialog')", 'image preview closes without affecting attachments');
  await run(`dropEvent('.welcome-hero','drop',fileTransfer(['notes.txt']))`);
  await pause();
  assert.equal(await run("document.querySelectorAll('.composer-file-attachment').length"), 3, 'duplicate files stay deduplicated');
  for (const end of ['blur','dragend','keydown']) {
    await run(`dropEvent('.welcome-hero','dragenter',fileTransfer(['notes.txt']))`);
    await until("!!document.querySelector('.composer-file-drop-overlay')", 'drop indicator shown');
    await run(end === 'keydown' ? `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))` : `window.dispatchEvent(new Event('${end}'))`);
    await until("!document.querySelector('.composer-file-drop-overlay')", `${end} clears cancelled drag`);
  }
  assert.equal(await run(`(() => { const transfer=new DataTransfer();transfer.setData('text/plain','Selected text');return dropEvent('.welcome-hero','drop',transfer); })()`), false, 'text dragging is not treated as a file');
  await run(`updateChat({activeConversationId:'drop-session',messages:[{id:'drop-user',role:'user',content:'Drop over this conversation message',createdAt:'2026-09-13T00:00:00Z'}]})`);
  await until("document.querySelector('.message-list')?.textContent.includes('Drop over this conversation message')", 'existing conversation mounted');
  assert.equal(await run("document.querySelectorAll('.composer-file-attachment').length"), 0, 'attachments do not cross sessions');
  assert.equal(await run("document.querySelectorAll('.composer-image-preview').length"), 0, 'image attachments stay in their own session');
  const before = await run('attachmentInspections.length');
  await run(`dropEvent('.user-bubble','dragenter',fileTransfer(['report.pdf']));dropEvent('.user-bubble','drop',fileTransfer(['report.pdf']))`);
  await until("document.querySelectorAll('.composer-file-attachment').length === 1", 'drop over an existing message attaches to the composer');
  assert.equal(await run('attachmentInspections.length'), before + 1, 'welcome listener was removed');
  // A pending inspection belongs to the composer that received it, even when the user switches sessions.
  await run(`
    cardbushDesktop.inspectAttachments=paths=>new Promise(resolve=>{window.resolveDropInspection=()=>resolve(paths.map(path=>({path,name:'late.txt',kind:'file'})));});
    dropEvent('.user-bubble','drop',fileTransfer(['late.txt']));
    updateChat({activeConversationId:'drop-next-session'});
  `);
  await pause();
  await run('resolveDropInspection()');
  await pause();
  assert.equal(await run("document.querySelectorAll('.composer-file-attachment').length"), 0, 'a delayed attachment cannot appear in a different conversation');
  await run(`
    renderView(null);
    for(const key of Object.keys(cardbushDesktop)) if(!(key in dropOriginalDesktop)) delete cardbushDesktop[key];
    Object.assign(cardbushDesktop,dropOriginalDesktop);
    updateChat(dropOriginalProps);
  `);
  await until("!!document.querySelector('.welcome-hero')", 'original view restored');
  console.log('Conversation file drop passed: welcome and transcript targets, full-body indicator, mixed attachments, nested drag, one delivery, cancellation, text passthrough and session isolation.');
};
