const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const sizing = await window.webContents.insertCSS('.app { width:100%!important; }');
  const original = await run(`window.attachmentLayoutOriginal={...chatProps};
    window.attachmentLayoutImage=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#648b84';x.fillRect(0,0,w,h);return c.toDataURL()};
    window.attachmentLayoutMessage={id:'attachment-layout',turnId:'attachments-turn',role:'user',content:'A short request.',attachments:[
      {id:'portrait',type:'image',name:'portrait.png',path:attachmentLayoutImage(400,900)},
      {id:'document',type:'document',name:'A reference document with a long file name.pdf',path:'C:/fixture/reference.pdf',size:2048}]};
    updateChat({activeConversationId:'attachment-layout',messages:[attachmentLayoutMessage],draft:'',sending:false,loading:false,historyLoading:false});
    ({width:innerWidth,height:innerHeight})`);
  try {
    await until('document.querySelector(".user-message-attachments .message-image-preview img")?.naturalWidth===400', 'portrait attached');
    assert.equal(await run('document.querySelector(".user-bubble .message-image-strip,.user-bubble .message-file-strip")'), null);
    assert.equal(await run('document.querySelector(".user-bubble").textContent'), 'A short request.');
    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`document.querySelector('.app').className='app ${theme}'`);
      window.setContentSize(680, 800);
      await until('innerWidth===680 && innerHeight===800', 'attachment viewport resized');
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      // A resized offscreen Electron surface may lag behind DOM layout.
      // Wait for the compositor before requesting the screenshot.
      await pause(150);
      const geometry = await run(`(()=>{const image=document.querySelector('.user-message-attachments img').getBoundingClientRect(),bubble=document.querySelector('.user-bubble').getBoundingClientRect(),group=document.querySelector('.user-message-attachments').getBoundingClientRect();return{ratio:image.width/image.height,right:Math.abs(image.right-bubble.right),gap:bubble.top-group.bottom,width:bubble.width}})()`);
      assert.ok(Math.abs(geometry.ratio-400/900)<.01 && geometry.right<2 && geometry.gap>=7, JSON.stringify(geometry));
      assert.ok(geometry.width<300, 'text bubble fits its own short content');
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'), true);
      fs.writeFileSync(path.join(root, 'tmp', 'chat-attachments-'+theme+'.png'), (await window.webContents.capturePage()).toPNG());
    }
    await run('document.querySelector(".message-row.user .message-actions button:last-child").click()');
    await until('!!document.querySelector(".user-edit-card textarea")', 'editing text');
    assert.equal(await run('!!document.querySelector(".user-message-attachments .message-file-attachment")&&!document.querySelector(".user-edit-card .message-file-attachment")'), true, 'editing keeps attachments outside the editor');
    await run('document.querySelector(".user-edit-card .message-edit-actions button").click()');
    await until('!document.querySelector(".user-edit-card")', 'editing cancelled');
    await run('updateChat({messages:[{...attachmentLayoutMessage,content:"",attachments:[attachmentLayoutMessage.attachments[0]]}]})');
    await until('!document.querySelector(".user-bubble")&&!!document.querySelector(".user-message-attachments")', 'image-only message has no empty text bubble');
    assert.equal(await run('document.querySelectorAll(".message-row.user .message-actions button").length'), 1, 'image-only message offers editing without an empty-text copy action');
    await run('updateChat({messages:[{...attachmentLayoutMessage,attachments:[]}]})');
    await until('!document.querySelector(".user-message-attachments")&&!!document.querySelector(".user-bubble")', 'text-only message has no attachment gap');
    await run(`crypto.randomUUID??=()=>require('node:crypto').randomUUID();
      window.draftAttachmentApi={pick:cardbushDesktop.pickAttachments,inspect:cardbushDesktop.inspectAttachments};
      cardbushDesktop.pickAttachments=async()=>['C:/fixture/one.png','C:/fixture/two.png'];
      cardbushDesktop.inspectAttachments=async paths=>paths.map(path=>({path,name:path.split('/').pop(),kind:'file',size:2048}));
      updateChat({activeConversationId:'',messages:[],draft:'',language:'zh',selectedProjectDir:'',loading:false});`);
    await until('!!document.querySelector(".welcome-composer .composer-surface")', 'welcome composer');
    await run(`document.querySelector('.composer-tools .tool-chip').click()`);
    await until('!!document.querySelector(".composer-add-action")', 'attachment picker');
    await run(`document.querySelector('.composer-add-action').click()`);
    await until('document.querySelectorAll(".composer-image-thumb").length===2', 'two draft images');
    // The fixture does not expose native files. Supply real image pixels for visual review.
    await run(`document.querySelectorAll('.composer-image-thumb img').forEach((img,i)=>img.src=attachmentLayoutImage(400,700+i*100))`);
    for (const theme of ['theme-dark', 'theme-bright']) for (const width of [1180, 460]) {
      window.setContentSize(width, 760);
      await run(`document.querySelector('.app').className='app ${theme}'`);
      await pause(150);
      const geometry = await run(`(()=>{const surface=document.querySelector('.composer-surface'),s=surface.getBoundingClientRect(),tray=document.querySelector('.composer-attachments'),t=tray.getBoundingClientRect(),input=document.querySelector('[data-composer-input]').getBoundingClientRect(),bar=document.querySelector('.builtin-workspace-control').getBoundingClientRect();return{contained:surface.contains(tray)&&t.top>=s.top&&t.bottom<=s.bottom,above:t.bottom<=input.top,stripGap:s.top-bar.bottom,bottom:s.bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.ok(geometry.contained && geometry.above, JSON.stringify(geometry));
      assert.ok(geometry.stripGap<=1 && geometry.stripGap>=-24, 'workspace strip remains attached: '+JSON.stringify(geometry));
      assert.ok(!geometry.overflow && geometry.bottom<=geometry.viewport, JSON.stringify(geometry));
      fs.writeFileSync(path.join(root, 'tmp', `welcome-attachments-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await run(`document.querySelector('.composer-image-remove').click()`);
    await until('document.querySelectorAll(".composer-image-thumb").length===1', 'remove one draft image');
    await run(`document.querySelector('.composer-image-remove').click();cardbushDesktop.pickAttachments=draftAttachmentApi.pick;cardbushDesktop.inspectAttachments=draftAttachmentApi.inspect`);
    await until('!document.querySelector(".composer-attachments")', 'empty tray removed');
    console.log('Chat attachments passed: separate image/file cards, intrinsic text width, portrait ratio, editing, image-only/text-only and responsive themes.');
  } finally {
    await window.webContents.removeInsertedCSS(sizing);
    await run('document.querySelector(".app").className="app "+(window.viewTheme||"theme-dark");updateChat(attachmentLayoutOriginal)');
    await window.setContentSize(original.width, original.height);
  }
};
