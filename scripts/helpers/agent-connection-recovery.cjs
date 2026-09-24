const assert = require('node:assert/strict');

// Exercise the real shared hook: an idle session has no new stream events to
// clear a stale recovery banner after a failed background status request.
module.exports = async ({ run, until }) => {
  const nav = label => run(`[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent===${JSON.stringify(label)}).click();undefined;`);
  const notice = "document.querySelector('.agent-chat .conversation-connection-notice')";
  await run(`
    snapshots.a=['a1','a2'].map(sessionId=>({sessionId,revision:1,metadata:{title:sessionId},turns:[{
      turnId:'history-'+sessionId,messages:[
        {messageId:'answer-'+sessionId,turnId:'history-'+sessionId,turnSequence:1,messageIndex:0,
         message:{role:'assistant',content:sessionId+' 已完成的回答'},createdAt:'2026-09-22T00:00:03Z'}
      ]}]}));
    window.failStatus=false;window.statusSuccesses=0;
    window.beforeRecoveryCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(id==='a'&&operation==='chat.jobs'){
        if(input.sessionId==='a1'&&failStatus)throw Error('Fixture status socket closed [UND_ERR_SOCKET]');
        const result=await beforeRecoveryCall(id,operation,input);
        if(input.sessionId==='a1')statusSuccesses++;
        return result.filter(job=>job.sessionId===input.sessionId);
      }
      return beforeRecoveryCall(id,operation,input);
    };undefined;
  `);
  await nav('a1');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a1 已完成的回答')&&statusSuccesses>0", 'completed session loaded');
  await run('failStatus=true;undefined;');
  await until(`${notice}?.textContent.includes('Fixture status socket closed')`, 'status failure shows recovery notice');
  await run('window.beforeRecoverySuccesses=statusSuccesses;failStatus=false;undefined;');
  await until('statusSuccesses>beforeRecoverySuccesses', 'status polling recovers with the same revision');
  await until(`!${notice}`, 'successful unchanged status clears the stale recovery notice');
  assert.equal(await run("calls.filter(c=>c.operation==='chat.send').length"), 0, 'status recovery never resends a completed request');

  await run('failStatus=true;undefined;');
  await until(`!!${notice}`, 'second failure is displayed');
  await nav('a2');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a2 已完成的回答')", 'other session still works');
  assert.equal(await run(`!!${notice}`), false, 'status recovery belongs to the affected session');
  await run('failStatus=false;undefined;');
  await nav('a1');
  await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('a1 已完成的回答')", 'return to recovered session');
  await until(`!${notice}`, 'recreated watcher does not retain its previous error');

  // A successful status query is not evidence that a separate event stream has
  // recovered. In particular, it must not erase a newer stream failure.
  await run("jobs.a=[{id:'live-job',sessionId:'a1',turnId:'live-turn',status:'running',text:'后台任务',modelId:'model',createdAt:'2026-09-22T01:00:00Z'}];undefined;");
  await until("readers.some(r=>r.request.turnId==='live-turn'&&!r.stopped)", 'running job attaches its event stream');
  await run('failStatus=true;undefined;');
  await until(`${notice}?.textContent.includes('Fixture status socket closed')`, 'watcher owns the first error');
  await run("readers.find(r=>r.request.turnId==='live-turn'&&!r.stopped).listener({type:'error',error:'Fixture event stream closed'});undefined;");
  await until(`${notice}?.textContent.includes('Fixture event stream closed')`, 'independent event failure replaces the status error');
  await run('window.beforeStreamSuccesses=statusSuccesses;failStatus=false;undefined;');
  await until('statusSuccesses>=beforeStreamSuccesses+2', 'status queries succeed while the event stream is still recovering');
  assert.ok(await run(`${notice}?.textContent.includes('Fixture event stream closed')`), 'status recovery preserves a newer stream recovery notice');
  await run("readers.findLast(r=>r.request.turnId==='live-turn'&&!r.stopped).listener({type:'event',event:{kind:'assistant_segment_delta',sequence:1,payload:{segmentId:'live-answer',delta:'事件流已恢复'}}});undefined;");
  await until(`!${notice}`, 'actual event delivery clears the stream notice');
  assert.equal(await run("calls.filter(c=>c.operation==='chat.send').length"), 0, 'all recovery paths only observe existing work');
  console.log('Agent recovery UI passed: unchanged idle status, session navigation, overlapping stream failures, no resubmission.');
};
