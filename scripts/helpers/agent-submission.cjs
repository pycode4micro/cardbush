const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  const input = '.agent-chat .composer-stack textarea';
  const type = async text => {
    await run(`var editor=document.querySelector(${JSON.stringify(input)});editor.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,${JSON.stringify(text)});
      editor.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
    await until(`document.querySelector(${JSON.stringify(input)})?.value===${JSON.stringify(text)}`, 'draft entered');
  };
  const send = async immediate => run(`document.querySelector(${JSON.stringify(input)}).dispatchEvent(new KeyboardEvent('keydown',
    {key:'Enter',ctrlKey:${!!immediate},bubbles:true,cancelable:true}));undefined;`);
  await run(`failSend=false;fixtureSetGuidanceMode('immediate');
    snapshots.a=[{sessionId:'same-session',revision:1,metadata:{title:'Submission A'},turns:[]}];
    snapshots.b=[{sessionId:'same-session',revision:1,metadata:{title:'Submission B'},turns:[]}];
    window.submissionCalls=[];window.submissionGates=[];window.submissionBase=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='chat.send'){
        submissionCalls.push(structuredClone({id,input}));
        const result=await submissionBase(id,operation,input);
        jobs[id].find(job=>job.id===result.id).status='running';result.status='running';
        await new Promise((resolve,reject)=>submissionGates.push({resolve,reject}));return result;
      }
      return submissionBase(id,operation,input);
    };
    fixtureAgentConnections.select('a');
    window.submissionSetup=Promise.all([fixtureAgentConnections.refreshSessions('a'),fixtureAgentConnections.refreshSessions('b')]);undefined;`);
  await until("fixtureAgentConnections.sessionsByAgent.a?.sessions.length===1&&fixtureAgentConnections.sessionsByAgent.b?.sessions.length===1", 'submission session lists');
  await run("fixtureAgentConnections.select('a','same-session');undefined;");
  await pause(200);
  await until(`!!document.querySelector(${JSON.stringify(input)})&&!document.querySelector(${JSON.stringify(input)}).readOnly`, 'A composer ready');
  await type('远程发送原文'); await send();
  await until('submissionGates.length===1', 'server accepted but HTTP acknowledgement delayed');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'','submitted text leaves the editor before the HTTP acknowledgement');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).readOnly`),false,'next draft stays editable during admission');
  await type('远程发送原文');
  await send(true); await pause(80);
  assert.equal(await run('submissionCalls.length'),1,'a pending submission cannot repeat');
  assert.equal(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').length"),0,'the pending text cannot become guidance');
  await run("fixtureAgentConnections.select('b','same-session');undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value===''`, 'B has its own draft');
  await type('B 的新草稿');
  await run("fixtureAgentConnections.select('a','same-session');undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='远程发送原文'`, 'A next draft survives remount');
  await send(true);
  await run('submissionGates[0].resolve();undefined;');
  await until("!document.querySelector('.agent-chat .send-button').disabled", 'acknowledgement releases admission');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'远程发送原文','late acknowledgement must not erase a newly typed identical draft');
  assert.equal(await run('submissionCalls.length'),1);
  assert.equal(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').length"),0);

  // The server accepted B's request, but its HTTP receipt was lost. Polling may
  // already see it running when Enter retries the restored draft in immediate mode.
  await run("fixtureAgentConnections.select('b','same-session');undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='B 的新草稿'`, 'B draft retained');
  await run(`fixtureSetDraftContext([{kind:'preview-selection',content:'Selected remote file lines',requestId:'selection-b'}]);
    var transfer=new DataTransfer();transfer.items.add(new File(['Original attachment'], 'original.txt',{type:'text/plain'}));
    document.querySelector(${JSON.stringify(input)}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));undefined;`);
  await until("!!document.querySelector('.agent-chat .composer-file-attachment')&&!document.querySelector('.agent-chat .send-button').disabled", 'B attachment uploaded');
  await send(); await until('submissionGates.length===2', 'B send admitted');
  assert.equal(await run("document.querySelectorAll('.agent-chat .composer-file-attachment').length"),0,'submitted attachment leaves composer');
  const failedId = await run('submissionCalls[1].input.requestId');
  await run("submissionGates[1].reject(Error('Acknowledgement lost'));undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='B 的新草稿'`, 'unmodified draft restored after lost receipt');
  assert.equal(await run("document.querySelectorAll('.agent-chat .composer-file-attachment').length"),1,'failed submission restores its attachment');
  assert.equal(await run('fixtureDraftContext[0]?.requestId'),'selection-b','failed submission restores its reference context');
  await until("readers.some(r=>r.id==='b'&&!r.stopped)", 'poll observes B running', 5000);
  await send(true); await until('submissionGates.length===3', 'uncertain send retried as original request');
  assert.equal(await run('submissionCalls[2].input.requestId'),failedId,'lost receipt keeps the original request ID');
  assert.deepEqual(await run('submissionCalls[2].input'),await run('submissionCalls[1].input'),'retry preserves attachments and reference context exactly');
  assert.equal(await run('submissionCalls[2].input.queueOnly'),undefined,'retry cannot turn the original request into a new queued job');
  assert.equal(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').length"),0,'running poll cannot reroute an uncertain send into guidance');
  await run('submissionGates[2].resolve();undefined;');
  await until(`document.querySelector(${JSON.stringify(input)})?.value===''&&!document.querySelector('.agent-chat .send-button').disabled`, 'retry accepted');
  assert.equal(await run('jobs.b.length'),1,'only one durable job exists');

  // A genuinely new instruction is still guidance. Its admission lock must
  // survive leaving the chat, and its late receipt must leave a new draft alone.
  await run(`window.guidanceGates=[];window.guidanceBase=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      const result=await guidanceBase(id,operation,input);
      if(operation==='runtime.command'&&input.kind==='runtime.get_user_message'&&window.holdGuidanceLookup){
        window.holdGuidanceLookup=false;await new Promise(resolve=>window.releaseGuidanceLookup=resolve);
      }
      if(operation==='runtime.command'&&input.kind==='runtime.enqueue_guidance')
        await new Promise((resolve,reject)=>guidanceGates.push({resolve,reject}));
      return result;
    };undefined;`);
  await type('真正的新引导'); await send(true);
  await until('guidanceGates.length===1', 'new guidance sent');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'');
  await type('真正的新引导');
  await run("fixtureAgentConnections.select('a','same-session');undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='远程发送原文'`, 'A draft intact');
  await run("fixtureAgentConnections.select('b','same-session');undefined;");
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='真正的新引导'`, 'B next draft intact');
  await send(true); await pause(80);
  assert.equal(await run('guidanceGates.length'),1,'pending guidance cannot duplicate after remount');
  await run('guidanceGates[0].resolve();undefined;');
  await until("!document.querySelector('.agent-chat .send-button').disabled", 'guidance accepted');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'真正的新引导','late guidance receipt cannot erase next identical draft');

  await type('下一次发送'); await send(true);
  await until('guidanceGates.length===2', 'second guidance pending');
  await type('保留正在编辑的新内容');
  await run("guidanceGates[1].reject(Error('Guidance receipt lost'));undefined;");
  await until("!document.querySelector('.agent-chat .send-button').disabled", 'guidance failure settled');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'保留正在编辑的新内容','failed submission cannot restore over newer text');
  await type('下一次发送');
  await run("window.holdGuidanceLookup=true;document.querySelector('.agent-chat .guidance-retry-button').click();undefined;");
  await until("typeof releaseGuidanceLookup==='function'", 'explicit guidance retry pending');
  await type('编辑下一条'); await type('下一次发送');
  await run('releaseGuidanceLookup();undefined;');
  await until("!document.querySelector('.agent-chat .guidance-retry-button')", 'guidance retry accepted');
  assert.equal(await run(`document.querySelector(${JSON.stringify(input)}).value`),'下一次发送','late retry receipt cannot erase retyped text');
  console.log('PASS Agent submission: delayed/lost receipts, immediate draft clearing, continued typing, identical next drafts, scoped remount, idempotent retries and explicit guidance.');
};
