const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');

// Exercise real AgentChat, Composer, history projection and image viewers with
// the service's message-<requestId> identities and a deliberately open stream.
module.exports = async ({ run, until, pause, win, root }) => {
  const png = nativeImage.createFromBitmap(Buffer.alloc(64 * 40 * 4, 180), { width: 64, height: 40 }).toPNG().toString('base64');
  await run(`
    window.imageBytes=${JSON.stringify(png)};window.imageLocalReads=[];window.imageSends=[];
    window.rejectImageSend=true;window.holdImageSend=false;window.imageRecord=null;
    cardbushDesktop.readImageDataUrl=async path=>{imageLocalReads.push(path);throw Error('Cloud image reached local disk')};
    sessionStorage.removeItem('cardbush-agent-draft:a:same-session');
    sessionStorage.removeItem('cardbush-agent-guidance:a');
    snapshots.a=[{sessionId:'same-session',revision:1,metadata:{title:'图片回归',runtimeWorkspace:{workspaceDir:'/srv/a',mode:'direct',versioning:'none'}},turns:[]}];jobs.a=[];
    window.beforeImageCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(id==='a'&&operation==='chat.send'){
        imageSends.push(structuredClone(input));calls.push({id,operation,input});
        if(rejectImageSend){rejectImageSend=false;throw Error('Image acknowledgement lost')}
        if(holdImageSend)await new Promise(resolve=>window.acceptImageSend=resolve);
        const job={id:input.requestId,sessionId:input.sessionId,turnId:input.turnId||'image-turn',status:'running',text:input.text,modelId:input.modelId,createdAt:'2026-09-23T01:00:00Z'};
        jobs.a.push(job);return structuredClone(job);
      }
      if(id==='a'&&operation==='files.read'&&input.path.endsWith('.png')){
        calls.push({id,operation,input});return {name:input.path.split('/').at(-1),content:imageBytes,size:atob(imageBytes).length,offset:0,done:true};
      }
      if(id==='a'&&operation==='runtime.command'&&imageRecord&&input.payload?.turnId==='image-turn'){
        if(input.kind==='runtime.list_turn_tool_executions'){
          calls.push({id,operation,input});
          if(input.payload.detail==='summary'){const {result,...summary}=imageRecord;return [{...summary,protocol:'bush.tool_execution_summary.v1',resultAvailable:true}]}
          return [imageRecord];
        }
        if(input.kind==='runtime.get_tool_execution'){calls.push({id,operation,input});return imageRecord}
      }
      return beforeImageCall(id,operation,input);
    };
    [...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click();
    undefined;
  `);
  await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Build Agent'&&!!document.querySelector('[data-agent-id=a] .remote-conversation')", 'image regression Agent connects');
  await run("document.querySelector('[data-agent-id=a] .remote-conversation').click()");
  await until("!!document.querySelector('.agent-chat .composer-stack textarea')", 'image regression session opens');
  await run("document.querySelector('.agent-chat .composer-actions .model-select').click()");
  await until("!!document.querySelector('.model-picker-row:not(.primary):not(.secondary)')", 'fixture model is available');
  await run("document.querySelector('.model-picker-row:not(.primary):not(.secondary)').click()");
  const draft = async text => {
    await run(`var field=document.querySelector('.agent-chat .composer-stack textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
    await pause(30);
  };
  const paste = async name => {
    await run(`var transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(imageBytes),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'image/png'}));document.querySelector('.agent-chat .composer-stack textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));undefined;`);
    await until("document.querySelector('.composer-image-thumb img')?.naturalWidth===64", 'pasted cloud image uses the same thumbnail as local input');
  };
  await paste('image.png'); await draft('这张图是什么');
  assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"), '这张图是什么');
  await until("!document.querySelector('.agent-chat .composer-stack .send-button').disabled", 'uploaded image is ready to send');
  await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
  await until("document.querySelector('.agent-chat [role=alert]')?.textContent.includes('Image acknowledgement lost')", 'failed send is visible');
  await until("!document.querySelector('.agent-chat .composer-stack textarea').readOnly", 'failed submission releases the composer');
  assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"), '这张图是什么');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb,.composer-file-attachment').length"), 1, 'an unconfirmed image remains available for retry');
  await run("holdImageSend=true;document.querySelector('.agent-chat .send-button').click()");
  await until("typeof acceptImageSend==='function'", 'retry waits for server acknowledgement');
  assert.equal(await run("document.querySelector('.agent-chat .send-button').disabled"), true, 'cannot duplicate a pending submission');
  await run("holdImageSend=false;acceptImageSend()");
  await until("!document.querySelector('.composer-image-thumb,.composer-file-attachment')&&document.querySelector('.agent-chat .composer-stack textarea').value===''", 'acknowledged image clears while the stream is still running');
  await until("readers.some(r=>r.id==='a'&&r.request.turnId==='image-turn'&&!r.stopped)", 'image response is streaming');
  assert.deepEqual(await run('imageSends[1]'), await run('imageSends[0]'), 'attachment retry keeps the exact durable request');
  assert.equal(await run('jobs.a[0].status'), 'running');
  await paste('next.png'); await draft('下一张暂不发送');
  await run(`
    window.imageReader=readers.find(r=>r.id==='a'&&r.request.turnId==='image-turn'&&!r.stopped);
    const input=imageSends[1], createdAt='2026-09-23T01:00:00Z', completedAt='2026-09-23T01:00:05Z';
    snapshots.a[0].revision=2;snapshots.a[0].updatedAt=completedAt;
    snapshots.a[0].turns=[{turnId:'image-turn',turnSequence:1,createdAt,completedAt,status:'completed',reason:'completed',messages:[
      {messageId:'message-'+input.requestId,createdAt,message:{role:'user',content:input.text},metadata:input.userMessageMetadata},
      {messageId:'message-image-inspect',createdAt,message:{role:'assistant',content:'查看这张图。',toolCalls:[{protocol:'bush.tool_call.v1',id:'view-image-regression',name:'view_image',argumentsText:'{}'}]}},
      {messageId:'message-image-answer',createdAt:completedAt,message:{role:'assistant',content:'已读取服务器上的图片。',toolCalls:[]}}
    ]}];
    snapshots.a[0].turns[0].messages.forEach((message,index)=>Object.assign(message,{turnId:'image-turn',turnSequence:1,messageIndex:index}));
    imageRecord={protocol:'bush.tool.execution_record.v2',requestId:input.requestId,sessionId:'same-session',turnId:'image-turn',assistantMessageId:'message-image-inspect',round:1,ordinal:0,recordedAt:completedAt,
      toolCall:{protocol:'bush.tool_call.v1',id:'view-image-regression',name:'view_image',argumentsText:'{}'},outcome:'returned',result:{artifacts:[{type:'image',path:'/srv/a/uploads/image.png',name:'image.png'}]},workspaceChanges:[]};
    imageReader.listener({type:'event',event:{kind:'assistant_segment_completed',sequence:1,payload:{messageId:'message-image-inspect',segmentId:'image-inspect',ordinal:1,content:'查看这张图。'}}});
    imageReader.listener({type:'event',event:{kind:'tool_returned',sequence:2,payload:{assistantMessageId:'message-image-inspect',toolCallId:'view-image-regression',toolName:'view_image',ordinal:0}}});
    undefined;
  `);
  await until("document.querySelector('.loop-image-previews img')?.naturalWidth===64", 'deferred tool thumbnail reads the cloud image');
  assert.equal(await run("document.querySelector('.loop-image-previews img').src.startsWith('blob:')"), true);
  assert.deepEqual(await run('imageLocalReads'), [], 'cloud thumbnails never invoke local image readers');
  await run("document.querySelector('.loop-image-previews .tool-image-artifact-button').click()");
  await until("document.querySelector('.image-preview-dialog img')?.naturalWidth===64", 'tool image opens in the shared cloud-backed preview');
  fs.writeFileSync(path.join(root, 'tmp/agent-tool-image-preview.png'), (await win.webContents.capturePage()).toPNG());
  await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until("!document.querySelector('.image-preview-dialog')", 'tool image preview closes');
  await run(`
    jobs.a[0].status='completed';jobs.a[0].completedAt='2026-09-23T01:00:05Z';
    imageReader.listener({type:'event',event:{kind:'assistant_segment_completed',sequence:3,payload:{messageId:'message-image-answer',segmentId:'image-answer',ordinal:1,content:'已读取服务器上的图片。'}}});
    imageReader.listener({type:'event',event:{kind:'turn_terminal',sequence:4,payload:{status:'completed',reason:'completed',finalMessageId:'message-image-answer',details:{}}}});
    imageReader.listener({type:'end'});undefined;
  `);
  await until("!!document.querySelector('.message-actions button[title=编辑并重跑]:not(:disabled)')", 'completed cloud message is editable');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb,.composer-file-attachment').length"), 1, 'finishing the previous Turn preserves the next image');
  assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"), '下一张暂不发送');
  // Check persisted history too, after unmounting live optimistic state.
  await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Overview').click()");
  await until("!!document.querySelector('.agents-overview')", 'leave the image conversation');
  await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click()");
  await until("!!document.querySelector('.agent-chat [data-work-summary-toggle]')", 'reopen cloud history');
  await run("document.querySelector('.agent-chat [data-work-summary-toggle]').click()");
  await until("!!document.querySelector('.work-summary-history-turn')", 'history details are available');
  await run("document.querySelector('.work-summary-history-turn').click()");
  await until("document.querySelector('.loop-image-previews img')?.naturalWidth===64", 'cloud tool image survives history reload');
  await run("document.querySelector('[aria-label=关闭审查]').click()");
  await run("document.querySelector('.message-actions button[title=编辑并重跑]').click()");
  await until("!!document.querySelector('.user-edit-card textarea')", 'edit existing remote message');
  await run("var field=document.querySelector('.user-edit-card textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'请重新描述这张图');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
  await pause(30);
  await run("document.querySelector('.message-edit-actions .primary-button').click()");
  await until('imageSends.length===3', 'update and rerun submits exactly one replacement Turn');
  const replacement = await run('imageSends[2]');
  assert.ok(replacement.turnId.startsWith('turn_'));
  assert.equal(replacement.text, '请重新描述这张图');
  assert.equal(replacement.supersession.reason, 'user_edit_regenerate');
  assert.ok(replacement.supersession.messageIds.includes('message-' + (await run('imageSends[1].requestId'))));
  assert.ok([...(replacement.files ?? []), ...(replacement.images ?? [])].includes('/srv/a/uploads/image.png'), 'rerun retains the original image');
  assert.equal(await run("document.body.textContent.includes('未定位到原消息')"), false);
  assert.deepEqual(await run('imageLocalReads'), []);
  await pause(150);
  fs.writeFileSync(path.join(root, 'tmp/agent-image-regressions.png'), (await win.webContents.capturePage()).toPNG());
  console.log('Agent image regressions passed: durable IDs, admission-time clearing, failed retry, next-draft preservation and remote tool previews.');
};
