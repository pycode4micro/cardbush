const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    window.startupReads=0;window.startupSubscriptions=0;window.startupFrames=[];window.startupSends=[];
    window.cardbushDesktop={...window.cardbushDesktop,
      runtimeStartupStatus:()=>{startupReads++;return new Promise(resolve=>window.resolveStartup=resolve);},
      onRuntimeStartupStatus:listener=>{startupSubscriptions++;window.emitStartup=listener;return()=>{};},
      retryRuntimeStartup:async()=>{const ready={phase:'ready',attempt:3,startedAt:''};emitStartup(ready);return ready;}
    };
    window.startupProps={compact:true,language:'zh',draft:'继续对话',sending:false,
      selectedModel:'fixture',availableModels:[{id:'fixture',modelName:'Fixture',provider:'custom',apiKey:'',baseUrl:'https://fixture.invalid'}],
      referencePlanAvailable:false,referencePlanMode:'off',permissionMode:'task_free',subagentPermissionRouting:'user',
      reasoningLevelAvailable:false,reasoningLevel:'default',reasoningLevels:[],disabledSkillNames:new Set(),
      onDraftChange:()=>{},onModelChange:()=>{},onReferencePlanModeChange:()=>{},onPermissionModeChange:()=>{},
      onSubagentPermissionRoutingChange:()=>{},onReasoningLevelChange:()=>{},onConfigureModels:()=>{},onToggleSkill:()=>{},
      onSend:async text=>{startupSends.push(text);return true;},onCancel:async()=>{}
    };
    window.StartupComposerFixture=function({session='a',style='standard',remote=false,show=true}){
      const startup=views.useRuntimeStartupStatus();
      React.useLayoutEffect(()=>{
        startupFrames.push({session,phase:startup.phase,
          placeholder:document.querySelector('[data-composer-input]')?.placeholder,
          disabled:document.querySelector('.send-button')?.disabled});
      });
      return h('section',{style:{padding:'40px',width:'820px'}},h('output',{'data-runtime-phase':startup.phase},startup.phase),
        show&&h(views.ConversationHostContext.Provider,{value:remote?{id:'remote',plugins:[],pluginCommands:[]}:undefined},
          h(views.ComposerReferenceContext.Provider,{value:{sessionId:session,browserTabs:[],messages:[]}},
            h(views.ComposerPresentationContext.Provider,{value:{style,preservePermissions:true}},
              h(views.Composer,{...startupProps,key:session})))));
    };
    window.showStartupComposer=props=>renderView(h(StartupComposerFixture,props));
    showStartupComposer({});
  `);
  await until('startupReads===1 && !!document.querySelector("[data-composer-input]")', 'initial startup query');
  assert.match(await run('document.querySelector("[data-composer-input]").placeholder'), /Runtime 正在准备/);
  assert.equal(await run('document.querySelector(".send-button").disabled'), true);
  await run('resolveStartup({phase:"ready",attempt:1,startedAt:""})');
  await until('document.querySelector("output").dataset.runtimePhase==="ready" && !document.querySelector(".send-button").disabled', 'startup ready');
  for (const style of ['standard', 'simple']) {
    for (const session of ['b', 'c', 'a', 'assistant', 'child', 'new-session']) {
      await run(`showStartupComposer({session:${JSON.stringify(session)},style:${JSON.stringify(style)}})`);
      await pause(25);
      assert.ok(!await run('document.querySelector("[data-composer-input]").placeholder.includes("Runtime")'), 'switched composer stays ready');
    }
  }
  const frames = await run('startupFrames.filter(frame=>frame.phase==="ready" && frame.placeholder)');
  assert.ok(frames.length >= 12);
  assert.ok(frames.every(frame => !frame.placeholder.includes('Runtime') && !frame.disabled), 'no preparing placeholder/spinner in the first commit of a new composer');
  assert.equal(await run('startupReads'), 1);
  assert.equal(await run('startupSubscriptions'), 1, 'root and composers share one startup subscription, including StrictMode remounts');
  await run('document.querySelector(".send-button").click()');
  await until('startupSends.length===1', 'sending works immediately after switching');
  await run('emitStartup({phase:"initializing",attempt:2,startedAt:""})');
  await until('document.querySelector("[data-composer-input]").placeholder.includes("Runtime 正在准备")', 'actual restart is still shown');
  await run('showStartupComposer({session:"during-restart",style:"simple"})');
  await until('document.querySelector("[data-composer-input]").placeholder.includes("Runtime 正在准备")', 'switch during real restart stays pending');
  await run('emitStartup({phase:"error",attempt:2,startedAt:"",error:"Fixture startup failure"})');
  await until('document.querySelector("[data-composer-input]").placeholder.includes("启动失败")', 'actual failure is shown');
  assert.equal(await run('document.querySelector(".send-button").disabled'), false, 'failed Runtime can be retried');
  await run('document.querySelector(".send-button").click()');
  await until('document.querySelector("output").dataset.runtimePhase==="ready"', 'retry updates shared readiness');
  await run('showStartupComposer({show:false});emitStartup({phase:"error",attempt:4,startedAt:"",error:"No composer mounted"});showStartupComposer({session:"return"})');
  await until('document.querySelector("[data-composer-input]").placeholder.includes("启动失败")', 'failure while hidden is retained');
  await run('showStartupComposer({session:"remote",remote:true})');
  await until('!document.querySelector("[data-composer-input]").placeholder.includes("Runtime")', 'remote composer bypasses local startup');
  assert.equal(await run('startupSubscriptions'), 1);
  console.log('Runtime composer readiness passed: first-commit session switches, standard/simple input, one shared read/listener, immediate send, real restart/failure/retry, hidden composer and remote host isolation.');
};
