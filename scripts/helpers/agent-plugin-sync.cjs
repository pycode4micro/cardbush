const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ run, until, pause, win, root }) => {
  await run(`cardbushDesktop.agents.syncCatalog=async()=>[
    {id:'computer-use',name:'Computer Use',version:'1.0.0',source:'bundled'},
    {id:'chrome',name:'Browser Use',version:'2.1.0',source:'bundled'},
    {id:'knowledge-library',name:'资料库',version:'0.1.0',source:'user'},
    {id:'video-face-stylizer',name:'视频去真人化',version:'0.2.3',source:'user'}];
    window.syncAttempts=[];window.failSync=true;
    cardbushDesktop.agents.syncConfiguration=async id=>{syncAttempts.push(id);if(failSync)throw Error('同步暂时失败，请重试');return {digest:'fixture',warnings:[]}};
    window.savedAgentInputs=[];cardbushDesktop.agents.save=async input=>{
      savedAgentInputs.push(input);var value={...input,id:input.id||'sync-fixture',hasToken:true};
      connections=[...connections.filter(c=>c.id!==value.id),value];snapshots[value.id]??=[];jobs[value.id]??=[];return connections;
    };cardbushDesktop.sshConnections={list:async()=>[{id:'ssh-sync',name:'Windows host',username:'fixture',host:'fixture.invalid',port:22}]};
    document.querySelector('.agents-add').click();undefined;`);
  await until("document.querySelectorAll('.agent-sync-plugin-list input').length===4", 'all installed plugins, including desktop plugins, are listed');
  assert.equal(await run("[...document.querySelectorAll('.agent-sync-plugin-list input')].every(e=>e.checked)"),true);
  assert.equal(await run("document.querySelector('.agent-plugin-sync input').checked"),false,'automatic sync is separate from manual selection');
  assert.equal(await run("document.querySelector('[data-plugin-id=computer-use] input').disabled"),false,'SSH is not treated as Linux');
  await run(`document.querySelector('[data-plugin-id=chrome] input').click();document.querySelector('.agent-plugin-sync input').click();
    var field=document.querySelector('.agents-form > label input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'同步测试');field.dispatchEvent(new Event('input',{bubbles:true}));
    var token=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(token,'fixture-token');token.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
  await until("document.querySelector('.agent-sync-all input').indeterminate",'partial selection has a mixed select-all checkbox');
  await pause(100);
  assert.equal(await run("document.querySelector('.agents-modal').scrollWidth<=document.querySelector('.agents-modal').clientWidth"),true,'no horizontal overflow');
  await run("document.querySelector('.agent-plugin-sync').scrollIntoView({block:'center'})");
  fs.writeFileSync(path.join(root,'tmp/agent-plugin-sync.png'),(await win.webContents.capturePage()).toPNG());
  await run("document.querySelector('button[data-sync=true]').click()");
  await until("document.querySelector('.agents-form .agents-error')?.textContent.includes('同步暂时失败')",'failed manual sync keeps the form and retry action');
  assert.deepEqual(await run("savedAgentInputs[0].excludedPluginIds"),['chrome']);
  assert.equal(await run("savedAgentInputs[0].autoSyncPlugins"),true);
  assert.equal(await run("savedAgentInputs[0].syncSkills"),true);
  await run("failSync=false;document.querySelector('button[data-sync=true]').click()");
  await until("!document.querySelector('.agents-form')",'manual retry succeeds');
  assert.deepEqual(await run("syncAttempts"),['sync-fixture','sync-fixture']);
  assert.equal(await run("savedAgentInputs[1].id"),'sync-fixture','retry updates the saved connection rather than adding another');
  assert.equal(await run("connections.filter(c=>c.id==='sync-fixture').length"),1);
  console.log('PASS Agent plugin selection, opt-in automation, manual sync and stable retry identity');
};
