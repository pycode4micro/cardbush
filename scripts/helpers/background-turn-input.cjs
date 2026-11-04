const assert = require('node:assert/strict');

// Exercise the mounted conversation hook, including the background watcher.
module.exports = async ({ run, until }) => {
  await run(`
    renderView(null);
    crypto.randomUUID ??= require('node:crypto').randomUUID;
    window.externalInputHistory=[];window.externalInputWatch=null;
    window.externalInputConversation={id:'external-session',title:'External input',updatedAt:'2026-11-04T07:00:00Z'};
    window.externalInputUser={id:'external-user',messageId:'external-user',role:'user',content:'来自飞书的文件请求',
      conversationId:'external-session',turnId:'external-turn',turnSequence:1,messageIndex:1,createdAt:'2026-11-04T07:00:00Z',
      attachments:[{id:'external-file',name:'sample.pdf',type:'document'}]};
    window.externalInputStart={sessionId:'external-session',turnId:'external-turn',userMessageId:'external-user',
      userMessages:[externalInputUser],createdAt:'2026-11-04T07:00:01Z'};
    window.externalInputBackend={scope:'external-input-fixture',
      fetchGoalRuntimeStatus:async()=>({enabled:false}),fetchExperimentalGoals:async()=>[],
      fetchPendingInteraction:async()=>null,onRuntimeInteractionsChanged:()=>()=>{},fetchTeamFlow:async()=>null,
      fetchSkills:async()=>[],fetchSessionContextWindowUsage:async()=>null,fetchSessionWorkspaceChanges:async()=>[],
      fetchConversations:async()=>[externalInputConversation],updateConversation:async(id,change)=>({...externalInputConversation,...change}),
      fetchMessages:async()=>externalInputHistory,fetchSessionMessages:async()=>({messages:externalInputHistory,conversation:externalInputConversation}),
      watchSession:(id,listener)=>{window.externalInputWatch=listener;return()=>{window.externalInputWatch=null;};},
      streamTurnEvents:async request=>{
        window.externalInputRequest=request;
        request.onStart(externalInputStart);
        await new Promise(resolve=>{window.finishExternalInput=resolve;request.signal.addEventListener('abort',resolve,{once:true});});
      }
    };
    function ExternalInputFixture(){
      const chat=views.useCardbushChat([],[],{activeConversationId:'external-session',runtimeReady:true,viewActive:true},externalInputBackend);
      window.externalInputChat=chat;
      return h('section',{id:'external-input-fixture'},chat.activeMessages.map(message=>h('article',{key:message.id,'data-role':message.role},
        message.content,...(message.attachments||[]).map(file=>h('span',{key:file.id},file.name)))));
    }
    renderView(h(ExternalInputFixture));
  `);
  await until('typeof externalInputWatch === "function"', 'external conversation watcher ready');
  await run('externalInputWatch({revision:"running",activeTurnId:"external-turn",queued:[]})');
  await until('document.querySelector("#external-input-fixture [data-role=user]")?.textContent.includes("来自飞书的文件请求")',
    'external user input appears while the provider is still waiting');
  assert.equal(await run('externalInputChat.sending'), true);
  assert.equal(await run('externalInputHistory.length'), 0, 'no committed history is required');
  assert.match(await run('document.querySelector("#external-input-fixture [data-role=user]").textContent'), /sample\.pdf/);
  await run('externalInputRequest.onStart(externalInputStart)');
  assert.equal(await run('document.querySelectorAll("#external-input-fixture [data-role=user]").length'), 1, 'replay does not duplicate the input');
  await run(`
    externalInputHistory=[externalInputUser,{id:'external-answer',messageId:'external-answer',role:'assistant',content:'已处理文件',
      conversationId:'external-session',turnId:'external-turn',turnSequence:1,messageIndex:2,createdAt:'2026-11-04T07:00:02Z'}];
    externalInputRequest.onMessages(externalInputHistory,true);
    externalInputRequest.onDone({turnId:'external-turn',status:'completed',stopped:false,completedAt:'2026-11-04T07:00:03Z'});
    finishExternalInput();
  `);
  await until('document.querySelector("#external-input-fixture")?.textContent.includes("已处理文件") && !externalInputChat.sending', 'final history reconciles');
  assert.equal(await run('document.querySelectorAll("#external-input-fixture [data-role=user]").length'), 1);
  assert.deepEqual(await run('Array.from(document.querySelectorAll("#external-input-fixture article"),node=>node.dataset.role)'), ['user','assistant']);
  assert.equal(await run('externalInputChat.error'), null);
  await run('updateChat({})');
};
