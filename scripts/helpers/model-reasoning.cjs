const assert = require('node:assert/strict');

// Mount the real conversation hook: identity changes must affect the request
// setting immediately, including while a save for another model is pending.
module.exports = async ({ run, until, pause }) => {
  await run(`
    renderView(null);
    // The isolated data: document lacks secure-context UUIDs used by real app pages.
    crypto.randomUUID ??= require('node:crypto').randomUUID;
    localStorage.setItem('cardbush.reasoning_level','max');
    localStorage.setItem('reasoning-fixture:cardbush.reasoning_level','max');
    localStorage.removeItem('reasoning-fixture:cardbush.selected_model');
    views.selectConversationModel('', '', 'reasoning-fixture');
    window.reasoningModels=views.normalizeManagedModelConfigs([
      {id:'a',modelName:'same-name',provider:'custom',baseUrl:'https://a.test/v1',apiKey:'',reasoningEffort:'low'},
      {id:'b',modelName:'same-name',provider:'custom',baseUrl:'https://b.test/v1',apiKey:'',reasoningEffort:'high'},
      {id:'c',modelName:'provider-default',provider:'custom',baseUrl:'https://c.test/v1',apiKey:''}
    ]);
    window.reasoningWrites=[];
    window.reasoningBackend={scope:'reasoning-fixture',fetchGoalRuntimeStatus:async()=>({enabled:false})};
    window.ReasoningFixture=()=>{
      const [models,setModels]=React.useState(reasoningModels);
      window.reasoningReplaceModels=setModels;
      window.reasoningChat=views.useCardbushChat(models,models,{
        runtimeReady:false,
        onModelReasoningChange:(id,effort)=>{
          if(window.failReasoningSave)throw Error('fixture save failed');
          reasoningWrites.push({id,effort});
          return new Promise(resolve=>{window.finishReasoningSave=()=>{
            setModels(current=>{const next=current.map(model=>model.id===id?{...model,reasoningEffort:effort}:model);window.reasoningModels=next;return next;});
            resolve();
          };});
        }
      },reasoningBackend);
      return h('output',{'data-model-reasoning':reasoningChat.selectedModel},reasoningChat.reasoningLevel);
    };
    renderView(h(ReasoningFixture));
  `);
  await until('window.reasoningChat?.selectedModel==="a" && reasoningChat.reasoningLevel==="low"', 'first model uses own effort despite old global preference');
  await run('reasoningChat.setSelectedModel("b")');
  await until('reasoningChat.selectedModel==="b" && reasoningChat.reasoningLevel==="high"', 'same-name model uses its distinct configured effort');
  await run('reasoningChat.setSelectedModel("c")');
  await until('reasoningChat.selectedModel==="c" && reasoningChat.reasoningLevel==="default"', 'unset model does not inherit global or previous model');
  await run('reasoningChat.setSelectedModel("a")');
  await until('reasoningChat.selectedModel==="a"', 'return to first model');
  await run('reasoningChat.setReasoningLevel("medium");reasoningChat.setSelectedModel("b")');
  await until('reasoningWrites.length===1 && reasoningChat.selectedModel==="b"', 'save pending while switching models');
  assert.deepEqual(await run('reasoningWrites'), [{id:'a',effort:'medium'}]);
  assert.equal(await run('reasoningChat.reasoningLevel'), 'high');
  await run('finishReasoningSave()');
  await until('reasoningModels[0].reasoningEffort==="medium"', 'pending save resolves for original model');
  assert.equal(await run('reasoningChat.reasoningLevel'), 'high');
  await run('reasoningChat.setSelectedModel("a")');
  await until('reasoningChat.reasoningLevel==="medium"', 'return restores saved effort');
  await run('window.failReasoningSave=true;reasoningChat.setReasoningLevel("max")');
  await until('reasoningChat.error?.includes("fixture save failed")', 'save failure is reported');
  assert.equal(await run('reasoningChat.reasoningLevel'), 'medium', 'failed save preserves last durable value');
  await run('window.failReasoningSave=false;reasoningChat.setReasoningLevel("default")');
  await until('reasoningWrites.length===2', 'provider default write');
  assert.deepEqual(await run('reasoningWrites[1]'), {id:'a',effort:null}, 'default explicitly clears model effort');
  await run('finishReasoningSave()');
  await until('reasoningChat.reasoningLevel==="default"', 'default uses no explicit strength');
  await run('reasoningChat.setSelectedModel("b")');
  await until('reasoningChat.reasoningLevel==="high"', 'default reset does not affect another model');
  await run('renderView(null)'); await pause();
  await run('renderView(h(ReasoningFixture))');
  await until('reasoningChat.selectedModel==="b" && reasoningChat.reasoningLevel==="high"', 'remount restores selected model and its effort');
  await run('renderView(null);views.selectConversationModel("", "", "reasoning-fixture");localStorage.removeItem("cardbush.reasoning_level");localStorage.removeItem("reasoning-fixture:cardbush.reasoning_level");localStorage.removeItem("reasoning-fixture:cardbush.selected_model")');
  await run(`
    views.selectConversationModel('b','regular-chat');
    views.selectConversationModel('','personal-assistant');
    window.AssistantModelFixture=()=>{
      const [models,setModels]=React.useState(reasoningModels),[session,setSession]=React.useState('regular-chat');
      window.switchRegularSession=setSession;
      window.assistantControls=views.useAssistantModel(models,'a',async(id,effort)=>{
        reasoningWrites.push({id,effort});
        setModels(current=>current.map(model=>model.id===id?{...model,reasoningEffort:effort}:model));
      },'zh');
      window.regularChat=views.useCardbushChat(models,models,{runtimeReady:false,defaultModelId:'a',activeConversationId:session},
        {fetchGoalRuntimeStatus:async()=>({enabled:false}),fetchPendingInteraction:async()=>null,onRuntimeInteractionsChanged:()=>()=>{}});
      return h('output',{'data-assistant-model':assistantControls.selectedModel},assistantControls.reasoningLevel);
    };
    renderView(h(AssistantModelFixture));
  `);
  await until('window.assistantControls?.selectedModel==="a" && regularChat.selectedModel==="b"', 'assistant reads its own default, not the ordinary conversation selection');
  await run('assistantControls.onModelChange("c")');
  await until('assistantControls.selectedModel==="c" && assistantControls.reasoningLevel==="default"', 'assistant switches its own model');
  assert.equal(await run('regularChat.selectedModel'), 'b');
  await run('regularChat.prepareAssistantRequest().then(value=>{window.preparedAssistant=value})');
  assert.equal(await run('preparedAssistant.modelConfig.id'), 'c', 'actual assistant request matches its composer');
  assert.equal(await run('preparedAssistant.model'), 'provider-default');
  assert.equal(await run('preparedAssistant.sessionId'), 'personal-assistant');
  await run('assistantControls.onModelChange("a")');
  await until('assistantControls.selectedModel==="a"', 'assistant model switched');
  await run('assistantControls.onReasoningLevelChange("high")');
  await until('assistantControls.reasoningLevel==="high"', 'reasoning belongs to the selected assistant model');
  assert.deepEqual(await run('reasoningWrites.at(-1)'), {id:'a',effort:'high'});
  await run('switchRegularSession("different-chat")');
  await until('regularChat.activeConversationId==="different-chat"', 'ordinary conversation navigation');
  await run('regularChat.setSelectedModel("c")');
  await until('regularChat.selectedModel==="c"', 'ordinary chat switches independently');
  await run('regularChat.prepareAssistantRequest().then(value=>{window.preparedAssistant=value})');
  assert.equal(await run('preparedAssistant.modelConfig.id'), 'a');
  assert.equal(await run('preparedAssistant.reasoningLevel'), 'high');
  await run('renderView(null)'); await pause();
  await run('renderView(h(AssistantModelFixture))');
  await until('assistantControls.selectedModel==="a" && regularChat.selectedModel==="b"', 'assistant selection survives remount without changing ordinary conversations');
  await run('renderView(null)');
  console.log('Model reasoning passed: same-name isolation, switching, pending saves, failed saves, provider default, remount, assistant-owned model/reasoning controls and matching prepared requests.');
};
