const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({run, until, pause, window, root}) => {
  const projected = await run(`(()=>{
    const turn={turnId:'turn',status:'completed',createdAt:'2026-09-16T00:00:00Z',completedAt:'2026-09-16T00:00:10Z',messages:[
      {role:'user',content:'<subagent_result>human example</subagent_result>'},
      {role:'assistant',content:'Parent progress'},
      {role:'user',name:'subagent_result',content:'legacy child context'},
      {role:'user',name:'subagent_result',visibility:'internal',content:'new child context'},
      {role:'user',name:'turn_guidance',content:'real user guidance'},
      {role:'assistant',content:'Parent result'},
    ].map((message,index)=>({messageId:'m'+index,turnId:'turn',turnSequence:1,messageIndex:index,createdAt:'2026-09-16T00:00:0'+index+'Z',message}))};
    const visible=views.projectRuntimeTurnMessages(turn,'parent');
    return {ids:visible.map(message=>message.id),human:visible[0].content,guidance:visible[2].metadata.turn_guidance,stored:turn.messages.length};
  })()`);
  assert.deepEqual(projected.ids,['m0','m1','m4','m5'], 'live completion and history projections exclude old and new child messages');
  assert.match(projected.human,/human example/);
  assert.equal(projected.guidance,true,'real user guidance remains visible');
  assert.equal(projected.stored,6,'UI projection keeps the original journal intact');
  await run(`
    window.loopOpened=[]; window.loopReads=0; window.loopDetailReads=0; window.loopMoreTasks=[];
    addEventListener('cardbush:open-work-summary-inspector', event=>loopOpened.push(event.detail));
    window.loopTask={protocol:'bush.subagent_task.v1',taskId:'child-1',parentSessionId:'parent',parentTurnId:'loop-turn',
      childSessionId:'child',childTurnId:'child-turn',prompt:'PRIVATE CHILD INPUT',finalResponse:'PRIVATE CHILD OUTPUT',
      status:'running',revision:1,inheritContext:true,inheritedMessageCount:10,errorMessage:'',usage:{},
      createdAt:'2026-09-16T00:00:00Z',updatedAt:'2026-09-16T00:00:01Z'};
    window.loopFixtureClient={listSubagentTasks:async()=>{loopReads++; return structuredClone([loopTask,...loopMoreTasks]);},
      listTurnToolExecutions:async()=>{loopDetailReads++;return [{sessionId:'parent',turnId:'loop-turn',round:1,ordinal:2,recordedAt:'2026-09-16T00:00:02Z',
        outcome:'returned',toolCall:{id:'agent',name:'subagent',arguments:{prompt:'PRIVATE CHILD INPUT'}},
        result:{taskId:'child-1',status:'running',finalResponse:'PRIVATE CHILD OUTPUT'},workspaceChanges:[]}];}};
    window.loopImage={id:'image',name:'preview.png',type:'image',path:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
    window.loopExecutions=[
      {id:'shell',name:'terminal_exec',summary:'Check files',state:'completed',success:true,metadata:{}},
      {id:'image',name:'inject_image_input',summary:'inject_image_input',state:'completed',success:true,artifacts:[loopImage],metadata:{}},
      {id:'agent',name:'subagent',summary:'subagent',state:'completed',success:true,metadata:{nativeResultDeferred:true}},
    ].map((item,index)=>({...item,output:'',durationMs:10,createdAt:'2026-09-16T00:00:0'+index+'Z',
      turnId:'loop-turn',assistantMessageId:'loop-reply',sequence:index+2,contentOffset:0}));
    window.loopReply={id:'loop-reply',role:'assistant',content:'Parent continues working.',turnId:'loop-turn',conversationId:'parent',
      createdAt:'2026-09-16T00:00:01Z',status:'streaming',toolExecutions:loopExecutions};
    window.loopInput={id:'human',role:'user',content:'Build the report',turnId:'loop-turn',conversationId:'parent',createdAt:'2026-09-16T00:00:00Z'};
    window.loopResult={...loopInput,id:'internal-result',createdAt:'2026-09-16T00:00:03Z',metadata:{name:'subagent_result'},
      content:'<subagent_result task_id="child-1">PRIVATE CHILD OUTPUT</subagent_result>'};
    window.showLoop=(status='streaming')=>{
      loopReply={...loopReply,status};
      const messages=views.normalizeChatMessagesForDisplay([loopInput,loopReply,loopResult]);
      renderView(h('div',{style:{width:'100%'}},messages.map(message=>h(views.MessageBubble,{key:message.id,message,language:'zh',
        sending:status==='streaming',activeTurnId:status==='streaming'?'loop-turn':'',activeAssistantMessageId:'loop-reply',
        onOpenScene:()=>{},onRevertChangeReport:async()=>{}}))));
    };
    window.showArchivedLoop=()=>renderView(h(views.AssistantLoopHistoryBlock,{history:[{...loopReply,status:'completed'}],
      language:'zh',active:false,onOpenScene:()=>{},onRevertChangeReport:async()=>{}}));
    showLoop();
  `);
  await until("document.querySelector('.loop-subagent-preview')?.textContent.includes('运行中') && !document.querySelector('.loop-subagent-preview').disabled", 'child execution preview follows the actual running task');
  assert.equal(await run("document.querySelectorAll('.message-row.user').length"), 1, 'child input is never a user bubble');
  assert.doesNotMatch(await run('document.body.innerText'), /PRIVATE CHILD|subagent_result/);
  assert.equal(await run("document.querySelector('.tool-execution-summary').textContent.includes('1 项操作')"), true, 'only ordinary tools count in the tool list');
  assert.equal(await run("document.querySelector('.loop-execution-previews').previousElementSibling.classList.contains('tool-execution-block')"), true, 'previews occupy the row after ordinary tools');
  assert.equal(await run("document.querySelector('.loop-execution-previews').getBoundingClientRect().top >= document.querySelector('.tool-execution-block').getBoundingClientRect().bottom"), true);
  await run("document.querySelector('.tool-execution-summary').click()");
  await until("document.querySelector('.tool-execution-details')!==null", 'ordinary tool list expands');
  assert.equal(await run("document.querySelectorAll('.tool-execution-details [data-execution-id]').length"), 1, 'image input and subagent dispatch do not appear twice');
  const click = async selector => {
    const point = await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  await click('.loop-subagent-preview');
  await until('loopOpened.length===1', 'native click opens the child task inspector');
  assert.equal(await run('loopOpened[0].task.taskId'), 'child-1');
  await click('.loop-execution-previews .tool-image-artifact-button');
  await until("document.querySelector('.image-preview-backdrop')!==null", 'native click opens the image preview');
  await run("document.querySelector('.image-preview-backdrop button[aria-label=\"关闭\"]')?.click(); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); void 0");
  await until("!document.querySelector('.image-preview-backdrop')", 'image preview closes');
  for (const [status,label] of [['completed','已完成'],['failed','执行失败'],['stopped','已停止']]) {
    await run(`loopTask={...loopTask,status:${JSON.stringify(status)},revision:2,updatedAt:'2026-09-16T00:00:05Z',errorMessage:'PRIVATE ERROR'}; dispatchEvent(new Event('focus')); void 0`);
    await until(`document.querySelector('.loop-subagent-preview').textContent.includes(${JSON.stringify(label)})`, 'live task status: '+status);
    assert.doesNotMatch(await run('document.body.innerText'), /PRIVATE CHILD|PRIVATE ERROR|subagent_result/);
  }
  // A finished parent may have a background child. Its state is independent.
  await run("loopTask={...loopTask,status:'running'}; showArchivedLoop(); dispatchEvent(new Event('focus')); void 0");
  await until("document.querySelector('.loop-subagent-preview')?.textContent.includes('运行中')", 'history retains actual child status');
  await run(`
    window.loopImages=Array.from({length:4},(_,index)=>{
      const canvas=document.createElement('canvas'); canvas.width=240; canvas.height=240;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle=['#f8f7f3','#171a24','#231d2c','#222728'][index]; ctx.fillRect(0,0,240,240);
      ctx.fillStyle=['#222','#a5cece','#ddafd8','#d8d3a8'][index]; ctx.font='18px sans-serif';
      ctx.fillText('Preview '+(index+1),16,30);
      for(let y=54;y<225;y+=22) {ctx.globalAlpha=y%3===0?.4:.8;ctx.fillRect(16,y,80+(y%5)*26,7);}
      return {id:'preview',name:'preview-'+index+'.png',type:'image',path:canvas.toDataURL()};
    });
    loopMoreTasks=[{...loopTask,taskId:'child-2',childSessionId:'child-2',agentProfileId:'视觉检查',status:'completed'}];
    loopReply={...loopReply,toolExecutions:loopExecutions.map(item=>item.id==='image'?{...item,artifacts:loopImages}:item).concat([
      {...loopExecutions[1],id:'repeated-image',sequence:5,artifacts:[loopImages[0]]},
      {...loopExecutions[2],id:'wait',name:'await_subagents',sequence:6,metadata:{nativeResult:{taskIds:['child-1','child-2'],status:'completed'}}},
    ])};
    showArchivedLoop(); dispatchEvent(new Event('focus')); void 0;
  `);
  await until("document.querySelectorAll('.loop-subagent-preview').length===2 && document.querySelectorAll('.tool-image-thumbnail img').length===4", 'actual children and images are grouped without duplicate dispatch/wait or image entries');
  await until("[...document.querySelectorAll('.tool-image-thumbnail img')].every(img=>img.complete&&img.naturalWidth===240)", 'all thumbnails decode');
  assert.match(await run("document.querySelector('.loop-image-previews .loop-preview-summary').textContent"), /已查看 4 张图像/);
  assert.match(await run("document.querySelector('.loop-subagent-previews .loop-preview-summary').textContent"), /2 个子 Agent/);

  await click('.loop-subagent-previews .loop-preview-summary');
  await until("document.querySelector('.loop-subagent-previews .loop-preview-summary').getAttribute('aria-expanded')==='false'", 'child group collapses before the image header moves');
  await click('.loop-image-previews .loop-preview-summary');
  await until("document.querySelector('.loop-image-previews .loop-preview-summary').getAttribute('aria-expanded')==='false'", 'image group collapses');
  assert.equal(await run("[...document.querySelectorAll('.loop-execution-preview-group')].every(el=>el.hidden&&el.getClientRects().length===0)"), true, 'collapsed contents take no space');
  await run("loopTask={...loopTask,status:'failed'}; showArchivedLoop(); dispatchEvent(new Event('focus')); void 0");
  await until("document.querySelector('.loop-subagent-previews .loop-preview-summary').textContent.includes('1 项失败')", 'failure remains visible while collapsed');
  assert.equal(await run("[...document.querySelectorAll('.loop-preview-summary')].every(el=>el.getAttribute('aria-expanded')==='false')"), true, 'live status and parent updates do not reopen groups');
  await run("document.querySelector('.loop-image-previews .loop-preview-summary').focus()");
  window.webContents.focus();
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  await until("document.querySelector('.loop-image-previews .loop-preview-summary').getAttribute('aria-expanded')==='true'", 'keyboard expands images');
  assert.equal(await run("document.querySelector('.loop-subagent-previews .loop-preview-summary').getAttribute('aria-expanded')"), 'false', 'image and child groups collapse independently');
  await click('.loop-subagent-previews .loop-preview-summary');
  await until("document.querySelector('.loop-subagent-previews .loop-preview-summary').getAttribute('aria-expanded')==='true'", 'child group expands before choosing its task');
  await click('.loop-subagent-preview[data-task-id="child-2"]');
  await until('loopOpened.length===2', 'grouped child task opens its own inspector');
  assert.equal(await run('loopOpened[1].task.taskId'), 'child-2');
  await run("loopTask={...loopTask,status:'running'}; dispatchEvent(new Event('focus')); void 0");
  await window.webContents.insertCSS(await fs.readFile(path.join(root,'src/styles/themes/cyberpunk.css'),'utf8'));
  for (const theme of ['theme-dark','theme-bright','theme-dark theme-cyberpunk','theme-custom']) {
    await run(`viewTheme=${JSON.stringify(theme)}; showArchivedLoop();`);
    await pause(120);
    if (theme === 'theme-custom') await run(`
      document.querySelector('.app').style.cssText+=';--surface:#302c46;--surface-raised:#39334e;--border:#665977;--text:#f4eefa;--text-mid:#d4c8df;--text-soft:#b7a6c3;--accent:#dfb8ff;background:#242033;'; void 0;
    `);
    assert.equal(await run("document.querySelector('.loop-execution-previews').getBoundingClientRect().width <= document.querySelector('.app').clientWidth"), true);
    assert.equal(await run("[...document.querySelectorAll('.tool-image-thumbnail')].every(el=>{const r=el.getBoundingClientRect();return r.width===78&&r.height===78})"), true, 'thumbnail geometry stays fixed in each theme');
    await fs.writeFile(path.join(root,'tmp/loop-previews-'+theme+'.png'), (await window.webContents.capturePage()).toPNG());
  }
  await run("document.querySelector('.app').style.width='320px'; void 0");
  await pause(100);
  assert.equal(await run("[...document.querySelectorAll('.loop-execution-previews button')].every(el=>el.getBoundingClientRect().right<=document.querySelector('.app').getBoundingClientRect().right+1)"), true, 'preview rows wrap at narrow widths');
  await fs.writeFile(path.join(root,'tmp/loop-previews-narrow.png'), (await window.webContents.capturePage()).toPNG());
  await run(`
    window.thumbnailFallbackReads=0;
    cardbushDesktop.readImageDataUrl=async()=>{thumbnailFallbackReads++; return loopImages[0].path;};
    loopReply={...loopReply,toolExecutions:[{...loopExecutions[1],artifacts:[
      {id:'local',name:'local.png',type:'image',path:'C:/fixture/local.png'},
      {id:'broken',name:'broken.png',type:'image',path:'data:image/png;base64,broken'},
    ]}]}; showArchivedLoop();
  `);
  await until("document.querySelectorAll('.tool-image-thumbnail-fallback').length===1 && document.querySelector('.tool-image-thumbnail img')?.naturalWidth===240", 'local protocol fallback and corrupt image placeholder');
  assert.equal(await run('thumbnailFallbackReads'), 1, 'native fallback is only requested after file protocol failure');
  assert.equal(await run("[...document.querySelectorAll('.tool-image-thumbnail')].every(el=>el.getBoundingClientRect().height===78)"), true, 'failed images preserve thumbnail height');
  // Replay the reported four-image queue through its lifecycle. In the live
  // adapter, success stays false until a tool returns; it does not mean failure.
  await run(`window.phaseImages=Array.from({length:4},(_,index)=>({...loopExecutions[1],
    id:'phase-image-'+index,artifacts:undefined,metadata:{},state:'queued',success:false}));`);
  for (const [state,label,pending] of [
    ['queued','排队中',true], ['running','运行中',true],
    ['awaiting_permission','等待授权',true], ['awaiting_solution','等待方案选择',true],
    ['cancelled','已停止',false], ['failed','执行失败',false],
  ]) {
    await run(`loopReply={...loopReply,toolExecutions:phaseImages.map(item=>({...item,state:${JSON.stringify(state)}}))}; showLoop();`);
    await until(`[...document.querySelectorAll('.loop-image-status')].length===4 &&
      [...document.querySelectorAll('.loop-image-status')].every(el=>el.textContent===${JSON.stringify(label)})`, 'image lifecycle: '+state);
    const summary = await run("document.querySelector('.loop-image-previews .loop-preview-summary').textContent");
    assert.equal(summary.includes('4 项进行中'), pending, state+' only counts active tools as pending');
    assert.equal(summary.includes('4 项失败'), state==='failed', state+' only counts explicit failures');
  }
  await run(`loopReply={...loopReply,toolExecutions:phaseImages.map((item,index)=>({...item,
    state:['queued','running','failed','cancelled'][index]}))}; showLoop();`);
  await until("document.querySelector('.loop-image-previews .loop-preview-summary').textContent.includes('2 项进行中')", 'mixed image states settle independently');
  assert.match(await run("document.querySelector('.loop-image-previews .loop-preview-summary').textContent"), /1 项失败/);
  await run(`loopReply={...loopReply,toolExecutions:phaseImages.map((item,index)=>({...item,
    state:'completed',success:true,artifacts:[loopImages[index]]}))}; showLoop();`);
  await until(`document.querySelector('.loop-image-previews .loop-preview-summary').textContent.includes('已查看 4 张图像') &&
    document.querySelectorAll('.tool-image-thumbnail img').length===4`, 'completed image tools replace status tiles with thumbnails');
  assert.equal(await run("document.querySelectorAll('.loop-image-status').length"), 0);
  assert.doesNotMatch(await run("document.querySelector('.loop-image-previews .loop-preview-summary').textContent"), /进行中|失败/);
  await run('renderView(null)'); await pause();
  const reads = await run('loopReads');
  await run("dispatchEvent(new Event('focus'))"); await pause();
  assert.equal(await run('loopReads'), reads, 'unmount releases status subscriptions');
  console.log('Loop execution previews passed: image/child groups, deduplication, collapse persistence, live status, keyboard/native clicks, thumbnails/fallback, four themes, narrow widths and cleanup.');
};
