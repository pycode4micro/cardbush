const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`
    Object.defineProperty(crypto,'randomUUID',{value:require('node:crypto').randomUUID,configurable:true});
    window.feedbackCalls = [];
    window.feedbackFixtureClient = {command(command) {return new Promise((resolve,reject)=>feedbackCalls.push({command,resolve,reject}));}};
    window.cardbushDesktop.agents = {call(connectionId,method,command) {
      return new Promise((resolve,reject)=>feedbackCalls.push({connectionId,method,command,resolve,reject}));
    }};
    window.feedbackMessage = {id:'optimistic-id',messageId:'actual-assistant-id',conversationId:'session-feedback',turnId:'turn-feedback',
      role:'assistant',status:'completed',content:'两个方案的比较已经整理为简洁的表格。',createdAt:'2026-10-10T00:00:00Z'};
    window.feedbackHost = undefined;
    window.renderFeedback = () => renderView(h(views.ConversationHostContext.Provider,{value:feedbackHost},h(views.MessageBubble,{
      message:feedbackMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:'',keepActionsVisible:true,
      onRegenerate:async()=>{},onEditUserMessage:async()=>{},onRetryGuidance:async()=>{},onRevertChangeReport:async()=>{},onOpenScene:()=>{}
    })));
    views.saveIndividuation({habits:true});renderFeedback();
  `);
  await until("!!document.querySelector('.feedback-up')", 'rating controls');
  await run("document.querySelector('.feedback-up').click(); document.querySelector('.feedback-up').click()");
  try { await until('feedbackCalls.length === 1', 'rating persisted'); }
  catch(error) { throw new Error(error.message+'\n'+JSON.stringify(await run('({calls:feedbackCalls,errors:errorDialogs,settings:views.readIndividuation(),crypto:typeof crypto.randomUUID})'))); }
  assert.equal(await run("document.querySelector('.feedback-up').disabled && document.querySelector('.feedback-down').disabled"), true);
  const command=await run('feedbackCalls[0].command');
  assert.equal(command.kind,'runtime.personalization');assert.equal(command.payload.action,'feedback');
  assert.deepEqual(command.payload.feedback,{sessionId:'session-feedback',turnId:'turn-feedback',messageId:'actual-assistant-id',rating:'up'});
  assert.ok(command.payload.operationId);assert.equal(command.payload.settings.habits,true);
  await run("feedbackCalls[0].resolve({status:'ok'})");
  await until("!document.querySelector('.feedback-up').disabled", 'rating saved');
  assert.equal(await run("views.readAssistantFeedback(views.assistantFeedbackKey(feedbackMessage))"),'up');

  await run("feedbackMessage = {...feedbackMessage,id:'reloaded-id'}; renderFeedback()");
  await pause();
  assert.equal(await run("document.querySelector('.feedback-up').getAttribute('aria-pressed')"),'true','reload uses runtime identity');
  await run("document.querySelector('.feedback-down').click()");
  await until('feedbackCalls.length === 2','replace rating');
  assert.equal(await run('feedbackCalls[1].command.payload.feedback.rating'),'down');
  await run("feedbackCalls[1].reject(new Error('fixture connection failed'))");
  await until('errorDialogs.length === 1','persistence failure visible');
  assert.equal(await run("document.querySelector('.feedback-up').getAttribute('aria-pressed')"),'true','failed change restores saved rating');
  await run("document.querySelector('.feedback-down').click()");
  await until('feedbackCalls.length === 3','retry failed rating');
  await run("feedbackCalls[2].resolve({status:'ok'})");
  await until("!document.querySelector('.feedback-down').disabled",'downvote saved');
  await run("document.querySelector('.feedback-down').click()");
  await until('feedbackCalls.length === 4','cancel downvote');
  assert.equal(await run('feedbackCalls[3].command.payload.feedback.rating'),null);
  await run("feedbackCalls[3].resolve({status:'ok'})");
  await until("!document.querySelector('.feedback-down').disabled",'downvote withdrawn');
  assert.equal(await run("JSON.parse(localStorage.getItem('cardbush_assistant_feedback')).length"),0);

  await run("views.saveIndividuation({habits:false}); document.querySelector('.feedback-up').click()");
  await until("views.readAssistantFeedback(views.assistantFeedbackKey(feedbackMessage)) === 'up'",'disabled habits keep local rating');
  assert.equal(await run('feedbackCalls.length'),4,'disabled habits do not write memory');

  await run(`views.saveIndividuation({habits:true});feedbackHost={id:'remote-session',environmentId:'remote-connection',
    plugins:[],pluginCommands:[],toolDetails:async()=>[],uploadFiles:async()=>[],openFile:()=>{}};renderFeedback()`);
  await pause();
  assert.equal(await run("document.querySelector('.feedback-up').getAttribute('aria-pressed')"),'false','remote rating is scoped separately');
  await run("document.querySelector('.feedback-down').click()");
  await until('feedbackCalls.length === 5','remote rating routed');
  assert.equal(await run('feedbackCalls[4].connectionId'),'remote-connection');
  assert.equal(await run('feedbackCalls[4].method'),'runtime.command');
  assert.equal(await run('feedbackCalls[4].command.payload.feedback.sessionId'),'session-feedback');
  await run("feedbackCalls[4].resolve({status:'ok'})");
  await until("!document.querySelector('.feedback-down').disabled",'remote rating saved');
  await run("views.saveIndividuation({habits:false}); document.querySelector('.feedback-down').click()");
  await until('feedbackCalls.length === 6','cancel recorded remote vote even after disabling habits');
  assert.equal(await run('feedbackCalls[5].command.payload.feedback.rating'),null);
  assert.equal(await run('feedbackCalls[5].connectionId'),'remote-connection');
  await run("feedbackCalls[5].resolve({status:'ok'})");
  await until("!document.querySelector('.feedback-down').disabled",'remote cancellation saved');
  await run("feedbackHost=undefined;renderFeedback()");await pause();
  assert.equal(await run("document.querySelector('.feedback-up').getAttribute('aria-pressed')"),'true','remote cancellation preserves local choice');
  console.log('PASS: assistant ratings persist to habit events, deduplicate, roll back, reload and route by host.');
};
