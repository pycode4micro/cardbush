const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const savedSize = window.getContentSize();
  const css = await window.webContents.insertCSS('.app{width:100%!important}');
  window.setContentSize(1000, 720);
  await run(`
    window.queueImageSaved = { props: {...chatProps}, update: updateChat, theme: viewTheme,
      readImage: cardbushDesktop.readImageDataUrl };
    window.queueImageReads = []; window.queueImageGuides = []; window.queueImageRemovals = [];
    window.queueImageDisposals = []; window.queueImagePending = []; window.queueImageHost = undefined;
    window.queuePixel = color => { const canvas = document.createElement('canvas'); canvas.width=80;canvas.height=60;
      const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,80,60);
      context.fillStyle='#ffffff';context.fillRect(16,12,48,36);context.fillStyle=color;context.fillRect(24,20,32,20);
      return canvas.toDataURL('image/png'); };
    window.queueImageBlue = queuePixel('#4478bf'); window.queueImageGreen = queuePixel('#3d8865');
    cardbushDesktop.readImageDataUrl = async path => { queueImageReads.push(path);
      if(path.includes('missing')) throw Error('Fixture image missing'); return queueImageBlue; };
    window.queueImageText = '@"C:/queue fixture/参考 #1.png"\\n@c:/queue fixture/参考 #1.png\\n@C:/queue fixture/second.png\\n@C:/queue fixture/third.png\\n参考这几张图片继续处理，保留完整要求。';
    window.queueImageItems = [
      {id:'images',text:queueImageText},
      {id:'image-only',text:'@C:/queue fixture/only.png'},
      {id:'code',text:'示例代码\\n' + String.fromCharCode(96).repeat(3) + '\\n@C:/queue fixture/example.png\\n' + String.fromCharCode(96).repeat(3)},
      {id:'mixed',text:'@C:/queue fixture/document.pdf\\n@C:/queue fixture/mixed.png\\n按附件调整'},
      {id:'missing',text:'@C:/queue fixture/missing.png\\n图片暂时不可用'},
    ].map(item=>({...item,createdAt:'2026-10-28T00:00:00Z'}));
    window.updateChat = patch => {Object.assign(chatProps,patch);renderView(h(views.ConversationHostContext.Provider,{value:queueImageHost},
      h('section',{className:'main-stage',style:{height:'100%'}},h(views.ChatPanel,chatProps))));};
    window.setQueueImages = items => {queueImageItems=items;updateChat({queuedMessages:items,queuedMessageCount:items.length,queuedMessagePreview:items[0]?.text??''});};
    updateChat({language:'zh',activeConversationId:'queue-images',messages:[{id:'queue-image-user',role:'user',content:'继续整理素材'}],
      loading:false,historyLoading:false,sending:true,stopping:false,activeTurnId:'queue-image-turn',draft:'',queueLocked:false,
      onDraftChange:draft=>updateChat({draft}),
      onGuideQueuedMessage:async id=>{queueImageGuides.push(queueImageItems.find(item=>item.id===id));setQueueImages(queueImageItems.filter(item=>item.id!==id));},
      onRemoveQueuedMessage:id=>{queueImageRemovals.push(id);setQueueImages(queueImageItems.filter(item=>item.id!==id));},
      onReorderQueuedMessage:(id,target)=>setQueueImages(views.reorderScopedQueue(queueImageItems,id,target,item=>item.id,()=>'')),
    });
    setQueueImages(queueImageItems);
  `);
  const screenshot = async name => {
    await pause(160);
    const area = await run(`(()=>{const rail=document.querySelector('.composer-runtime-rail').getBoundingClientRect(),
      input=document.querySelector('.composer-surface').getBoundingClientRect();return{x:Math.max(0,Math.floor(input.left-4)),
      y:Math.max(0,Math.floor(rail.top-4)),width:Math.ceil(input.width+8),height:Math.ceil(input.bottom-rail.top+8)}})()`);
    fs.writeFileSync(path.join(root, 'tmp', name), (await window.webContents.capturePage(area)).toPNG());
  };
  try {
    await until('document.querySelector("[data-queue-item-id=images] .is-thumbnail img")?.naturalWidth === 80', 'local queue thumbnail loads through existing image recovery');
    await until('!!document.querySelector("[data-queue-item-id=missing] .is-thumbnail.is-failed")', 'unavailable thumbnail stays compact');
    assert.equal(await run('document.querySelector("[data-queue-item-id=images] .runtime-queue-image-count").textContent'), '+2', 'Windows path aliases are deduplicated');
    assert.equal(await run('document.querySelector("[data-queue-item-id=images] .runtime-queue-prompt").textContent'), '参考这几张图片继续处理，保留完整要求。');
    assert.equal(await run('document.querySelector("[data-queue-item-id=image-only] .runtime-queue-prompt").textContent'), 'only.png', 'image-only prompts retain a useful label');
    assert.equal(await run('document.querySelector("[data-queue-item-id=code] .runtime-queue-images")'), null, 'code examples do not attach images');
    assert.equal(await run('queueImageReads.some(path=>path.includes("example.png")||path.includes("document.pdf"))'), false);
    assert.ok(await run('document.querySelector("[data-queue-item-id=mixed] .runtime-queue-prompt").textContent.includes("@C:/queue fixture/document.pdf")'), 'non-image references stay in the preview');
    assert.equal(await run('queueImageItems[0].text===queueImageText'), true, 'rendering never rewrites the queued prompt');
    await run('updateChat({language:"en"})');
    await until('document.querySelector(".composer-runtime-rail")?.getAttribute("aria-label")==="Guidance queue"', 'queue locale updates while mounted');
    assert.equal(await run('document.querySelector(".runtime-queue-image-count").getAttribute("aria-label")'), 'View all 3 images');
    assert.match(await run('document.querySelector("[data-queue-item-id=missing] .is-thumbnail").title'), /Preview unavailable/);
    await run('document.querySelector("[data-queue-item-id=images] .queue-actions-trigger").click()');
    await until('document.querySelector(".queue-actions-popover:popover-open [data-queue-action=edit]")?.textContent==="Edit"', 'queue menu uses the selected language pack');
    await run('document.querySelector(".queue-actions-popover:popover-open").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));document.querySelector(".runtime-queue-image-count").click()');
    await until('document.querySelector(".image-preview-dialog")?.getAttribute("aria-label")==="Image preview: second.png"', 'image viewer uses interpolated English labels');
    await run('updateChat({language:"zh"})');
    await until('document.querySelector(".image-preview-dialog")?.getAttribute("aria-label")==="图片预览：second.png"', 'open viewer follows a language change');
    assert.equal(await run('document.querySelector(".image-preview-scope").getAttribute("aria-label")'), '图片范围');
    await run('document.querySelector(".image-preview-close").click()');
    await until('!document.querySelector(".image-preview-dialog")', 'localized viewer closes');
    assert.equal(await run('getComputedStyle(document.querySelector("[data-queue-item-id=missing] .message-image-fallback-icon")).width'), '14px');
    await run('document.documentElement.style.setProperty("--queue-thumbnail-size","28px");document.querySelector("[data-queue-item-id=missing] .is-thumbnail").style.setProperty("--message-image-fallback-icon-size","17px")');
    assert.equal(await run('getComputedStyle(document.querySelector("[data-queue-item-id=missing] .is-thumbnail")).width'), '28px');
    assert.equal(await run('getComputedStyle(document.querySelector("[data-queue-item-id=missing] .message-image-fallback-icon")).width'), '17px');
    await run('document.documentElement.style.removeProperty("--queue-thumbnail-size");document.querySelector("[data-queue-item-id=missing] .is-thumbnail").style.removeProperty("--message-image-fallback-icon-size")');
    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`window.viewTheme=${JSON.stringify(theme)};updateChat({});`);
      for (const width of [720, 330]) {
        await run(`document.querySelector('.chat-panel').style.width='${width}px';`); await pause(120);
        const bounds = await run(`Array.from(document.querySelectorAll('.runtime-queue-item')).map(row=>{
          const r=row.getBoundingClientRect(),text=row.querySelector('.runtime-queue-prompt').getBoundingClientRect(),
            actions=row.querySelector('.runtime-queue-actions').getBoundingClientRect(),image=row.querySelector('.is-thumbnail')?.getBoundingClientRect();
          return {height:r.height,contained:row.scrollWidth<=row.clientWidth+1&&text.width>20&&text.right<=actions.left,
            imageWidth:image?.width,imageHeight:image?.height};})`);
        assert.ok(bounds.every(row=>row.height>=30&&row.height<=31&&row.contained), `${theme}/${width}: compact rows and reachable actions ${JSON.stringify(bounds)}`);
        assert.ok(bounds.filter(row=>row.imageWidth).every(row=>row.imageWidth===24&&row.imageHeight===24));
        await screenshot(`queue-images-${theme}-${width}.png`);
      }
    }
    await run(`document.querySelector('.chat-panel').style.width='720px';window.queueImageTrigger=document.querySelector('[data-queue-item-id=images] .is-thumbnail');queueImageTrigger.focus();queueImageTrigger.click();`);
    await until('document.querySelector(".image-preview-canvas img")?.naturalWidth === 80', 'thumbnail opens full image viewer');
    assert.equal(await run('document.querySelector(".image-preview-position").textContent'), '1 / 3');
    await run(`document.querySelector('.image-preview-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));`);
    assert.equal(await run('queueImageGuides.length'), 0, 'preview keyboard events cannot send queued guidance');
    await run('document.querySelector(".image-preview-close").click()');
    await until('!document.querySelector(".image-preview-dialog")', 'viewer closes');
    assert.equal(await run('document.activeElement===queueImageTrigger'), true, 'closing restores the thumbnail focus');
    await run('document.querySelector("[data-queue-item-id=images] .runtime-queue-image-count").click()');
    await until('document.querySelector(".image-preview-position")?.textContent === "2 / 3"', 'image count opens the remaining attachments');
    await until('document.querySelector(".image-preview-canvas img")?.naturalWidth === 80', 'second attachment loads');
    await run('document.querySelector(".image-preview-close").click()');
    await run('document.querySelector("[data-queue-item-id=images] .queue-actions-trigger").click()');
    await until('!!document.querySelector(".queue-actions-popover:popover-open [data-queue-action=edit]")', 'image prompt edit action');
    await run('document.querySelector(".queue-actions-popover:popover-open [data-queue-action=edit]").click()');
    await until('chatProps.draft===queueImageText', 'editing restores original paths and text');
    assert.deepEqual(await run('queueImageRemovals'), ['images']);
    await run('updateChat({draft:""});document.querySelector("[data-queue-item-id=image-only] .runtime-queue-guide").click()');
    await until('queueImageGuides.length===1', 'image-only queue can be guided');
    assert.equal(await run('queueImageGuides[0].text'), '@C:/queue fixture/only.png');

    const localReads = await run('queueImageReads.length');
    await run(`
      window.makeQueueHost=(id,resolveFileSource)=>({id,sessionId:'queue-images',plugins:[],pluginCommands:[],uploadFiles:async()=>[],openFile:()=>{},toolDetails:async()=>[],resolveFileSource});
      queueImageHost=makeQueueHost('queue-remote-old',path=>new Promise(resolve=>queueImagePending.push(()=>resolve({source:queueImageBlue,dispose:()=>queueImageDisposals.push('old')}))));
      setQueueImages([{id:'remote',text:'@C:/queue fixture/same-name.png\\n远程图片',createdAt:''}]);
    `);
    await until('queueImagePending.length>0', 'remote preview requested from its owner');
    assert.deepEqual(await run(`(()=>{const node=document.querySelector('.is-thumbnail .message-image-loading');return {
      label:node.getAttribute('aria-label'),height:node.getBoundingClientRect().height,
      full:getComputedStyle(node.querySelector('.message-image-loading-label')).display,
      compact:getComputedStyle(node.querySelector('.message-image-loading-compact')).display};})()`),
      {label:'正在加载…',height:24,full:'none',compact:'block'}, 'compact loading uses CSS presentation while retaining its accessible label');
    await run(`queueImageHost=makeQueueHost('queue-remote-new',async path=>({source:queueImageGreen,dispose:()=>queueImageDisposals.push('new')}));updateChat({});`);
    await until('document.querySelector("[data-queue-item-id=remote] .is-thumbnail img")?.src===queueImageGreen', 'switching hosts uses the new image source');
    await run('queueImagePending.forEach(resolve=>resolve());void 0');
    await until('queueImageDisposals.includes("old")', 'stale remote source is disposed');
    assert.equal(await run('document.querySelector("[data-queue-item-id=remote] .is-thumbnail img").src===queueImageGreen'), true);
    await run(`queueImageHost=makeQueueHost('queue-remote-failed',async()=>{throw Error('Remote permission denied')});updateChat({});`);
    await until('!!document.querySelector("[data-queue-item-id=remote] .is-thumbnail.is-failed")', 'remote denial has a bounded fallback');
    assert.equal(await run('queueImageReads.length'), localReads, 'remote failures never fall back to the local filesystem');
    assert.ok(await run('queueImageDisposals.includes("new")'), 'replaced remote resource is released');
    console.log('Queue images passed: 30px rows, 24px thumbnails, dark/light/narrow layout, deduplication, image-only and mixed prompts, viewer/focus, original edit/guide payloads, remote ownership, stale cleanup and no local fallback.');
  } finally {
    await run('document.documentElement.style.removeProperty("--queue-thumbnail-size")');
    await run('renderView(null)'); await until('!document.querySelector(".chat-panel")', 'image fixture unmounted');
    await run('cardbushDesktop.readImageDataUrl=queueImageSaved.readImage;window.updateChat=queueImageSaved.update;window.viewTheme=queueImageSaved.theme;updateChat(queueImageSaved.props);');
    await until('!!document.querySelector(".chat-panel")', 'restored chat has committed');
    window.setContentSize(...savedSize); await window.webContents.removeInsertedCSS(css);
  }
};
