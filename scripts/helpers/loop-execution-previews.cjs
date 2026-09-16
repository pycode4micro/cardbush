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
    window.loopOpened=[]; window.loopReads=0; window.loopDetailReads=0;
    addEventListener('cardbush:open-work-summary-inspector', event=>loopOpened.push(event.detail));
    window.loopTask={protocol:'bush.subagent_task.v1',taskId:'child-1',parentSessionId:'parent',parentTurnId:'loop-turn',
      childSessionId:'child',childTurnId:'child-turn',prompt:'PRIVATE CHILD INPUT',finalResponse:'PRIVATE CHILD OUTPUT',
      status:'running',revision:1,inheritContext:true,inheritedMessageCount:10,errorMessage:'',usage:{},
      createdAt:'2026-09-16T00:00:00Z',updatedAt:'2026-09-16T00:00:01Z'};
    window.loopFixtureClient={listSubagentTasks:async()=>{loopReads++; return [structuredClone(loopTask)];},
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
  for (const theme of ['theme-dark','theme-bright']) {
    await run(`viewTheme=${JSON.stringify(theme)}; showArchivedLoop();`);
    await pause(120);
    assert.equal(await run("document.querySelector('.loop-execution-previews').getBoundingClientRect().width <= document.querySelector('.app').clientWidth"), true);
    await fs.writeFile(path.join(root,'tmp/loop-previews-'+theme+'.png'), (await window.webContents.capturePage()).toPNG());
  }
  await run("document.querySelector('.app').style.width='320px'; void 0");
  await pause(100);
  assert.equal(await run("[...document.querySelectorAll('.loop-execution-previews button')].every(el=>el.getBoundingClientRect().right<=document.querySelector('.app').getBoundingClientRect().right+1)"), true, 'preview rows wrap at narrow widths');
  await run('renderView(null)'); await pause();
  const reads = await run('loopReads');
  await run("dispatchEvent(new Event('focus'))"); await pause();
  assert.equal(await run('loopReads'), reads, 'unmount releases status subscriptions');
  console.log('Loop execution previews passed: hidden child messages, separate image/subagent previews, real task states, native clicks, both themes, narrow widths and cleanup.');
};
