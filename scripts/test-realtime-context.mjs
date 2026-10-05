import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { RealtimeVoiceHistory } from '../dist-electron/realtimeVoiceHistory.js';
import { RealtimeVoiceContext } from '../dist-electron/realtimeVoiceContext.js';
import { RealtimeVoiceService } from '../dist-electron/realtimeVoiceService.js';
import { defaultRealtimeVoiceSettings } from '../dist-electron/realtimeVoiceTypes.js';
import { volcengineRealtimeVoice as provider } from '../dist-electron/volcengineRealtimeVoice.js';
const crypto={encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()};
const root=()=>fs.mkdtempSync(path.resolve('tmp/voice-memory-test-'));
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const pair=i=>({user:`问题 ${i} `+'需要记住的条件。'.repeat(100),assistant:`回答 ${i} `+'已核对的结果。'.repeat(100)});
const items=messages=>messages.map(({id,role,text})=>({id,role,content:[{type:'input_text',text}]}));
function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const history=new RealtimeVoiceHistory(root(),'conversation',crypto), sent=[], jobs=[], status=[];
  for (let i=1;i<=5;i++) history.append(pair(i).user,pair(i).assistant);
  let idle=true,restarts=0;
  const memory=new RealtimeVoiceContext(history,0,{
    send:event=>{const id=`event${sent.length}`;sent.push({...event,event_id:id});return id;},
    create:provider.context,request:job=>jobs.push(job),status:s=>status.push(s),idle:()=>idle,
    restart:async()=>{restarts++;},
  },1000);
  memory.initialContext(100000);
  const ack=(type,data)=>memory.event({type,event_id:sent.at(-1).event_id,items:data});
  return {history,memory,sent,jobs,status,ack,setIdle:v=>{idle=v;memory.tick();},get restarts(){return restarts;}};
}
test('encrypted journal keeps original sources across checkpoints and restores the same conversation only',()=>{
  const dir=root(),history=new RealtimeVoiceHistory(dir,'a',crypto);
  history.seed([{role:'user',text:'private words'},{role:'assistant',text:'old answer'}]);
  history.append('second','second answer');history.checkpoint(1,'short memory');
  history.append('new speech','new answer');
  const restored=new RealtimeVoiceHistory(dir,'a',crypto);
  restored.seed([{role:'user',text:'private words'},{role:'assistant',text:'old answer'}]);
  assert.equal(restored.summary,'short memory');assert.equal(restored.pairs.length,2);
  assert.equal(restored.pairs.at(-1).user,'new speech');assert.equal(restored.revision,1);
  const raw=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8');
  assert.ok(!raw.includes('private words'));assert.match(crypto.decrypt(JSON.parse(raw.split('\n')[0])),/private words/);
  assert.equal(new RealtimeVoiceHistory(dir,'other',crypto).pairs.length,0);
  new RealtimeVoiceHistory(dir,'other',crypto).append('other question','other answer');
  RealtimeVoiceHistory.forget(dir,'a');
  assert.equal(new RealtimeVoiceHistory(dir,'a',crypto).pairs.length,0);
  assert.equal(new RealtimeVoiceHistory(dir,'other',crypto).pairs.length,1);
  fs.writeFileSync(path.join(dir,'unrelated.txt'),'keep');
  RealtimeVoiceHistory.forget(dir);
  assert.equal(new RealtimeVoiceHistory(dir,'other',crypto).pairs.length,0);
  assert.equal(fs.readFileSync(path.join(dir,'unrelated.txt'),'utf8'),'keep');
});
test('snapshot replacement retains speech arriving during compaction and deletes only verified old QA after summary ACK',t=>{
  const f=fixture(t);
  try {
    f.memory.tick();assert.equal(f.jobs.length,1);const job=f.jobs[0];assert.equal(job.through,3);
    f.history.append('new while summarizing','new answer');
    f.setIdle(false);
    f.memory.complete(job.jobId,{...job,summary:'记住旧条件，任务尚未完成。'});
    t.mock.timers.tick(2000);assert.equal(f.sent.length,0,'speech/playback does not get interrupted by editing');
    assert.deepEqual(f.history.pairs.map(p=>p.sequence),[4,5,6]);
    f.setIdle(true);t.mock.timers.tick(751);
    assert.equal(f.sent.at(-1).type,'conversation.item.retrieve');
    const remote=Array.from({length:5},(_,i)=>({sequence:i+1,...pair(i+1)})).flatMap(p=>[
      {id:`history_${p.sequence}_u`,role:'user',text:p.user},{id:`history_${p.sequence}_a`,role:'assistant',text:p.assistant}]);
    f.ack('conversation.item.retrieved',items(remote));t.mock.timers.tick(751);
    assert.equal(f.sent.at(-1).type,'conversation.item.create');
    assert.equal(f.sent.filter(e=>e.type==='conversation.item.delete').length,0);
    f.ack('conversation.item.added',f.sent.at(-1).items);t.mock.timers.tick(751);
    assert.deepEqual(f.sent.at(-1).items.map(i=>i.id),['history_1_u','history_2_u','history_3_u']);
    f.ack('conversation.item.deleted',items(remote.slice(0,6)));
    assert.equal(f.restarts,0);assert.equal(f.history.pairs.at(-1).user,'new while summarizing');
  } finally {f.memory.close();}
});
test('missing/ambiguous item identities never delete a matching newer utterance; one controlled restart is used',async t=>{
  const f=fixture(t);
  try {
    f.memory.tick();const job=f.jobs[0];f.memory.complete(job.jobId,{...job,summary:'已保存历史。'});
    t.mock.timers.tick(751);
    f.ack('conversation.item.retrieved',items([
      {id:'different-user',role:'user',text:pair(1).user},{id:'different-assistant',role:'assistant',text:pair(1).assistant}]));
    t.mock.timers.tick(751);await pause();
    assert.equal(f.restarts,1);assert.ok(f.sent.every(event=>event.type!=='conversation.item.delete'));
  } finally {f.memory.close();}
});
test('stale, malformed and timed-out summaries retain originals and do not repeatedly call the model',t=>{
  const f=fixture(t);
  try {
    f.memory.tick();const job=f.jobs[0];
    f.memory.complete('another-call',{...job,summary:'wrong'});assert.equal(f.history.summary,'');
    f.memory.complete(job.jobId,{...job,through:999,summary:'wrong'});
    f.memory.tick();t.mock.timers.tick(1000);assert.equal(f.jobs.length,1);assert.equal(f.sent.length,0);
    f.history.append('later question','later answer');t.mock.timers.tick(31000);f.memory.tick();assert.equal(f.jobs.length,2);
    t.mock.timers.tick(65001);assert.equal(f.history.summary,'');assert.equal(f.history.pairs.length,6);
    assert.ok(f.status.at(-1).includes('原始记录已保留'));
  } finally {f.memory.close();}
});
test('no delete is sent on lost summary ACK, mismatched ACK, active playback, or after hangup',async t=>{
  const f=fixture(t);
  try {
    f.memory.tick();const job=f.jobs[0];f.memory.complete(job.jobId,{...job,summary:'保留的摘要。'});
    t.mock.timers.tick(751);
    const remote=Array.from({length:5},(_,i)=>({sequence:i+1,...pair(i+1)})).flatMap(p=>[
      {id:`history_${p.sequence}_u`,role:'user',text:p.user},{id:`history_${p.sequence}_a`,role:'assistant',text:p.assistant}]);
    f.ack('conversation.item.retrieved',items(remote));t.mock.timers.tick(751);
    assert.equal(f.sent.at(-1).type,'conversation.item.create');
    assert.equal(f.memory.event({type:'conversation.item.added',event_id:'wrong',items:f.sent.at(-1).items}),false);
    f.setIdle(false);t.mock.timers.tick(5001);assert.equal(f.restarts,0);
    f.memory.close();f.setIdle(true);t.mock.timers.tick(751);await pause();
    assert.equal(f.restarts,0);assert.ok(f.sent.every(e=>e.type!=='conversation.item.delete'));
  } finally {f.memory.close();}
});
class Socket {
  readyState=0;bufferedAmount=0;listeners=new Map();sent=[];
  addEventListener(type,fn){const list=this.listeners.get(type)??[];list.push(fn);this.listeners.set(type,list);}
  fire(type,value={}){for(const fn of this.listeners.get(type)??[])fn(value);}
  send(data){this.sent.push(JSON.parse(data));}
  close(){this.readyState=3;this.fire('close');}
  open(){this.readyState=1;this.fire('open');}
  event(event){this.fire('message',{data:JSON.stringify(event)});}
}

async function recoveryFixture(t){
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const sockets=[],events=[],dir=root();
  const service=new RealtimeVoiceService(path.join(dir,'settings.json'),{...crypto,connect:async()=>{const socket=new Socket();sockets.push(socket);return{socket,dispose(){}};}});
  service.save({...defaultRealtimeVoiceSettings,apiKey:'fixture-not-a-key'});
  const started=service.start(1,{id:'recover',sessionId:'remember-me',voice:'female',context:[]},e=>events.push(e));
  await pause();sockets[0].open();sockets[0].event({type:'session.created'});await started;
  sockets[0].event({type:'conversation.item.input_audio_transcription.completed',item_id:'question',transcript:'我叫小雨，记住我偏好简短回复。'});
  sockets[0].event({type:'response.output_text.done',item_id:'answer',text:'记住了，小雨。'});sockets[0].event({type:'response.done'});
  const handshake=socket=>{socket.open();socket.event({type:'session.created'});const context=socket.sent.find(e=>e.type==='conversation.item.create');return context;};
  const ack=(socket,context)=>socket.event({type:'conversation.item.added',event_id:'provider-assigned-ack',items:context.items});
  const dispose=()=>{service.closeAll();sockets.at(-1).event({type:'session.closed'});t.mock.timers.tick(2000);};
  return{service,sockets,events,dir,handshake,ack,dispose};
}

test('more than five seconds of reconnect pauses capture without hanging up, then restores context and in-flight child receipts',async t=>{
  const f=await recoveryFixture(t);
  try{
    f.sockets[0].event({type:'response.function_call_arguments.done',items:[{call_id:'child',name:'subagent',arguments:'{"prompt":"inspect"}'}]});
    f.sockets[0].close();t.mock.timers.tick(1);await pause();
    for(let i=0;i<280;i++){f.service.audio(1,'recover',new ArrayBuffer(640));t.mock.timers.tick(20);}
    assert.ok(f.events.some(e=>e.type==='connection-state'&&e.state==='paused'));
    assert.equal(f.events.some(e=>e.type==='closed'||e.type==='error'),false);
    const socket=f.sockets[1],context=f.handshake(socket);
    assert.ok(JSON.stringify(context).includes('小雨'));assert.ok(socket.sent.some(e=>e.type==='input_audio_mute.commit'));
    assert.ok(!socket.sent.some(e=>e.type==='input_audio_buffer.append'));
    // Receipt arrives after the restore snapshot, while the original call_id no longer exists remotely.
    f.service.results(1,'recover',[{id:'child',output:'{"taskId":"task-preserved","status":"running"}'}]);
    f.ack(socket,context);
    const receipt=socket.sent.filter(e=>e.type==='conversation.item.create').at(-1);
    assert.ok(JSON.stringify(receipt).includes('task-preserved'));assert.equal(receipt.items[0].role,'user');
    f.ack(socket,receipt);
    assert.equal(f.events.filter(e=>e.type==='connection-state').at(-1).state,'connected');
    assert.ok(!socket.sent.some(e=>e.items?.some(item=>item.role==='tool')),'do not replay a settled call into a new provider session');
    f.service.audio(1,'recover',new ArrayBuffer(640));assert.equal(socket.sent.at(-1).type,'input_audio_buffer.append');
    socket.event({type:'response.function_call_arguments.done',items:[{call_id:'child',name:'subagent',arguments:'{"prompt":"inspect"}'}]});
    assert.equal(f.events.filter(e=>e.type==='tools').length,1);
    f.sockets[0].event({type:'error',message:'late obsolete socket'});assert.equal(f.events.some(e=>e.type==='error'),false);
    const saved=new RealtimeVoiceHistory(path.join(f.dir,'voice-history'),'remember-me',crypto);
    assert.ok(JSON.stringify(saved.messages()).includes('小雨'));assert.ok(JSON.stringify(saved.messages()).includes('task-preserved'));
  }finally{f.dispose();}
});

test('short reconnect replays captured frames at 20 ms pacing after acknowledged history and ignores stale callbacks',async t=>{
  const f=await recoveryFixture(t);
  try{
    f.sockets[0].bufferedAmount=300000;f.service.audio(1,'recover',new ArrayBuffer(640));
    t.mock.timers.tick(1);await pause();
    for(let i=0;i<3;i++)f.service.audio(1,'recover',new Uint8Array(640).fill(i+1).buffer);
    const socket=f.sockets[1],context=f.handshake(socket);f.ack(socket,context);
    const audio=()=>socket.sent.filter(e=>e.type==='input_audio_buffer.append');
    assert.equal(audio().length,0);t.mock.timers.tick(20);assert.equal(audio().length,1);t.mock.timers.tick(20);assert.equal(audio().length,2);
    t.mock.timers.tick(20);t.mock.timers.tick(20);assert.deepEqual(audio().map(e=>Buffer.from(e.audio,'base64')[0]),[1,2,3]);
    assert.equal(f.events.filter(e=>e.type==='connection-state').at(-1).state,'connected');
    f.service.close(1);socket.event({type:'session.closed'});t.mock.timers.tick(60000);await pause();
    assert.equal(f.sockets.length,2,'intentional hangup never reconnects');
  }finally{f.dispose();}
});

test('retry budget is bounded, mute survives reconnection and invalid context ACKs never resume capture',async t=>{
  const f=await recoveryFixture(t);
  try{
    f.service.control(1,'recover','mute');f.sockets[0].close();t.mock.timers.tick(1);await pause();
    f.sockets[1].fire('error');t.mock.timers.tick(1001);await pause();assert.equal(f.sockets.length,3);
    const socket=f.sockets[2],context=f.handshake(socket);
    socket.event({type:'conversation.item.added',event_id:'unrelated',items:[]});assert.equal(socket.sent.some(e=>e.type==='input_audio_unmute.commit'),false);
    f.ack(socket,context);assert.equal(socket.sent.some(e=>e.type==='input_audio_unmute.commit'),false);
    f.service.control(1,'recover','unmute');assert.equal(socket.sent.at(-1).type,'input_audio_unmute.commit');
    socket.close();t.mock.timers.tick(1);await pause();f.sockets.at(-1).fire('error');t.mock.timers.tick(1001);await pause();
    f.sockets.at(-1).fire('error');t.mock.timers.tick(3001);await pause();f.sockets.at(-1).fire('error');
    const count=f.sockets.length;t.mock.timers.tick(100000);await pause();assert.equal(f.sockets.length,count);
    assert.equal(f.events.filter(e=>e.type==='error').length,1);assert.match(f.events.find(e=>e.type==='error').message,/原来的上下文/);
  }finally{f.dispose();}
});

test('restoring an oversized saved conversation waits for a validated summary, preserving the newest unsummarized pair',async t=>{
  const f=fixture(t);
  try{
    const original=f.history.pairs.length;
    const restored=f.memory.prepareInitial(3500);let settled=false;void restored.then(()=>settled=true);
    assert.equal(settled,false);assert.equal(f.jobs.length,1);const job=f.jobs[0];
    f.memory.complete(job.jobId,{...job,summary:'保留用户偏好和所有已核对的结论；任务仍在执行。'});
    const context=await restored;assert.ok(JSON.stringify(context).includes('用户偏好'));
    assert.ok(Buffer.byteLength(JSON.stringify(provider.context(context)))<=3500);
    assert.ok(f.history.through>0 && f.history.through<=original);
    assert.equal(f.sent.length,0,'disconnected history maintenance cannot edit a stale socket');
  }finally{f.memory.close();}
});
test('service archives real transcripts, continues PCM during summarization and resumes a replacement without replaying child tools',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const sockets=[],events=[],dir=root();
  const service=new RealtimeVoiceService(path.join(dir,'settings.json'),{...crypto,connect:async()=>{
    const socket=new Socket();sockets.push(socket);return{socket,dispose(){}};
  }});
  service.save({...defaultRealtimeVoiceSettings,apiKey:'fixture-not-a-key'});
  const pending=service.start(1,{id:'call',sessionId:'local-memory',voice:'female',context:[]},e=>events.push(e));
  await pause();const socket=sockets[0];socket.open();socket.event({type:'session.created'});await pending;
  try {
    socket.event({type:'response.function_call_arguments.done',items:[{call_id:'child1',name:'subagent',arguments:'{"prompt":"example"}'}]});
    service.results(1,'call',[{id:'child1',output:'{"taskId":"task1","status":"running"}'}]);
    for(let i=0;i<7;i++) {
      socket.event({type:'conversation.item.input_audio_transcription.completed',item_id:`remote-u${i}`,transcript:pair(i).user});
      socket.event({type:'response.output_text.done',item_id:`remote-a${i}`,text:pair(i).assistant});
      socket.event({type:'response.done'});
    }
    const job=events.find(e=>e.type==='context-compact').job;
    service.audio(1,'call',new Uint8Array(640).fill(7).buffer);
    assert.equal(socket.sent.at(-1).type,'input_audio_buffer.append');
    service.compacted(1,'call',job.jobId,{jobId:job.jobId,revision:job.revision,through:job.through,summary:'继续任务 task1，状态仅为 running，保留用户条件。'});
    const catchup=events.filter(e=>e.type==='context-compact').at(-1).job;
    if (catchup.jobId!==job.jobId) {
      assert.ok(catchup.through>job.through,'new speech receives its own frozen source, never silently dropped');
      service.compacted(1,'call',catchup.jobId,{jobId:catchup.jobId,revision:catchup.revision,through:catchup.through,summary:'继续任务 task1，状态仅为 running；新增条件也已保留。'});
    }
    service.playback(1,'call',true);t.mock.timers.tick(751);assert.ok(!socket.sent.some(e=>e.type==='conversation.item.retrieve'));
    service.playback(1,'call',false);t.mock.timers.tick(751);
    const retrieve=socket.sent.at(-1);assert.equal(retrieve.type,'conversation.item.retrieve');
    socket.event({type:'conversation.item.retrieved',event_id:retrieve.event_id,items:[]});
    t.mock.timers.tick(751);await pause();assert.equal(sockets.length,2);
    service.audio(1,'call',new Uint8Array(640).fill(9).buffer);
    const replacement=sockets[1];replacement.open();replacement.event({type:'session.created'});await pause();
    assert.ok(!replacement.sent.some(e=>e.type==='input_audio_buffer.append'),'wait for restored context confirmation before buffered microphone audio');
    const restoredContext=replacement.sent.find(e=>e.type==='conversation.item.create');
    replacement.event({type:'conversation.item.added',event_id:restoredContext.event_id,items:restoredContext.items});await pause();
    t.mock.timers.tick(40);
    assert.equal(events.filter(e=>e.type==='closed').length,0);
    assert.ok(replacement.sent.some(e=>e.type==='conversation.item.create' && JSON.stringify(e).includes('task1')));
    assert.ok(replacement.sent.some(e=>e.type==='input_audio_buffer.append' && Buffer.from(e.audio,'base64')[0]===9));
    replacement.event({type:'response.function_call_arguments.done',items:[{call_id:'child1',name:'subagent',arguments:'{"prompt":"example"}'}]});
    assert.equal(events.filter(e=>e.type==='tools').length,1,'old function call is not dispatched twice');
    service.close(1);replacement.event({type:'session.closed'});
    const restored=new RealtimeVoiceHistory(path.join(dir,'voice-history'),'local-memory',crypto);
    assert.ok(restored.summary.includes('task1'));assert.ok(restored.pairs.length>=1);
    assert.equal(events.filter(e=>e.type==='error').length,0);
  } finally {service.closeAll();t.mock.timers.tick(1600);}
});
