const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    renderView(null);
    crypto.randomUUID ??= require('node:crypto').randomUUID;
    window.modelScope='conversation-model-fixture';
    window.clearModelFixture=scope=>{
      for(const id of ['','a','b','c','untouched','loading']) views.selectConversationModel('',id,scope);
    };
    clearModelFixture(modelScope);clearModelFixture(modelScope+'-other');
    localStorage.setItem(modelScope+':cardbush.selected_model','a');
    window.conversationModels=views.normalizeManagedModelConfigs([
      {id:'a',modelName:'same-name',provider:'custom',baseUrl:'https://a.test/v1',apiKey:'',apiProtocol:'openai_responses',reasoningEffort:'low'},
      {id:'b',modelName:'same-name',provider:'custom',baseUrl:'https://b.test/v1',apiKey:'',apiProtocol:'anthropic_messages',reasoningEffort:'high'},
      {id:'c',modelName:'other-model',provider:'custom',baseUrl:'https://c.test/v1',apiKey:'',apiProtocol:'openai_chat_completions',reasoningEffort:'medium'}
    ]);
    window.modelRequests=[];window.modelQueued=[];window.finishModelStreams=[];
    window.modelSession=id=>({id,title:id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    window.makeModelBackend=scope=>({
      scope,fetchGoalRuntimeStatus:async()=>({enabled:false}),
      fetchPendingInteraction:async()=>null,onRuntimeInteractionsChanged:()=>()=>{},
      fetchConversations:async()=>[],fetchMessages:async()=>[],fetchExperimentalGoals:async()=>[],
      createConversation:async input=>modelSession(input.sessionId),updateConversation:async input=>modelSession(input.sessionId),
      queue:{enqueue:async request=>{modelQueued.push({sessionId:request.sessionId,id:request.modelConfig.id,reasoning:request.reasoningLevel});}},
      streamChat:request=>{
        modelRequests.push({sessionId:request.sessionId,id:request.modelConfig.id,name:request.model,
          url:request.modelConfig.baseUrl,protocol:request.modelConfig.apiProtocol,reasoning:request.reasoningLevel});
        request.onStart({turnId:'turn-'+request.sessionId,messageId:'reply-'+request.sessionId});
        return new Promise(resolve=>{
          const finish=()=>resolve();finishModelStreams.push(finish);
          if(request.signal.aborted)finish();else request.signal.addEventListener('abort',finish,{once:true});
        });
      }
    });
    window.ModelConversationFixture=({scope=modelScope,initialSession='a',initialDefault='a',initialReady=true})=>{
      const [session,setSession]=React.useState(initialSession);
      const [defaultModelId,setDefault]=React.useState(initialDefault);
      const [models,setModels]=React.useState(conversationModels);
      const [modelsReady,setModelsReady]=React.useState(initialReady);
      const backend=React.useMemo(()=>makeModelBackend(scope),[scope]);
      window.switchModelSession=setSession;window.changeModelDefault=setDefault;window.replaceConversationModels=setModels;window.finishModelLoad=()=>setModelsReady(true);
      window.conversationChat=views.useCardbushChat(models,models,{
        activeConversationId:session,runtimeReady:false,defaultModelId,modelsReady
      },backend);
      return h('output',{'data-conversation':session},conversationChat.selectedModel);
    };
    renderView(h(ModelConversationFixture));
  `);
  await until('conversationChat.selectedModel==="a" && views.readConversationModel("a",modelScope)==="a"', 'first session remembers the default without a manual choice');
  await run('switchModelSession("untouched")');
  await until('views.readConversationModel("untouched",modelScope)==="a"', 'another untouched session captures its own default');
  await run('switchModelSession("b")');
  await until('views.readConversationModel("b",modelScope)==="a"', 'second session loaded');
  await run('conversationChat.setSelectedModel("b")');
  await until('conversationChat.selectedModel==="b" && conversationChat.reasoningLevel==="high"', 'second session selects its own model and effort');
  await run('switchModelSession("a")');
  await until('conversationChat.selectedModel==="a" && conversationChat.reasoningLevel==="low"', 'switching restores first session selection');
  assert.equal(await run('localStorage.getItem(modelScope+":cardbush.selected_model")'), 'a', 'session selection never changes the global default');

  // Start both real hook sends while viewing A. B must use its own endpoint,
  // protocol and reasoning setting; leave streams open to exercise the queue.
  await run('window.modelSendA=conversationChat.sendMessage("first A",modelSession("a"));window.modelSendB=conversationChat.sendMessage("first B",modelSession("b"));undefined');
  await until('modelRequests.length===2', 'two independent conversations dispatch concurrently');
  assert.deepEqual(await run('modelRequests'), [
    {sessionId:'a',id:'a',name:'same-name',url:'https://a.test/v1',protocol:'openai_responses',reasoning:'low'},
    {sessionId:'b',id:'b',name:'same-name',url:'https://b.test/v1',protocol:'anthropic_messages',reasoning:'high'},
  ]);
  await run('conversationChat.sendMessage("queued B",modelSession("b"))');
  await until('modelQueued.length===1', 'background session queues input');
  assert.deepEqual(await run('modelQueued'), [{sessionId:'b',id:'b',reasoning:'high'}]);

  await run('changeModelDefault("c")');
  await pause();
  assert.equal(await run('conversationChat.selectedModel'), 'a', 'new-session default cannot overwrite an existing choice');
  await run('switchModelSession("untouched")');
  await until('conversationChat.selectedModel==="a"', 'default changes also preserve untouched existing sessions');
  await run('switchModelSession("c")');
  await until('conversationChat.selectedModel==="c"', 'new session uses the new default');
  await run('switchModelSession("a")');
  await until('conversationChat.selectedModel==="a"', 'return to A');
  await run('window.oldModelSetter=conversationChat.setSelectedModel;switchModelSession("b")');
  await until('conversationChat.selectedModel==="b"', 'B selected before delayed edit');
  await run('oldModelSetter("c")');
  await pause();
  assert.equal(await run('conversationChat.selectedModel'), 'b', 'a delayed selection for A cannot write into B');
  assert.equal(await run('views.readConversationModel("a",modelScope)'), 'c');
  assert.equal(await run('modelRequests[0].id'), 'a', 'an in-flight request keeps its captured model');
  await run('finishModelStreams.forEach(finish=>finish());Promise.all([modelSendA,modelSendB])');
  await until('conversationChat.sending===false', 'both fixture turns finished');
  await run('renderView(null)'); await pause();
  await run('renderView(h(ModelConversationFixture,{initialSession:"b",initialDefault:"c"}))');
  await until('conversationChat.selectedModel==="b"', 'remount restores B instead of the global default');
  await run('replaceConversationModels(conversationModels.filter(model=>model.id!=="b"))');
  await until('conversationChat.selectedModel==="c"', 'deleted model safely falls back to available default');
  await run('replaceConversationModels(conversationModels)');
  await until('conversationChat.selectedModel==="b"', 'a temporary catalog absence does not erase the session preference');
  await run('renderView(null)'); await pause();
  await run('renderView(h(ModelConversationFixture,{scope:modelScope+"-other",initialSession:"b",initialDefault:"a"}))');
  await until('conversationChat.selectedModel==="a"', 'same session ID on another host has independent configuration');
  await run('renderView(null)'); await pause();

  await run('renderView(h(ModelConversationFixture,{initialSession:"loading",initialDefault:"a",initialReady:false}))');
  await pause();
  assert.equal(await run('views.readConversationModel("loading",modelScope)'), '', 'cached configuration cannot pin a stale default before initial load');
  await run('changeModelDefault("b");finishModelLoad()');
  await until('conversationChat.selectedModel==="b" && views.readConversationModel("loading",modelScope)==="b"', 'first session selection uses the loaded default');
  await run('renderView(null)'); await pause();

  // The normal local controller owns navigation internally. Draft choices
  // must transfer to the created session and never leak into the next draft.
  // A null controlled ID lets the hook own the session selection.
  await run('renderView(h(ModelConversationFixture,{initialSession:null,initialDefault:"c"}))');
  await until('conversationChat.selectedModel==="c"', 'new draft uses configured default');
  await run('conversationChat.setSelectedModel("b")');
  await until('conversationChat.selectedModel==="b"', 'draft model changed');
  await run('window.createdModelDraft=conversationChat.prepareConversation()');
  await until('conversationChat.selectedModel==="b" && views.readConversationModel(createdModelDraft.id,modelScope)==="b"', 'created conversation inherits draft choice');
  await run('conversationChat.clearConversationSelection()');
  await until('conversationChat.selectedModel==="c"', 'next draft returns to default');
  await run('renderView(null);views.selectConversationModel("",createdModelDraft.id,modelScope);clearModelFixture(modelScope);clearModelFixture(modelScope+"-other");localStorage.removeItem(modelScope+":cardbush.selected_model")');
  console.log('Conversation models passed: concurrent requests, target-specific queues, default isolation, delayed choices, remount, host isolation and drafts.');
};
