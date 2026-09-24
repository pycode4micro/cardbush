const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, win, root }) => {
  await run(`(async () => {
    window.handshakeFails=true;
    window.statusBaseConnect=cardbushDesktop.agents.connect;
    cardbushDesktop.agents.connect=async id=>{
      if(id==='a'&&handshakeFails)throw Error('Timed out while waiting for handshake');
      return statusBaseConnect(id);
    };
    connections=connections.map(c=>c.id==='a'?{...c,sshTunnel:{connectionId:'ssh-a',remoteHost:'127.0.0.1',remotePort:4780},connectionState:'reconnecting',connectionError:'Timed out while waiting for handshake'}:c);
    snapshots.a=[{sessionId:'a1',revision:1,metadata:{title:'保留的会话'},turns:[{turnId:'history-a1',messages:[
      {messageId:'question-a1',turnId:'history-a1',turnSequence:1,messageIndex:0,message:{role:'user',content:'已有问题'},createdAt:'2026-09-22T00:00:00Z'},
      {messageId:'answer-a1',turnId:'history-a1',turnSequence:1,messageIndex:1,message:{role:'assistant',content:'已有回答'},createdAt:'2026-09-22T00:00:03Z'}
    ]}]}];
    [...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='a1').click();undefined;
  })();`);
  await until("document.querySelector('.agent-connection-status')?.textContent.includes('正在自动重连')", 'initial handshake failure is presented as ongoing recovery');
  assert.equal(await run("!!document.querySelector('.agents-view [role=alert], [data-agent-id=a] [role=alert]')"), false, 'managed recovery has no duplicate red/sidebar alerts');
  assert.equal(await run("document.querySelector('.agent-connection-status details').open"), false, 'technical detail is collapsed by default');
  assert.equal(await run("document.querySelector('.agents-view').innerText.includes('Timed out while waiting for handshake')"), false, 'raw handshake text is not the primary message');
  await run(`(async () => {
    handshakeFails=false;
    const info=await cardbushDesktop.agents.connect('a');
    connections=connections.map(c=>c.id==='a'?{...c,connected:true,connectionState:'connected',connectionError:undefined,info}:c);
    await refreshAgentConnections();undefined;
  })();`);
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('已有回答')", 'background connection success automatically loads the chosen session');
  await until("document.querySelector('.agent-connection-status.recovered')?.textContent.includes('连接已恢复')", 'successful recovery has feedback');
  await until("!document.querySelector('[data-agent-id=a] .agent-sidebar-notice')", 'sidebar recovers without another click');
  await run(`(async () => {
    window.retainedStatusComposer=document.querySelector('.agent-chat textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(retainedStatusComposer,'重连时保留的草稿');
    retainedStatusComposer.dispatchEvent(new Event('input',{bubbles:true}));
    window.readsBeforeRecovery=calls.filter(c=>c.id==='a'&&c.operation==='conversation.catalog').length;
    handshakeFails=true;
    connections=connections.map(c=>c.id==='a'?{...c,connected:false,connectionState:'reconnecting',connectionError:'Timed out while waiting for handshake'}:c);
    await refreshAgentConnections();undefined;
  })();`);
  await until("document.querySelector('.agent-connection-status')?.textContent.includes('当前会话和草稿已保留')", 'established conversation gets nonblocking recovery feedback');
  assert.equal(await run("document.querySelector('.agent-chat textarea')===retainedStatusComposer"), true, 'reconnection does not remount the composer');
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), '重连时保留的草稿');
  assert.ok(await run("document.querySelector('.agent-chat .message-list').textContent.includes('已有回答')"), 'transcript remains readable while reconnecting');
  await pause(100); fs.writeFileSync(path.join(root,'tmp/agent-reconnecting-status.png'),(await win.webContents.capturePage()).toPNG());
  await run(`(async () => {
    handshakeFails=false;
    connections=connections.map(c=>c.id==='a'?{...c,connected:true,connectionState:'connected',connectionError:undefined}:c);
    await refreshAgentConnections();undefined;
  })();`);
  await until("calls.filter(c=>c.id==='a'&&c.operation==='conversation.catalog').length>readsBeforeRecovery", 'restoration refreshes remote capabilities');
  await until("document.querySelector('.agent-connection-status.recovered')?.textContent.includes('连接已恢复')", 'second recovery is also acknowledged');
  await until("!document.querySelector('.agent-connection-status')", 'recovered notice clears automatically', 5000);
  assert.equal(await run("document.querySelector('.agent-chat textarea').value"), '重连时保留的草稿');
  assert.equal(await run("calls.some(c=>['chat.send','chat.stop','sessions.create','sessions.delete','disconnect'].includes(c.operation))"), false, 'recovery reads status without replaying work or closing the host');
  await run("(async () => { connections=connections.map(c=>c.id==='a'?{...c,connected:false,connectionState:'disconnected',connectionError:'SSH 身份验证失败，请检查凭据。'}:c);await refreshAgentConnections(); })();");
  await until("document.querySelector('.agents-view [role=alert]')?.textContent.includes('身份验证失败')", 'terminal authentication failure still asks for intervention');
  assert.equal(await run("!!document.querySelector('.agent-connection-status')"), false, 'terminal failure does not claim automatic recovery');
  console.log('Agent connection status passed: neutral retries, collapsed detail, automatic load/refresh, retained draft and transcript, success feedback, terminal failures, no replay.');
};
