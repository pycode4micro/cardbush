const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow, session } = require('electron');
const directory = resolve(process.argv[2]); app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('MCP Apps UI timed out'); app.exit(1); }, 25000);
app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('cardbush-file', request => new URL(request.url).pathname.endsWith('.png')
    ? new Response('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="100%" height="100%" fill="#234d4f"/><circle cx="240" cy="120" r="75" fill="#f2bd77"/></svg>', { headers: { 'content-type': 'image/svg+xml' } })
    : new Response('', { status: 404 }));
  const win = new BrowserWindow({ show: false, width: 880, height: 720, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  require('../dist-electron/sandboxFrameGuard.js').installSandboxFrameNavigationGuard(win.webContents);
  const read = async script => { try { return await win.webContents.executeJavaScript(script); } catch (error) { throw new Error(`Fixture script failed: ${script}`, { cause: error }); } };
  const until = async script => { const end = Date.now() + 5000; while (!await read(script)) { if (Date.now() > end) throw Error(`Timed out: ${script}; ` + await read('JSON.stringify(fixtureReports) + document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 25)); } };
  const click = label => read(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const send = action => read(`document.querySelector('iframe').contentWindow.postMessage({fixture:${JSON.stringify(action)}},'*')`);
  const openReference = async () => {
    await until('!!document.querySelector(".message-app-reference")');
    await read('document.querySelector(".message-app-reference").click()');
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    await require('./helpers/mcp-app-references.cjs')({ win, read, until, send, click });
    for (const [name, width, height, windowWidth] of [['square',2048,2048,880],['wide',2048,768,430],['portrait',768,2048,430]]) {
      await win.setContentSize(windowWidth, 720);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg"><stop stop-color="#183b45"/><stop offset="1" stop-color="#a5d4bf"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/><circle cx="${width*.54}" cy="${height*.43}" r="${Math.min(width,height)*.23}" fill="#f2bd77"/><path d="M0 ${height} L${width*.35} ${height*.48} L${width*.62} ${height*.72} L${width} ${height*.4} V${height}Z" fill="#234d4f"/></svg>`;
      const artifact = { id: `layout-${name}`, name: `${name}.svg`, path: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, type: 'image', display: 'inline' };
      await read(`clearFixture();mediaOnly=true;fixtureImage=${JSON.stringify(artifact)};renderFixture(true)`);
      await until('!!document.querySelector(".tool-execution-summary")');
      assert.equal(await read('document.querySelector(".message-tool-artifact img,.image-preview-dialog")'), null);
      await read('if(document.querySelector(".tool-execution-summary").getAttribute("aria-expanded")!=="true")document.querySelector(".tool-execution-summary").click()');
      await until('!!document.querySelector("[data-execution-id=files] .tool-execution-row")');
      await read('if(document.querySelector("[data-execution-id=files] .tool-execution-row").getAttribute("aria-expanded")!=="true")document.querySelector("[data-execution-id=files] .tool-execution-row").click()');
      await until('!!document.querySelector(".tool-image-artifact-button")');
      assert.equal(await read('document.querySelector(".tool-execution-body img,.image-preview-dialog")'), null, 'expanding details does not load images');
      await read('document.querySelector(".tool-image-artifact-button").click()');
      await until(`document.querySelector('.image-preview-canvas img')?.naturalWidth === ${width}`);
      await until('document.querySelector(".image-preview-stage")?.getAttribute("aria-busy")==="false"');
      assert.equal(await read('(()=>{const image=document.querySelector(".image-preview-canvas img"),stage=document.querySelector(".image-preview-stage");return image.getBoundingClientRect().width<=stage.clientWidth+1&&image.getBoundingClientRect().height<=stage.clientHeight+1})()'), true, `${name} opens fitted to the preview`);
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      win.webContents.invalidate(); writeFileSync(resolve(`tmp/tool-output-layout-${name}.png`), (await win.webContents.capturePage()).toPNG());
      await read('document.querySelector(".image-preview-close").click()');
      await until('!document.querySelector(".image-preview-dialog")');
    }
    await read(`fixtureImage={id:'unavailable',name:'unavailable.png',path:'data:image/png;base64,bm90YW5pbWFnZQ==',type:'image',display:'inline'};renderFixture(true)`);
    await until('document.querySelector(".tool-image-artifact-button")?.getAttribute("aria-label").includes("unavailable.png")');
    assert.equal(await read('document.querySelector(".message-tool-artifact img,.image-preview-dialog")'), null, 'unopened invalid images never load or show preview errors');
    const deliveredImage = {id:'apple',name:'apple.png',path:'C:\\\\fixture\\\\apple.png',type:'image',display:'inline'};
    const answer = '苹果图片已生成完毕。\n\nC:/fixture/apple.png\n\n尺寸与格式说明。';
    await read(`fixtureImage=${JSON.stringify(deliveredImage)};fixtureContent=${JSON.stringify(answer)};renderFixture(true)`);
    await until('document.querySelector(".tool-image-artifact-button")?.getAttribute("aria-label").includes("apple.png")');
    assert.equal(await read('document.querySelectorAll(".assistant-active-transcript .tool-image-thumbnail img").length'), 1, 'loop retains its compact image thumbnail');
    assert.equal(await read('Array.from(document.querySelectorAll(".assistant-active-transcript img")).filter(image=>!image.closest(".tool-image-thumbnail")).length'), 0, 'loop image references do not duplicate tool previews');
    await read('renderFixture(false)');
    await until('document.querySelector(".assistant-final-answer img")?.naturalWidth===480');
    assert.equal(await read('document.querySelector(".message-tool-artifact")'), null);
    assert.deepEqual(await read(`Array.from(document.querySelector('.assistant-final-answer .message-inline-media-content').children).map(el=>el.querySelector('img')?'image':el.textContent.trim())`),
      ['苹果图片已生成完毕。', 'image', '尺寸与格式说明。'], 'final media stays between its authored paragraphs');
    for(const reference of ['![苹果](<C:/fixture/apple.png>)','![苹果](file:///C:/fixture/apple.png)','![苹果](cardbush-memo:s/t/call)']) {
      const content = `前文。\n\n${reference}\n\n后文。`;
      await read(`fixtureContent=${JSON.stringify(content)};renderFixture(false)`);
      await until('document.querySelector(".assistant-final-answer img")?.naturalWidth===480&&document.querySelector(".assistant-final-answer").textContent.includes("前文")');
      assert.equal(await read('document.querySelectorAll(".assistant-final-answer img").length'), 1, 'the model reference renders an image even when the file is a tool artifact');
      assert.equal(await read('document.querySelector(".message-tool-artifact")'), null);
    }
    const ordered = '开头。\n\nC:/fixture/voice.wav\nC:/fixture/apple.png\nC:/fixture/clip.mp4\n\n结尾。';
    await read(`fixtureContent=${JSON.stringify(ordered)};fixtureArtifacts=[fixtureImage];renderFixture(false)`);
    await until('document.querySelector(".assistant-final-answer audio")&&document.querySelector(".assistant-final-answer video")');
    assert.deepEqual(await read('Array.from(document.querySelectorAll(".assistant-final-answer audio,.assistant-final-answer img,.assistant-final-answer video")).map(el=>el.tagName)'), ['AUDIO','IMG','VIDEO'], 'mixed standalone media follows the final answer order');
    const embedded = '第一段。\n\n![音频](C:/fixture/voice.wav)\n\n第二段。\n\n![图片](C:/fixture/apple.png)\n\n第三段。\n\n![视频](C:/fixture/clip.mp4)\n\n末段。';
    await read(`fixtureContent=${JSON.stringify(embedded)};fixtureAttachments=[fixtureImage];renderFixture(false)`);
    await until('!!document.querySelector(".assistant-final-answer .markdown-content audio")&&!!document.querySelector(".assistant-final-answer .markdown-content video")');
    assert.deepEqual(await read('Array.from(document.querySelectorAll(".assistant-final-answer p")).map(el=>el.querySelector("audio,img,video")?.tagName??el.textContent)'),
      ['第一段。','AUDIO','第二段。','IMG','第三段。','VIDEO','末段。']);
    assert.equal(await read('Array.from(document.querySelectorAll(".assistant-final-answer audio,.assistant-final-answer video")).every(el=>el.controls)'), true);
    assert.equal(await read('document.querySelector(".message-tool-artifact")'), null);
    await win.setContentSize(430, 720);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await read('document.documentElement.scrollWidth <= innerWidth'), true);
    win.webContents.invalidate(); writeFileSync(resolve('tmp/final-answer-media-order.png'), (await win.webContents.capturePage()).toPNG());
    await read('clearFixture()'); await read('renderFixture(false)');
    await until('!!document.querySelector(".assistant-final-answer .markdown-content audio")');
    assert.equal(await read('document.querySelectorAll(".assistant-final-answer img").length'), 1, 'reopening a final reply keeps only its authored media');
    await read('fixtureContent="已完成";fixtureArtifacts=[fixtureImage,{...fixtureImage,id:"same-file",path:"file:///C:/fixture/apple.png"}];fixtureAttachments=[fixtureImage];renderFixture(false)');
    await until('document.querySelector(".assistant-final-answer")?.textContent==="已完成"');
    assert.equal(await read('document.querySelector(".message-tool-artifact,img,audio,video")'), null, 'unreferenced final attachments are not inserted above or below the answer');
    console.log('Final answer media UI passed: authored text/media order, mixed media, Markdown players, memo references, no independent attachment promotion and re-entry.');
    await read(`window.loopImage={id:'loop-image',name:'apple.png',path:'C:/fixture/apple.png',type:'image',display:'inline'};
      window.loopCall={id:'generate-image',name:'fixture_generate',state:'completed',turnId:'t',summary:'生成图片',output:'Image ready',success:true,durationMs:1,createdAt:'2026-09-10T00:00:01Z',sequence:1,contentOffset:5,contentOffsetExplicit:true,artifacts:[loopImage],metadata:{}};
      window.loopRound={id:'image-round',role:'assistant',turnId:'t',content:'开始生成。',createdAt:'2026-09-10T00:00:00Z',toolExecutions:[loopCall]};
      imageReads=[];fixtureMessageOverrides={content:'图片返回后的自查说明。',attachments:[],toolExecutions:[],loopHistory:[loopRound]};renderFixture(true)`);
    await until('document.querySelector("[data-segment-id=message]")?.textContent.includes("自查说明")');
    assert.equal(await read('document.querySelector(".message-tool-media-outputs img,.image-preview-dialog")'), null);
    await read('if(document.querySelector("[data-segment-id=image-round] .tool-execution-summary").getAttribute("aria-expanded")!=="true")document.querySelector("[data-segment-id=image-round] .tool-execution-summary").click()');
    await until('!!document.querySelector("[data-execution-id=generate-image] .tool-execution-row")');
    await read('document.querySelector("[data-execution-id=generate-image] .tool-execution-row").click()');
    await until('!!document.querySelector("[data-segment-id=image-round] .loop-image-previews .tool-image-artifact-button")');
    assert.deepEqual(await read('imageReads'), [], 'opening tool details does not read image data');
    await read('document.querySelector("[data-segment-id=image-round] .loop-image-previews .tool-image-artifact-button").click()');
    await until('document.querySelector(".image-preview-stage")?.getAttribute("aria-busy")==="false"');
    assert.equal(await read('(()=>{const image=document.querySelector(".image-preview-canvas img"),stage=document.querySelector(".image-preview-stage");return image.naturalWidth>0&&image.getBoundingClientRect().width<=stage.clientWidth&&image.getBoundingClientRect().height<=stage.clientHeight})()'),true,'View image opens at the fitted size');
    assert.deepEqual(await read('imageReads'), ['C:/fixture/apple.png'], 'image data is read only after the explicit click');
    await read('document.querySelector(".image-preview-close").click()');
    await until('!document.querySelector(".image-preview-dialog")');
    assert.equal(await read('document.querySelector(".tool-image-artifact-button").closest("[data-segment-id]").dataset.segmentId'),'image-round','the image entry stays in the producing round');
    await read('window.loopImageButton=document.querySelector(".tool-image-artifact-button");fixtureMessageOverrides={...fixtureMessageOverrides,content:fixtureMessageOverrides.content+"\\n\\n流式追加的说明。"};renderFixture(true)');
    await until('document.querySelector("[data-segment-id=message]")?.textContent.includes("流式追加")');
    assert.equal(await read('document.querySelector(".tool-image-artifact-button")===loopImageButton'),true,'appending narration retains the image entry');
    await read(`fixtureMessageOverrides={...fixtureMessageOverrides,toolExecutions:[{...loopCall,id:'inspect-image',sequence:2,createdAt:'2026-09-10T00:00:02Z',contentOffset:0,artifacts:[{...loopImage,id:'view-again',path:'file:///C:/fixture/apple.png'}]}]};renderFixture(true)`);
    await until('document.body.innerText.includes("流式追加")');
    assert.equal(await read('document.querySelector(".message-tool-artifact img,.image-preview-dialog")'),null,'later observations do not reopen images');
    assert.deepEqual(await read('imageReads'), ['C:/fixture/apple.png'], 'tool updates do not read the image again');
    await read(`window.mediaBoundary=fixtureMessageOverrides.content.length;
      fixtureMessageOverrides={...fixtureMessageOverrides,content:fixtureMessageOverrides.content+'\\n\\n音视频返回后的说明。',toolExecutions:[...fixtureMessageOverrides.toolExecutions,{...loopCall,id:'generate-video-audio',sequence:3,createdAt:'2026-09-10T00:00:03Z',contentOffset:mediaBoundary,artifacts:[{id:'loop-video',name:'clip.mp4',path:'C:/fixture/clip.mp4',type:'video',display:'inline'},{id:'loop-audio',name:'voice.mp3',path:'C:/fixture/voice.mp3',type:'audio',display:'inline'}]}]};renderFixture(true)`);
    await until('!!document.querySelector(".message-tool-media-outputs audio")&&Array.from(document.querySelectorAll(".markdown-content p")).some(node=>node.textContent==="音视频返回后的说明。")');
    assert.deepEqual(await read('Array.from(document.querySelectorAll(".message-tool-media-outputs img,.message-tool-media-outputs video,.message-tool-media-outputs audio")).map(node=>node.tagName)'),['VIDEO','AUDIO']);
    // Streaming Markdown can commit between reads; check both live nodes in
    // one snapshot before asserting that media precedes the appended text.
    await until('(()=>{const audio=document.querySelector(".message-tool-media-outputs audio"),tail=Array.from(document.querySelectorAll(".markdown-content p")).find(node=>node.textContent==="音视频返回后的说明。");return !!(audio&&tail&&(audio.compareDocumentPosition(tail)&Node.DOCUMENT_POSITION_FOLLOWING))})()');
    await win.setContentSize(880,850);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    for(let attempt=0;attempt<3;attempt++){
      try{win.webContents.invalidate();writeFileSync(resolve('tmp/loop-media-order.png'),(await win.webContents.capturePage()).toPNG());break;}
      catch(error){if(attempt===2||!String(error).includes('UnknownVizError'))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    for(const status of ['stopped','failed']){
      await read(`fixtureMessageOverrides={...fixtureMessageOverrides,status:${JSON.stringify(status)}};renderFixture(false)`);
      await until('!!document.querySelector(".tool-execution-summary")&&!document.querySelector(".message-row.streaming")');
      await read('if(document.querySelector(".tool-execution-summary").getAttribute("aria-expanded")!=="true")document.querySelector(".tool-execution-summary").click()');
      await until('!!document.querySelector("[data-execution-id=generate-image] .tool-execution-row")');
      await read('if(document.querySelector("[data-execution-id=generate-image] .tool-execution-row").getAttribute("aria-expanded")!=="true")document.querySelector("[data-execution-id=generate-image] .tool-execution-row").click()');
      await until('!!document.querySelector("[data-segment-id=image-round] .loop-image-previews .tool-image-artifact-button")');
      assert.equal(await read('document.querySelector(".message-tool-artifact img,.image-preview-dialog")'), null, status+' transcripts keep images closed');
      assert.equal(await read('!!document.querySelector("[data-segment-id=image-round] .loop-image-previews .tool-image-artifact-button")'), true, status+' transcripts keep the image entry available');
      assert.deepEqual(await read('imageReads'), ['C:/fixture/apple.png'], status+' transcripts do not load images when details reopen');
    }
    await read('clearFixture()');await read('renderFixture(false)');
    await until('!!document.querySelector(".tool-execution-summary")');
    assert.equal(await read('document.querySelector(".message-tool-artifact img,.image-preview-dialog")'),null,'reopening a terminal transcript does not load images');
    await read('fixtureMessageOverrides={content:"开头。\\n\\nC:/fixture/voice.mp3\\nC:/fixture/apple.png\\nC:/fixture/clip.mp4\\n\\n尾段。",attachments:[],toolExecutions:[],loopHistory:[]};renderFixture(true)');
    await until('!!document.querySelector(".message-inline-media-block video")');
    assert.deepEqual(await read('Array.from(document.querySelectorAll(".message-inline-media-block audio,.message-inline-media-block img,.message-inline-media-block video")).map(node=>node.tagName)'),['AUDIO','IMG','VIDEO'],'consecutive authored media in a loop preserve their source order');
    console.log('Loop media UI passed: on-demand image reads, retained image entries, repeated observations, mixed media, stop/failure and transcript re-entry.');
    await read('clearFixture()');
    await until('!document.querySelector(".message-row")');
    const localCalls = await read('localRuntimeCalls');
    await read('mediaOnly=false;fixtureReports={};followup=null;followupHost=null;renderRemoteFixture(true)');
    await until('document.querySelector(".message-tool-artifact img")?.naturalWidth > 0');
    assert.equal(await read('document.querySelector("iframe,.message-app-reference")'), null, 'remote loops also suppress interactive Apps');
    await read('renderRemoteFixture(false)'); await until('!!document.querySelector(".message-app-reference")');
    assert.equal(await read('remoteCommands.some(command=>command.payload.action==="open")'), false, 'remote completion shows a reference without loading App content');
    await openReference(); await until('!!fixtureReports.result');
    assert.deepEqual(await read('remoteReads'), ['/srv/result.png'], 'only inline media is fetched; remote document attachments stay lazy');
    assert.equal(await read('document.querySelector(".message-tool-artifact img").src.startsWith("blob:")'), true);
    assert.equal(await read('[...document.querySelectorAll("a,img")].some(node=>(node.href||node.src).startsWith("file:"))'), false, 'remote output never uses local file URLs');
    await read('[...document.querySelectorAll(".message-tool-artifact button")].find(button=>button.textContent.includes("report.pdf")).click()');
    assert.deepEqual(await read('openedRemoteFiles'), ['/srv/report.pdf']);
    assert.equal(await read('remoteCommands.some(command=>command.kind==="runtime.mcp_app"&&command.payload.action==="open")'), true);
    await read('document.querySelector("iframe").contentWindow.postMessage({fixture:"message"},"*")');
    await until('!!document.querySelector(".mcp-app-confirm")');
    await read('[...document.querySelectorAll(".mcp-app-confirm button")].find(button=>button.textContent.includes("发送到会话")).click()');
    await until('followup === "Continue fixture"');
    assert.equal(await read('followupHost'), 'cloud:s', 'confirmed plugin messages retain the remote conversation identity');
    await read('renderRemoteFixture(true)');
    await until('!document.querySelector("iframe") && remoteCommands.some(command=>command.payload.action==="close")');
    await read('renderRemoteFixture(false)'); await until('!!document.querySelector(".message-app-reference")');
    assert.equal(await read('remoteCommands.filter(command=>command.payload.action==="open").length'), 1, 'a new remote loop does not automatically reopen the prior App');
    assert.equal(await read('localRuntimeCalls'), localCalls, 'remote plugin describe/open/observe never uses the local Runtime');
    await read('clearFixture()');
    await until('remoteCommands.some(command=>command.payload.action==="close")');
    console.log('Remote tool outputs passed: shared plugin panel, server media/attachments, scoped follow-up messages and no local Runtime access.');
    console.log('MCP Apps UI passed: on-demand App references, local/remote Turn gating, final outputs, on-demand image previews, output selection, file-summary ordering, loading/recovery, top-layer expansion/Esc, retained iframe state, intrinsic/legacy sizing, host context, theme/canvas, sandbox/CSP, overlapping requests, correlated results and permission races.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
