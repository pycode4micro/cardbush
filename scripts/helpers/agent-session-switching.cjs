const assert = require('node:assert/strict');
const { nativeImage } = require('electron');

// Real controllers and shared Composer; every delay is released explicitly.
module.exports = async ({ run, until, pause }) => {
  const png = nativeImage.createFromBitmap(Buffer.alloc(32 * 24 * 4, 160), { width: 32, height: 24 }).toPNG().toString('base64');
  const nav = label => run(`[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent===${JSON.stringify(label)}).click();undefined;`);
  const text = () => run("document.querySelector('.agent-chat .message-list')?.textContent || ''");
  const draft = async value => {
    await run(`var field=document.querySelector('.agent-chat textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
    await pause(25);
  };
  const paste = name => run(`var transfer=new DataTransfer();transfer.items.add(new File([Uint8Array.from(atob(switchPng),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'image/png'}));document.querySelector('.agent-chat textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));undefined;`);
  await run(`
    window.switchPng=${JSON.stringify(png)};window.delayedHistory=new Set(['a1','a2']);window.historyReleases=[];
    window.holdDiff=true;window.diffReleases=[];window.holdUpload=false;window.holdAck=false;
    window.makeSwitchSession=(id,title)=>({sessionId:id,revision:1,metadata:{title,runtimeWorkspace:{workspaceDir:'/srv/'+id,mode:'direct',versioning:'none'}},turns:[{
      turnId:'history-'+id,turnSequence:1,messages:[
        {messageId:'user-'+id,turnId:'history-'+id,turnSequence:1,messageIndex:0,message:{role:'user',content:'问题 '+title},createdAt:'2026-09-22T00:00:00Z'},
        {messageId:'answer-'+id,turnId:'history-'+id,turnSequence:1,messageIndex:1,message:{role:'assistant',content:title+' 正文\\n\\n'+Array.from({length:30},(_,i)=>title+' 第 '+i+' 段。').join('\\n\\n')},createdAt:'2026-09-22T00:00:03Z'}
      ]}]});
    snapshots.a=['a1','a2','a3'].map(id=>makeSwitchSession(id,id));snapshots.b=[makeSwitchSession('a2','B 同名会话')];
    window.beforeSwitchCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='runtime.command'&&input.kind==='runtime.list_turn_tool_executions'&&input.payload.detail!=='summary'&&holdDiff){
        calls.push({id,operation,input});await new Promise(resolve=>diffReleases.push(resolve));return [];
      }
      if(operation==='files.upload'&&holdUpload){holdUpload=false;await new Promise(resolve=>window.releaseUpload=resolve)}
      if(operation==='chat.send'&&holdAck){
        calls.push({id,operation,input});await new Promise(resolve=>window.releaseAck=resolve);
        const job={id:input.requestId,sessionId:input.sessionId,turnId:'switch-stream',status:'running',text:input.text,modelId:input.modelId,createdAt:'2026-09-23T01:00:00Z'};
        jobs[id].push(job);return structuredClone(job);
      }
      const result=await beforeSwitchCall(id,operation,input);
      if(operation==='chat.jobs'&&input.sessionId)return result.filter(job=>job.sessionId===input.sessionId);
      if(id==='a'&&operation==='sessions.get'&&delayedHistory.has(input.sessionId))await new Promise(resolve=>historyReleases.push({sessionId:input.sessionId,resolve}));
      return result;
    };undefined;
  `);
  await nav('a1');
  await until("historyReleases.some(r=>r.sessionId==='a1')", 'first history is deliberately held');
  await nav('a2');
  await until("historyReleases.some(r=>r.sessionId==='a2')", 'second history is deliberately held');
  await nav('a3');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a3 正文')", 'latest selection shows history without waiting for older sessions or full diffs');
  assert.equal(await run('diffReleases.length>0'), true, 'full workspace details are still pending');
  await run("delayedHistory.clear();historyReleases.reverse().forEach(r=>r.resolve());undefined;");
  await pause(100);
  assert.ok((await text()).includes('a3 正文'));
  assert.ok(!(await text()).includes('a1 正文'), 'late history cannot select another conversation');
  assert.equal(await run("calls.filter(c=>c.operation==='sessions.update').length"), 0, 'ordinary navigation never promotes or writes metadata');
  await run("holdDiff=false;diffReleases.forEach(resolve=>resolve());undefined;");

  // Cache-first revisit must render even when all new history reads are blocked.
  await run("delayedHistory.add('a1');undefined;");
  await nav('a1');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a1 正文')", 'revisit uses the retained transcript immediately');
  await run("delayedHistory.clear();historyReleases.forEach(r=>r.resolve());undefined;");
  await nav('a3');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a3 正文')", 'return to attachment owner');
  const catalogReads = await run("calls.filter(c=>c.id==='a'&&(c.operation==='conversation.catalog'||c.operation==='product.command'&&c.input.kind==='models.get')).length");
  await draft('A3 待发送');
  await run('holdUpload=true;undefined;'); await paste('a3.png');
  await until("typeof releaseUpload==='function'", 'upload deliberately waits for remote acknowledgement');
  await nav('a2');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a2 正文')", 'navigate during upload');
  await draft('A2 草稿');
  await run('releaseUpload();undefined;'); await pause(100);
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb').length"), 0, 'late A3 upload cannot appear in A2');
  await paste('a2.png');
  await until("document.querySelectorAll('.composer-image-thumb').length===1", 'A2 has its own image');
  await nav('a3');
  await until("document.querySelector('.agent-chat textarea')?.value==='A3 待发送'&&document.querySelectorAll('.composer-image-thumb').length===1", 'return restores the draft and completed upload');
  await run('holdAck=true;document.querySelector(".agent-chat .send-button").click();undefined;');
  await until("typeof releaseAck==='function'", 'send waits for durable admission');
  await nav('a2');
  await until("document.querySelector('.agent-chat textarea')?.value==='A2 草稿'", 'A2 remains editable during A3 admission');
  await draft('A2 新草稿');
  await run('holdAck=false;releaseAck();undefined;');
  await until("readers.some(r=>r.request.turnId==='switch-stream'&&!r.stopped)", 'accepted task owns a persistent reader');
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), 'A2 新草稿');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb').length"), 1, 'A3 acknowledgement cannot clear A2 attachments');
  await run("window.switchReader=readers.find(r=>r.request.turnId==='switch-stream'&&!r.stopped);undefined;");
  const subscriptions = await run('readers.length');
  await nav('Local view');
  await until("!document.querySelector('.agent-chat')", 'only the active chat retains DOM');
  await run("switchReader.listener({type:'event',event:{kind:'assistant_segment_delta',sequence:1,payload:{segmentId:'switch-live',delta:'后台持续输出'}}});undefined;");
  assert.equal(await run('switchReader.stopped'), false, 'leaving the cloud view cannot cancel delivery');
  await nav('Agent view'); await nav('a3');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('后台持续输出')", 'background text survives local/cloud navigation');
  assert.equal(await run('readers.length'), subscriptions, 'navigation neither restarts the reader nor loses its cursor');
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), '', 'only the accepted draft is cleared');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb').length"), 0);
  assert.equal(await run("calls.filter(c=>c.operation==='chat.send').length"), 1, 'navigation never resubmits work');

  await run("var scroller=document.querySelector('.agent-chat .message-list');scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-160,bubbles:true}));scroller.scrollTop=280;scroller.dispatchEvent(new Event('scroll'));undefined;");
  await pause(80);
  const top = await run("document.querySelector('.agent-chat .message-list').scrollTop");
  assert.ok(top > 0);
  await nav('a2'); await until("document.querySelector('.agent-chat textarea')?.value==='A2 新草稿'", 'draft after repeated switches');
  await nav('a3');
  await until(`Math.abs(document.querySelector('.agent-chat .message-list')?.scrollTop-${top})<4`, 'reading position restores after switching');
  assert.equal(await run("calls.filter(c=>c.id==='a'&&(c.operation==='conversation.catalog'||c.operation==='product.command'&&c.input.kind==='models.get')).length"), catalogReads, 'switching does not reload host catalogs');
  await nav('Select B');
  await until("!!document.querySelector('[data-agent-id=b] .remote-conversation')", 'second host connects');
  await run("document.querySelector('[data-agent-id=b] .remote-conversation').click()");
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('B 同名会话 正文')", 'same raw session ID belongs to the second host');
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), '');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb').length"), 0, 'draft and attachments are namespaced by host');
  await nav('a2');
  await until("document.querySelector('.agent-chat textarea')?.value==='A2 新草稿'", 'original host state survives');
  assert.equal(await run("document.querySelectorAll('.composer-image-thumb').length"), 1);
  assert.equal(await run("calls.some(c=>['chat.stop','disconnect'].includes(c.operation))"), false);
  console.log('Agent switching passed: reordered history, delayed diffs/uploads/admission, cached revisit, scoped drafts/images, background stream, cursor retention, scroll restoration and host isolation.');
};
