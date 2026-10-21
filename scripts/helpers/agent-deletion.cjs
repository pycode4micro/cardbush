const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run(`snapshots.a=[{sessionId:'delete-one',metadata:{title:'Delete one'},turns:[]},
    {sessionId:'delete-two',metadata:{title:'Delete two'},turns:[]}];
    snapshots.b=[{sessionId:'delete-one',metadata:{title:'Other host'},turns:[]}];
    window.deleteRequests=[];window.deleteGate=new Map();window.deleteBaseCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='sessions.delete'){
        deleteRequests.push({id,...input});
        await new Promise((resolve,reject)=>deleteGate.set(id+':'+input.sessionId,{resolve,reject}));
      }
      if(operation==='sessions.list'&&window.deleteHoldList){
        window.deleteHoldList=false;const value=structuredClone(snapshots[id]);
        await new Promise(resolve=>window.deleteReleaseList=resolve);return value;
      }
      if(operation==='sessions.list'&&window.deleteFailList)throw Error('List temporarily unavailable');
      return deleteBaseCall(id,operation,input);
    };
    fixtureAgentConnections.select('a','delete-one');
    window.deleteSetup=Promise.all([fixtureAgentConnections.refreshSessions('a'),fixtureAgentConnections.refreshSessions('b')]);void 0;`);
  await until("fixtureAgentConnections.sessionsByAgent.a?.sessions.length===2&&fixtureAgentConnections.sessionsByAgent.b?.sessions.length===1", 'initial lists');
  await run(`sessionStorage.setItem('cardbush-agent-draft:a:delete-one','Retain until acknowledged');
    window.deleteHoldList=true;window.deleteOldRead=fixtureAgentConnections.refreshSessions('a');void 0;`);
  await until("typeof deleteReleaseList==='function'", 'older list request paused');
  await run(`window.deletePending=fixtureAgentConnections.deleteSession('a','delete-one');void 0;`);
  await until("!fixtureAgentConnections.sessionsByAgent.a.sessions.some(s=>s.sessionId==='delete-one')&&fixtureAgentConnections.selectedSessions.a===''", 'delete updates the foreground before server acknowledgement');
  assert.equal(await run("[...document.querySelectorAll('[data-agent-id=a] .remote-conversation')].some(n=>n.textContent.includes('Delete one'))"), false);
  assert.equal(await run("sessionStorage.getItem('cardbush-agent-draft:a:delete-one')"), 'Retain until acknowledged');
  await run("fixtureAgentConnections.deleteSession('a','delete-one');fixtureAgentConnections.select('b','delete-one');deleteReleaseList();void 0");
  await pause(100);
  assert.equal(await run('deleteRequests.length'), 1, 'repeat delete shares one mutation');
  assert.equal(await run("fixtureAgentConnections.sessionsByAgent.a.sessions.length"), 1, 'late list cannot resurrect deletion');
  assert.equal(await run("fixtureAgentConnections.sessionsByAgent.b.sessions.length"), 1, 'same session ID on another host survives');
  await run("deleteGate.get('a:delete-one').resolve();void 0");
  await until("snapshots.a.length===1&&sessionStorage.getItem('cardbush-agent-draft:a:delete-one')===null", 'background deletion confirmed');
  await run('deletePending');
  assert.equal(await run('fixtureAgentConnections.selectedId'), 'b', 'completion never changes newer navigation');

  await run(`sessionStorage.setItem('cardbush-agent-draft:a:delete-two','Preserve failed deletion draft');
    fixtureAgentConnections.select('a','delete-two');
    window.deleteFailure=fixtureAgentConnections.deleteSession('a','delete-two');void 0;`);
  await until('fixtureAgentConnections.sessionsByAgent.a.sessions.length===0', 'second deletion is optimistic');
  await run("fixtureAgentConnections.select('b','delete-one');deleteGate.get('a:delete-two').reject(Error('Deletion denied'));void 0");
  await until("fixtureAgentConnections.sessionsByAgent.a.sessions.length===1&&fixtureAgentConnections.sessionsByAgent.a.error==='Deletion denied'", 'explicit rejection restores the entry and exposes the error');
  assert.equal(await run('fixtureAgentConnections.selectedId'), 'b', 'rollback never steals focus');
  assert.equal(await run("sessionStorage.getItem('cardbush-agent-draft:a:delete-two')"), 'Preserve failed deletion draft');

  await run("window.deleteLast=fixtureAgentConnections.deleteSession('a','delete-two');void 0");
  await until('deleteRequests.length===3', 'retry dispatches once');
  await run("window.deleteFailList=true;deleteGate.get('a:delete-two').resolve();void 0");
  await run('deleteLast');
  assert.equal(await run('snapshots.a.length'), 0);
  assert.equal(await run('fixtureAgentConnections.sessionsByAgent.a.sessions.length'), 0, 'post-commit refresh failure cannot undo confirmed deletion');
  assert.equal(await run('fixtureAgentConnections.sessionsByAgent.b.sessions.length'), 1);
  console.log('PASS Agent deletion: immediate removal, delayed acknowledgement, stale polls, duplicate clicks, host isolation, failure recovery, retained drafts and stable navigation.');
};
