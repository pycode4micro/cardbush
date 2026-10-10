const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await pause(50);
  };
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/team/agent-definition-inspector.css'), 'utf8') + `
    .app:not(#team-detail) {width: 66%!important} #team-detail {position:fixed;right:0;top:0;display:flex;width:34%;height:100vh;background:var(--surface);color:var(--text);border-left:1px solid var(--border)}
  `);
  await run(`
    window.teamCalls=[]; window.teamSends=[]; window.teamOpens=[];
    window.teamRecords=Array.from({length:18},(_,i)=>({revision:1,updatedAt:'2026-10-09',definition:{
      id:'team-'+i,name:i===0?'品牌宣传团队':i===1?'库存团队':'团队 '+i,description:'先并行处理，再汇总结果',max_parallel:2,
      nodes:[{id:'research',agent_id:'researcher',prompt:'PRIVATE_WORKFLOW_INSTRUCTION',depends_on:[]},
        {id:'write',agent_id:'writer',prompt:'根据研究撰写文案',depends_on:['research']}]}}));
    window.teamFixtureClient={command:async(command,decode)=>{
      teamCalls.push(command); const input=command.payload;
      if(input.action==='list') return decode(command.kind==='runtime.agent_registry'?[]:{teams:teamRecords,runs:[]});
      if(input.action==='get' && input.team_id) return decode(teamRecords.find(item=>item.definition.id===input.team_id));
      if(input.action==='get' && input.agent_id) return decode({revision:1,updatedAt:'2026-10-09',definition:{id:input.agent_id,name:'研究员',description:'负责研究',system_prompt:'EMPLOYEE_PROMPT',memory:'user',hooks:[],guards:[],enabled:true}});
      throw Error('Unexpected Team fixture command '+JSON.stringify(command));
    }};
    const detail=document.createElement('aside');detail.id='team-detail';detail.className='app theme-dark';document.body.append(detail);
    const teamDetailCreateRoot=require(${JSON.stringify(require.resolve('react-dom/client'))}).createRoot;
    window.teamDetailRoot=teamDetailCreateRoot(detail);
    addEventListener('cardbush:open-work-summary-inspector',event=>{
      teamOpens.push(event.detail);window.teamTab=views.workSummaryInspectorTab(event.detail,'zh');
      teamDetailRoot.render(h(views.WorkSummaryInspector,{detail:event.detail,messages:[],language:'zh'}));
    });
    window.teamInput=()=>document.querySelector('[data-composer-input]');
    updateChat({loading:false,historyLoading:false,language:'zh',activeConversationId:'team-fixture',welcomeEnabled:false,
      messages:[],draft:'',sending:false,activeTurnId:'',permissionMode:'all_free',teamAvailable:true,
      availableModels:[{id:'fixture',modelName:'Test model',provider:'fixture',enabled:true}],selectedModel:'fixture',
      onDraftChange:draft=>updateChat({draft}),onSend:async text=>{
        teamSends.push(text);const resolved=await views.resolvePromptReferenceContext(text,'team-fixture');
        updateChat({draft:'',messages:[{id:'user-team',role:'user',conversationId:'team-fixture',content:views.authoredPromptContent(resolved.content,resolved.metadata),metadata:resolved.metadata,createdAt:new Date().toISOString()}]});
      }});
  `);
  await until('!!teamInput() && teamCalls.length>0', 'Team catalog ready');
  const openPicker = async () => {
    await run('updateChat({draft:""})');
    await until('teamInput()?.tagName==="TEXTAREA"', 'plain input before command');
    await run('teamInput().focus()'); await window.webContents.insertText('/team');
    await until(`!!document.querySelector('[data-command-id="/team"]')`, '/team command offered');
    await key('Enter');
    await until('document.activeElement===document.querySelector(".composer-team-picker input")', 'Team picker owns focus after delayed composer frames');
    await until('document.querySelectorAll(".composer-team-picker [role=option]").length===19', 'all teams are available');
  };
  await openPicker();
  assert.deepEqual(await run('teamSends'), [], 'opening /team never sends a message');
  await key('Down'); await key('Down');
  assert.match(await run('document.querySelector(".composer-team-picker .keyboard-active").textContent'), /库存团队/);
  await key('Up');
  assert.match(await run('document.querySelector(".composer-team-picker .keyboard-active").textContent'), /品牌宣传团队/);
  await key('End');
  assert.equal(await run('document.querySelector(".composer-team-picker .popover-list").scrollTop>0'), true, 'keyboard scroll follows last team');
  await key('Down');
  assert.match(await run('document.querySelector(".composer-team-picker .keyboard-active").textContent'), /不使用 Team/);
  await key('Down'); await key('Tab');
  await until('document.querySelector(".composer-team-token > span")?.textContent==="品牌宣传团队"', 'selected Team becomes an inline token');
  await until('document.activeElement===teamInput()', 'focus returns to the rich editor');
  assert.equal(await run('views.selectedTeamReference(chatProps.draft).id'), 'team-0');
  assert.equal(await run('document.querySelector(".composer-team-picker")'), null);
  assert.equal(await run('teamCalls.filter(call=>call.payload.action==="get").length'), 0, 'selection does not eagerly read definitions');
  await window.webContents.insertText('为新品制作文案');
  await run('document.querySelector(".composer-team-token").click()');
  await until('document.querySelectorAll("#team-detail .md-article-section").length===2', 'composer token opens dedicated Team document inspector');
  assert.equal(await run('teamTab.kind'), 'agent-definition');
  assert.equal(await run('teamTab.detail.entity'), 'team');
  assert.deepEqual(await run('teamCalls.filter(call=>call.payload.action==="get").map(call=>call.payload)'), [{action:'get',team_id:'team-0'}]);
  assert.match(await run('document.querySelector("#team-detail").innerText'), /Team · 注册流程/);
  assert.match(await run('document.querySelector("#team-detail .md-article").innerText'), /PRIVATE_WORKFLOW_INSTRUCTION/,'explicit inspection presents task content as part of the document');
  assert.equal(await run('document.querySelector("#team-detail .md-presentation-body").dataset.mode'),'document');
  // Keyboard activation of the token views the workflow rather than sending it.
  await run('document.querySelector(".composer-team-token").focus()'); await key('Enter');
  assert.equal(await run('teamSends.length'), 0);
  await run('document.querySelector(".send-button").click()');
  await until('teamSends.length===1 && !!document.querySelector(".message-row.user .context-reference-token")', 'sent Team is a clickable bubble reference');
  assert.equal(await run('document.querySelectorAll(".message-row.user .context-reference-token").length'), 1, 'metadata badge does not duplicate the inline Team');
  await run('document.querySelector(".message-row.user .context-reference-token").click()');
  assert.equal(await run('teamOpens.at(-1).entityId'), 'team-0');
  await run('document.querySelector("#team-detail .agent-definition-nodes > details summary").click();document.querySelector("#team-detail .agent-definition-nodes > details button").click()');
  await until(`!!document.querySelector('#team-detail [aria-label="员工详情"]')`, 'workflow members open independent employee details');
  assert.equal(await run('teamOpens.at(-1).entity'), 'employee');
  await run('document.querySelector(".message-row.user .context-reference-token").click()');
  await until(`!!document.querySelector('#team-detail [aria-label="Team 详情"]')`, 'return to Team details');

  await openPicker();
  await window.webContents.insertText('库存');
  await until('document.querySelectorAll(".composer-team-picker [role=option]").length===2', 'Team search');
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true}))');
  assert.equal(await run('!!document.querySelector(".composer-team-picker")'), true, 'IME confirmation does not choose or send');
  await key('Enter');
  await until('views.selectedTeamReference(chatProps.draft)?.id==="team-1"', 'search chooses the matching Team');
  await run('document.querySelector(".composer-team-token button").click()');
  await until('!document.querySelector(".composer-team-token")', 'remove Team reference');
  assert.equal(await run('views.selectedTeamReference(chatProps.draft)'), undefined);
  await openPicker(); await key('Escape');
  await until('!document.querySelector(".composer-team-picker") && document.activeElement===teamInput()', 'Escape returns focus without choosing');
  assert.equal(await run('views.selectedTeamReference(chatProps.draft)'), undefined);

  // A default is captured into each submission, and an explicit selection wins.
  await run('views.selectTeam("team-1");updateChat({draft:"使用默认团队"})');
  await until('!!document.querySelector(".composer-team-chip")', 'workspace default visible');
  await run('document.querySelector(".send-button").click()');
  await until('teamSends.length===2', 'default team submitted');
  assert.equal(await run('views.selectedTeamReference(teamSends[1]).id'), 'team-1');
  await run('updateChat({draft:teamSends[0]})');
  await until('document.querySelector(".composer-team-token > span")?.textContent==="品牌宣传团队"', 'draft/history restores explicit Team');
  assert.equal(await run('document.querySelector(".composer-team-chip")'), null, 'the default cannot obscure the explicit workflow');
  await run('document.querySelector(".send-button").click()');
  await until('teamSends.length===3', 'restored Team submitted');
  assert.equal(await run('views.selectedTeamReference(teamSends[2]).id'), 'team-0');
  await run('views.selectTeam("");updateChat({draft:teamSends[0]})');
  await until('!!document.querySelector(".composer-team-token")', 'restore reference for appearance');
  await pause();
  fs.writeFileSync(path.join(root, 'tmp/team-composer-dark.png'), (await window.webContents.capturePage()).toPNG());
  await run('window.viewTheme="theme-light";document.getElementById("team-detail").className="app theme-light";updateChat({draft:chatProps.draft})');
  await pause();
  fs.writeFileSync(path.join(root, 'tmp/team-composer-light.png'), (await window.webContents.capturePage()).toPNG());

  // References are portable in local/remote views, without falling back to a
  // local runtime when the conversation supplies its own inspector service.
  await run('window.remoteTeamOpens=[];views.openPromptReference({kind:"team",id:"team-0",title:"品牌宣传团队"},{sessionId:"remote-session",openWorkSummary:detail=>remoteTeamOpens.push(detail)},"wrong-session")');
  assert.deepEqual(await run('remoteTeamOpens[0]'), {kind:'agent-definition',entity:'team',entityId:'team-0',sessionId:'remote-session',title:'品牌宣传团队'});
  await run('views.openPromptReference({kind:"team",id:"team-0",title:"品牌宣传团队"})');
  assert.equal(await run('teamOpens.at(-1).sessionId'), '', 'new-chat Team references do not require a saved conversation');
  console.log('Team composer passed: native arrows/Tab/Enter/Escape, search/IME, inline references, removal, submission/history, default isolation, dedicated Team/member inspector and host routing.');
};
