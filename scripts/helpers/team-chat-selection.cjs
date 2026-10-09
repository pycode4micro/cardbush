const assert = require('node:assert/strict');

// Verify the real request boundary as well as the rendered chip: a later
// workspace default cannot retarget an authored workflow or resurrect one.
module.exports = async ({ run, until, pause }) => {
  await run(`
    renderView(null);
    crypto.randomUUID ??= require('node:crypto').randomUUID;
    window.teamRequests=[];window.teamHistory={};window.teamConversations=[];
    window.completeTeamRequest=async request=>{
      const turnId='turn-'+teamRequests.length, sessionId=request.sessionId;
      const content=request.content??request.userInput;
      teamRequests.push({content,teamId:request.teamId,teamModeEnabled:request.teamModeEnabled,teamInstructions:request.teamInstructions});
      request.onStart?.({sessionId,turnId,userMessageId:'message_user_'+turnId,createdAt:new Date().toISOString()});
      const team=views.selectedTeamReference(content);
      teamHistory[sessionId]=[
        {id:'message_user_'+turnId,messageId:'message_user_'+turnId,turnId,conversationId:sessionId,role:'user',content,createdAt:new Date().toISOString(),
          metadata:team?{team_id:team.id,team_name:team.title,composerReferenceContent:content}:{}},
        {id:'message_assistant_'+turnId,messageId:'message_assistant_'+turnId,turnId,conversationId:sessionId,role:'assistant',content:'已处理',createdAt:new Date().toISOString()}];
      request.onMessages?.(teamHistory[sessionId],true);
    };
    window.teamChatBackend={scope:'team-chat-selection',
      fetchGoalRuntimeStatus:async()=>({enabled:false}),fetchExperimentalGoals:async()=>[],
      fetchPendingInteraction:async()=>null,onRuntimeInteractionsChanged:()=>()=>{},fetchTeamFlow:async()=>null,
      fetchConversations:async()=>teamConversations,
      createConversation:async input=>{const value={id:input.sessionId,title:input.title||'Team test',preview:'',updatedAt:new Date().toISOString()};teamConversations.push(value);return value;},
      updateConversation:async(id,change)=>({...teamConversations.find(item=>item.id===id),...change}),
      fetchMessages:async sessionId=>teamHistory[sessionId]||[],fetchSessionMessages:async sessionId=>({messages:teamHistory[sessionId]||[]}),
      streamChat:completeTeamRequest,editMessage:completeTeamRequest};
    const TeamChatFixture=()=>{
      const [defaultTeam,setDefaultTeam]=React.useState('team-1');window.setTeamChatDefault=setDefaultTeam;
      window.teamChat=views.useCardbushChat([{id:'fixture',modelName:'fixture',provider:'custom',enabled:true}],[{id:'fixture',modelName:'fixture',provider:'custom',enabled:true}],
        {runtimeReady:false,teamModeEnabled:true,selectedTeamId:defaultTeam,selectedTeamName:defaultTeam,selectedTeamInstructions:views.teamReferenceInstructions(defaultTeam)},teamChatBackend);
      return h('output',null,teamChat.error||'');
    };
    renderView(h(TeamChatFixture));
  `);
  await until('window.teamChat?.selectedModel==="fixture"', 'real Team request hook ready');
  await run('void teamChat.sendMessage(views.promptReferenceMarkdown({kind:"team",id:"team-0",title:"品牌宣传团队"})+" 完成文案")');
  await until('teamRequests.length===1 && !teamChat.sending && teamChat.activeMessages.some(message=>message.role==="assistant" && message.messageId)', 'initial Team turn saved');
  assert.equal(await run('teamChat.error'), null);
  assert.equal(await run('teamRequests[0].teamId'), 'team-0');
  assert.equal(await run('teamRequests[0].teamModeEnabled'), true);
  assert.match(await run('teamRequests[0].teamInstructions'), /Selected reusable Team: team-0\./);

  await run('setTeamChatDefault("team-2")'); await pause(30);
  await run('void teamChat.regenerateAssistantMessage(teamChat.activeMessages.find(message=>message.role==="assistant"))');
  await until('teamRequests.length===2 && !teamChat.sending', 'regenerate original Team turn');
  assert.equal(await run('teamChat.error'), null);
  assert.equal(await run('teamRequests[1].teamId'), 'team-0');
  assert.match(await run('teamRequests[1].teamInstructions'), /Selected reusable Team: team-0\./);

  await run('void teamChat.editUserMessageAndRegenerate(teamChat.activeMessages.find(message=>message.role==="user"),"由当前 Agent 直接回答")');
  await until('teamRequests.length===3 && !teamChat.sending', 'remove Team while editing');
  assert.equal(await run('teamChat.error'), null);
  assert.equal(await run('teamRequests[2].teamId'), undefined);
  assert.equal(await run('teamRequests[2].teamModeEnabled'), false);
  assert.equal(await run('teamRequests[2].teamInstructions'), undefined);
  assert.equal(await run('teamChat.activeMessages.find(message=>message.role==="user").metadata?.team_id'), undefined);

  await run('void teamChat.editUserMessageAndRegenerate(teamChat.activeMessages.find(message=>message.role==="user"),views.promptReferenceMarkdown({kind:"team",id:"team-1",title:"库存团队"})+" 查一下库存")');
  await until('teamRequests.length===4 && !teamChat.sending', 'change Team while editing');
  assert.equal(await run('teamChat.error'), null);
  assert.equal(await run('teamRequests[3].teamId'), 'team-1');
  assert.match(await run('teamRequests[3].teamInstructions'), /Selected reusable Team: team-1\./);
  await run('renderView(null)');
  console.log('Team request routing passed: explicit selection beats defaults, regeneration keeps original identity, edits replace/remove routing and metadata.');
};
