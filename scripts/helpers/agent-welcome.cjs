const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, win, root }) => {
  await run(`
    snapshots.a=[normalizeSession({sessionId:'a1',revision:1,metadata:{title:'新会话',projectId:'remote-project',projectDir:'/srv/cloud'},turns:[]})];
    window.welcomeBase=cardbushDesktop.agents.call;window.welcomeSends=0;window.holdWelcomeSend=true;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='projects.list')return {projects:[{id:'remote-project',name:'云端项目',path:'/srv/cloud'}],defaultProjectId:'remote-project'};
      if(operation==='chat.send'){welcomeSends++;if(holdWelcomeSend)await new Promise(resolve=>window.releaseWelcomeSend=resolve)}
      return welcomeBase(id,operation,input);
    };
    [...document.querySelectorAll('.fixture-nav button')].find(button=>button.textContent==='a1').click();undefined;
  `);
  await until("!!document.querySelector('.agent-chat .welcome-composer textarea')", 'remote new conversation uses the shared welcome composer');
  await until("document.querySelector('.welcome-hero h2')?.textContent.includes('云端项目')", 'welcome project comes from the remote Agent');
  await until("calls.some(call=>call.id==='a'&&call.input?.kind==='runtime.list_user_prompts')", 'welcome history is read on the remote host');
  assert.equal(await run("!!document.querySelector('.welcome-input-stack .agent-project-picker')"), true);
  assert.equal(await run("!!document.querySelector('.welcome-composer .workspace-location-control')"), false, 'remote welcome never offers a local filesystem picker');
  assert.equal(await run("document.querySelectorAll('.welcome-suggestion').length"), 3, 'same welcome suggestions as local conversations');
  await pause(100);
  fs.writeFileSync(path.join(root, 'tmp/agent-welcome-dark.png'), (await win.webContents.capturePage()).toPNG());
  await run("document.querySelector('.app').classList.replace('theme-dark','theme-light');undefined;");
  await pause(100);
  fs.writeFileSync(path.join(root, 'tmp/agent-welcome-light.png'), (await win.webContents.capturePage()).toPNG());
  await run(`var field=document.querySelector('.agent-chat textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'首次发送立即显示');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
  await pause(30);
  await run("document.querySelector('.agent-chat .send-button').click();undefined;");
  await until("welcomeSends===1&&document.querySelector('.agent-chat .message-list')?.textContent.includes('首次发送立即显示')", 'first message renders before remote admission');
  assert.equal(await run("!!document.querySelector('.agent-chat .welcome-composer')"), false);
  assert.equal(await run("document.querySelector('.agent-chat .send-button').disabled"), true, 'welcome-to-transcript handoff retains pending admission');
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), '首次发送立即显示', 'draft is retained until acceptance');
  await run("holdWelcomeSend=false;releaseWelcomeSend();undefined;");
  await until("document.querySelector('.agent-chat textarea')?.value===''", 'the accepted welcome draft is cleared after the composer remount');
  assert.equal(await run('welcomeSends'), 1);
  console.log('Agent welcome passed: shared layout and suggestions, host-specific history/projects, theme rendering, optimistic first send and admission handoff.');
};
