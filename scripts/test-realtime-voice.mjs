import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { RealtimeVoiceService } from '../dist-electron/realtimeVoiceService.js';
import { defaultRealtimeVoiceSettings as defaults } from '../dist-electron/realtimeVoiceTypes.js';
import { volcengineRealtimeVoice as provider } from '../dist-electron/volcengineRealtimeVoice.js';
import { realtimeVoiceNotification } from '../dist-electron/realtimeVoiceNotification.js';
import { CARDBUSH_REALTIME_PROTOCOL } from '../dist-electron/cardbushRealtimeVoice.js';
import * as protocol from '@cardbush/bush-protocol';

const pause=()=>new Promise(resolve=>setImmediate(resolve));
const compile=file=>{const exports={};const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports','require',source)(exports,spec=>spec==='@cardbush/bush-protocol'?protocol:compile(path.resolve(path.dirname(file),spec+'.ts')));return exports;};
const { RealtimeAgentBridge, realtimeConversationContext }=compile('src/features/voice/realtimeAgentBridge.ts');
const { RealtimeVoiceCall }=compile('src/features/voice/realtimeVoiceCall.ts');
const { RealtimeVoiceAudio }=compile('src/features/voice/realtimeVoiceAudio.ts');
class Socket {
  readyState=0;bufferedAmount=0;listeners=new Map();sent=[];
  addEventListener(type,fn){const list=this.listeners.get(type)??[];list.push(fn);this.listeners.set(type,list);}
  fire(type,value={}){for(const fn of this.listeners.get(type)??[])fn(value);}
  send(data){this.sent.push(JSON.parse(data));}
  close(){this.readyState=3;this.fire('close');}
  open(){this.readyState=1;this.fire('open');}
  event(event){this.fire('message',{data:JSON.stringify(event)});}
}
function fixture(connect){
  const file=path.join(fs.mkdtempSync(path.resolve('tmp/realtime-voice-test-')),'settings.json'),socket=new Socket(),events=[];
  let disposed=0,headers;
  const service=new RealtimeVoiceService(file,{encrypt:key=>'encrypted:'+Buffer.from(key).toString('base64'),decrypt:key=>Buffer.from(key.slice(10),'base64').toString(),
    connect:connect??(async(url,h)=>{assert.equal(url,provider.endpoint);headers=h;return{socket,dispose:()=>disposed++};})});
  service.save({...defaults,apiKey:'fixture-not-a-real-credential'});
  const start=async()=>{const pending=service.start(1,{id:'call-1',voice:'female',context:[]},e=>events.push(e));await pause();socket.open();socket.event({type:'session.created',session:{id:'vendor-session'}});await pending;};
  return{file,service,socket,events,start,get disposed(){return disposed;},get headers(){return headers;}};
}
test('realtime settings are independent, encrypted, redacted and explicit; no credentialless network',async()=>{
  const f=fixture();assert.equal(f.service.settings().mode,'realtime');assert.equal(f.service.settings().hasApiKey,true);
  assert.ok(!fs.readFileSync(f.file,'utf8').includes('fixture-not-a-real-credential'));
  assert.equal(Object.hasOwn(f.service.settings(),'secret'),false);
  f.service.save({...f.service.settings(),mode:'chained'});assert.equal(f.service.settings().hasApiKey,true);
  await assert.rejects(f.service.start(1,{id:'test',voice:'female',context:[]},()=>{}),/实时语音通话模式/);
  f.service.save({...f.service.settings(),mode:'realtime',apiKey:''});assert.equal(f.service.settings().hasApiKey,false);
  await assert.rejects(f.service.start(1,{id:'test',voice:'female',context:[]},()=>{}),/API Key/);
  assert.throws(()=>f.service.save({...defaults,provider:'arbitrary'}));
});
test('Seeduplex handshake, PCM formats, delegation tools, mute controls and graceful close follow the protocol',async()=>{
  const f=fixture();await f.start();
  assert.equal(f.headers['X-Api-Key'],'fixture-not-a-real-credential');
  const event=f.socket.sent[0];assert.equal(event.type,'session.create');assert.equal(event.session.model,'1.2.6.1');
  assert.deepEqual(event.session.tools.map(t=>t.name),['subagent','await_subagents','read_subagent_conversation']);assert.equal(event.session.audio.input.format.rate,16000);
  assert.equal(event.session.audio.output.format.type,'pcm_s16le');assert.equal(event.session.audio.output.speed,0);
  const pcm=new Uint8Array(640).fill(37);
  f.service.audio(1,'call-1',pcm.buffer);assert.equal(f.socket.sent.at(-1).type,'input_audio_buffer.append');
  assert.deepEqual(Buffer.from(f.socket.sent.at(-1).audio,'base64'),Buffer.from(pcm),'audio forwards immediately without speaker filtering or extra buffering');
  assert.throws(()=>f.service.audio(2,'call-1',new ArrayBuffer(640)));assert.throws(()=>f.service.audio(1,'call-1',new ArrayBuffer(1280)));
  for(const action of ['mute','unmute','commit','interrupt'])f.service.control(1,'call-1',action);
  assert.deepEqual(f.socket.sent.slice(-4).map(e=>e.type),['input_audio_mute.commit','input_audio_unmute.commit','input_audio_buffer.commit','response.cancel']);
  f.service.close(2,'call-1');assert.equal(f.socket.readyState,1);
  f.service.close(1,'call-1');assert.equal(f.socket.sent.at(-1).type,'session.close');assert.equal(f.disposed,0);
  f.socket.event({type:'session.closed'});assert.equal(f.disposed,1);
});

test('provider profiles isolate keys, migrate legacy settings and remove credentials when an endpoint changes',()=>{
  const f=fixture();
  const legacy={...defaults,secret:'encrypted:'+Buffer.from('legacy-fixture').toString('base64')};
  fs.writeFileSync(f.file,JSON.stringify(legacy));
  assert.equal(f.service.settings().hasApiKey,true);
  const bridge={...defaults,provider:'cardbush',model:'voice/demo',endpoint:'ws://127.0.0.1:8765/realtime',femaleVoice:'female',maleVoice:'male'};
  assert.equal(f.service.save(bridge).hasApiKey,false,'never copy the existing vendor credential');
  f.service.save({...bridge,apiKey:'bridge-fixture'});
  assert.ok(!JSON.stringify(f.service.settings()).includes('secret'));
  assert.ok(!JSON.stringify(f.service.settings()).includes('bridge-fixture'));
  assert.equal(f.service.save(defaults).hasApiKey,true,'the legacy vendor profile survives switching');
  assert.equal(f.service.save(bridge).hasApiKey,true,'restore the selected provider profile');
  assert.equal(f.service.save({...bridge,endpoint:'wss://new.example/realtime'}).hasApiKey,false);
  for(const endpoint of ['http://example.com','ws://example.com','wss://user:secret@example.com','wss://example.com?key=secret']) {
    assert.throws(()=>f.service.save({...bridge,endpoint}));
  }
});

test('CardBush compatible provider negotiates the version and preserves live model/voice settings when saved provider changes',async()=>{
  const socket=new Socket();let connected;
  const f=fixture(async(url,headers)=>{connected={url,headers};return{socket,dispose(){}};});
  f.service.save({...defaults,provider:'cardbush',model:'voice/demo',endpoint:'ws://127.0.0.1:8765/realtime',femaleVoice:'calm-female',maleVoice:'calm-male'});
  const pending=f.service.start(1,{id:'bridge-call',sessionId:'personal-assistant',assistant:{name:'Nova',persona:'自然交流'},voice:'female',context:[]},e=>f.events.push(e));
  await pause();socket.open();
  const create=socket.sent[0];assert.equal(create.protocol,CARDBUSH_REALTIME_PROTOCOL);assert.equal(create.session.model,'voice/demo');
  assert.ok(create.session.instructions.includes('Nova'));assert.ok(create.session.tools.some(t=>t.name==='page_write'));
  assert.deepEqual(connected,{url:'ws://127.0.0.1:8765/realtime',headers:{}});
  socket.event({type:'session.created',protocol:CARDBUSH_REALTIME_PROTOCOL});await pending;
  f.service.save({...defaults,model:'another-model'});
  f.service.setVoice(1,'bridge-call','male');
  assert.equal(socket.sent.at(-1).session.model,'voice/demo');assert.equal(socket.sent.at(-1).session.audio.output.voice,'calm-male');
  assert.ok(socket.sent.at(-1).session.instructions.includes('Nova'),'voice changes retain assistant persona');
  f.service.audio(1,'bridge-call',new ArrayBuffer(640));assert.equal(socket.sent.at(-1).type,'input_audio_buffer.append');
  socket.event({type:'response.output_audio.delta',delta:Buffer.alloc(960).toString('base64')});assert.ok(f.events.some(e=>e.type==='audio'));
  socket.event({type:'response.function_call_arguments.done',items:[{type:'function_call',call_id:'child',name:'subagent',arguments:'{"prompt":"inspect"}'}]});
  assert.ok(f.events.some(e=>e.type==='tools'));
  f.service.results(1,'bridge-call',[{id:'child',output:'{"status":"running"}'}]);assert.equal(socket.sent.at(-1).items[0].call_id,'child');
  f.service.close(1);socket.event({type:'session.closed'});
});

test('an incompatible bridge handshake cannot silently start a voice session',async()=>{
  const socket=new Socket(),f=fixture(async()=>({socket,dispose(){}}));
  f.service.save({...defaults,provider:'cardbush',model:'fixture',endpoint:'ws://localhost:8765'});
  const pending=f.service.start(1,{id:'wrong-protocol',voice:'female',context:[]},e=>f.events.push(e));void pending.catch(()=>{});
  await pause();socket.open();socket.event({type:'session.created',protocol:'different.v9'});
  await assert.rejects(pending);assert.ok(f.events.some(e=>e.type==='error'));
});

test('notifications speak a semantic summary and never read raw paths when summarization fails',()=>{
  const task={taskId:'inventory',status:'completed',result:'桌面应用表格：C:\\Apps\\editor.exe https://example.com',language:'zh'};
  const fallback=realtimeVoiceNotification(JSON.stringify(task));
  assert.ok(!fallback.speech.includes('editor'));assert.ok(!fallback.speech.includes('http'));assert.match(fallback.speech,/点击任务气泡/);
  const summarized=realtimeVoiceNotification(JSON.stringify({...task,speech:'桌面共有十五个应用，主要是开发工具、浏览器和办公软件。'}));
  assert.match(summarized.speech,/十五个应用/);assert.ok(summarized.context[0].text.includes('editor.exe'),'full facts remain contextual data');
  assert.equal(realtimeVoiceNotification(JSON.stringify({...task,speech:'安装在 C:\\Apps\\editor.exe'})).speech,fallback.speech);
  assert.match(realtimeVoiceNotification(JSON.stringify({...task,status:'failed'})).speech,/没能完成/);
});

test('tool batches deduplicate dispatch and require complete paired results from the owning call',async()=>{
  const f=fixture();await f.start();const event={type:'response.function_call_arguments.done',items:[1,2].map(i=>({type:'function_call',call_id:'fc'+i,name:'subagent',arguments:'{"prompt":"example"}'}))};
  f.socket.event(event);f.socket.event(event);assert.equal(f.events.filter(e=>e.type==='tools').length,1);
  assert.throws(()=>f.service.results(1,'call-1',[{id:'fc1',output:'done'}]));assert.throws(()=>f.service.results(2,'call-1',[{id:'fc1',output:'done'},{id:'fc2',output:'done'}]));
  f.service.results(1,'call-1',[{id:'fc1',output:'one'},{id:'fc2',output:'two'}]);
  assert.deepEqual(f.socket.sent.at(-1).items.map(i=>[i.call_id,i.role,i.content[0].text]),[['fc1','tool','one'],['fc2','tool','two']]);
  assert.throws(()=>f.service.results(1,'call-1',[{id:'fc1',output:'one'},{id:'fc2',output:'two'}]));
  f.service.close(1);f.socket.event({type:'session.closed'});
});
test('oversized input and vendor errors stop audio without echoing vendor data',async()=>{
  for(const failure of ['error','size']){const f=fixture();await f.start();
    if(failure==='error')f.socket.event({type:'error',status_code:45000000,message:'private-provider-key'});
    if(failure==='size')f.socket.fire('message',{data:'x'.repeat(1_000_001)});
    assert.equal(f.disposed,1);assert.equal(f.events.filter(e=>e.type==='error').length,1);assert.ok(!JSON.stringify(f.events).includes('private-provider-key'));
  }
});
test('hanging up during proxy resolution disposes a late connection and never sends session.create',async()=>{
  let release;const socket=new Socket();let disposed=0;
  const f=fixture(()=>new Promise(resolve=>{release=()=>resolve({socket,dispose:()=>disposed++});}));
  const pending=f.service.start(1,{id:'call-1',voice:'female',context:[]},()=>{});
  await pause();
  f.service.close(1,'call-1');await assert.rejects(pending);assert.equal(disposed,0);
  release();await pause();assert.equal(disposed,1);assert.deepEqual(socket.sent,[]);
});
test('normalization handles official JSON text/audio/FC events and empty completion',()=>{
  assert.deepEqual(provider.parse({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'中英文 API'}),[{type:'transcript',role:'user',text:'中英文 API',final:true,itemId:'u1'}]);
  assert.equal(provider.parse({type:'response.output_text.done',response_id:'r1'})[0].final,true);
  assert.equal(provider.parse({type:'response.output_audio.delta',delta:Buffer.alloc(960).toString('base64')})[0].sampleRate,24000);
  assert.throws(()=>provider.parse({type:'response.output_audio.delta',delta:'AA=='}));
  assert.deepEqual(provider.parse({type:'conversation.item.input_audio_transcription.failed',item_id:'noise',error:{code:'audio_unintelligible'}}),[{type:'input-discarded',itemId:'noise'}]);
});
test('large initial history is summarized before connecting instead of silently dropping older QA',async()=>{
  const f=fixture();f.service.save({...defaults,instructions:'中'.repeat(2000)});
  const context=Array.from({length:20},(_,i)=>({role:i%2?'assistant':'user',text:'中'.repeat(1000)}));
  const pending=f.service.start(1,{id:'call-1',voice:'male',context},e=>f.events.push(e));
  await pause();assert.equal(f.socket.sent.length,0);
  const job=f.events.find(e=>e.type==='context-compact').job;
  f.service.compacted(1,'call-1',job.jobId,{...job,summary:'保留全部已知对话条件与任务状态。'});
  await pause();f.socket.open();f.socket.event({type:'session.created'});
  const restored=f.socket.sent.find(e=>e.type==='conversation.item.create');
  assert.ok(JSON.stringify(restored).includes('保留全部已知'));
  f.socket.event({type:'conversation.item.added',event_id:restored.event_id,items:restored.items});await pending;
  assert.ok(f.socket.sent.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0)<16500);
  const history=f.socket.sent.find(e=>e.type==='conversation.item.create');assert.ok(!history||history.items.length%2===0);
  f.service.close(1);f.socket.event({type:'session.closed'});
});
const target=(messages=[])=>({environment:'local',sessionId:'chat',messages,sending:false,send:async()=>true});
const terminal=(turnId,content,status='completed')=>({id:turnId+'-answer',role:'assistant',turnId,content,status,metadata:{cardbush_terminal_snapshot:true,cardbush_terminal_stopped:status==='stopped'}});

test('renderer recovery pauses capture, retains user mute and clears reconnect status on failure without retrying tools',async()=>{
  let callback,frames,uploaded=0,closed=0;const patches=[],mute=[];
  const api={onEvent:fn=>(callback=fn,()=>{}),start:async()=>{},audio:async()=>uploaded++,control:async()=>{},close:async()=>closed++,playback:async()=>{}};
  const call=new RealtimeVoiceCall(api,p=>patches.push(p),()=>{},pcm=>{frames=pcm;return{prepare:async()=>{},mute:value=>mute.push(value),stop(){},close(){},append(){}};});
  call.update(target());await call.start('','female');
  callback({id:call.id,type:'connection-state',state:'paused',message:'正在恢复'});
  frames(new ArrayBuffer(640));await pause();assert.equal(uploaded,0);assert.equal(closed,0);
  assert.equal(patches.at(-1).reconnecting,true);call.mute(true);
  callback({id:call.id,type:'connection-state',state:'connected',message:''});assert.equal(mute.at(-1),true);
  assert.equal(patches.at(-1).phase,'listening');call.mute(false);frames(new ArrayBuffer(640));await pause();assert.equal(uploaded,1);
  callback({id:call.id,type:'error',message:'尝试耗尽'});assert.equal(patches.at(-1).reconnecting,false);assert.equal(patches.at(-1).connectionNotice,'');assert.equal(closed,1);
});

function agentFixture() {
  const tasks=[],calls=[];
  const agent={list:async()=>tasks,execute:async(id,name,args)=>{calls.push({id,name,args});
    if(name==='read_subagent_conversation')return {taskId:args.task_id,messages:[{author:'child_agent',content:'child answer'}],nextCursor:null};
    if(name==='subagent' && args.task_id)return {status:'message_queued',taskId:args.task_id};
    const task={taskId:id,status:'running',childSessionId:'child-'+id,parentTurnId:'voice_turn_'+id,finalResponse:'',errorMessage:''};tasks.push(task);return task;
  }};
  return{agent,tasks,calls};
}
const tool=(id,name,args)=>({id,name,arguments:JSON.stringify(args)});
test('slow summaries do not block other children or duplicate their notifications',async()=>{
  const f=agentFixture(),started=[],gates=new Map();
  const bridge=new RealtimeAgentBridge(()=>{},result=>{started.push(result.taskId);return new Promise(resolve=>gates.set(result.taskId,resolve));},()=>{},60000);
  bridge.update({...target(),agent:f.agent});
  try {
    const first=tool('slow','subagent',{prompt:'first'});await bridge.run(first);bridge.acknowledge([first]);
    f.tasks[0].status='completed';f.tasks[0].finalResponse='result one';
    const firstPoll=bridge.poll();await pause();assert.deepEqual(started,['slow']);
    const next=tool('fast','subagent',{prompt:'second'});await bridge.run(next);bridge.acknowledge([next]);
    f.tasks[1].status='completed';f.tasks[1].finalResponse='result two';
    const secondPoll=bridge.poll();await pause();assert.deepEqual(started,['slow','fast']);
    await bridge.poll();assert.equal(started.length,2);
    gates.get('fast')();await secondPoll;gates.get('slow')();await firstPoll;
    await bridge.poll();assert.equal(started.length,2);
  } finally {for(const resolve of gates.values())resolve();bridge.close();}
});
test('dispatch and await return immediately while multiple children run; terminal facts are delivered once',async()=>{
  const f=agentFixture(),notifications=[];const bridge=new RealtimeAgentBridge(()=>{},async r=>notifications.push(r));
  bridge.update({...target(),sending:true,activeTurnId:'busy-parent',agent:f.agent});
  try {
    const calls=[tool('a','subagent',{prompt:'one'}),tool('b','subagent',{prompt:'two'})];
    const results=await Promise.all(calls.map(c=>bridge.run(c)));assert.deepEqual(results.map(r=>JSON.parse(r).status),['running','running']);
    assert.equal(f.tasks.length,2);assert.equal(f.calls.length,2);
    assert.deepEqual(await bridge.run(calls[0]),results[0]);assert.equal(f.tasks.length,2);
    const watching=JSON.parse(await bridge.run(tool('wait','await_subagents',{task_ids:['a','b']})));assert.equal(watching.status,'watching');
    f.tasks[0].status='completed';f.tasks[0].finalResponse='real first result';
    await bridge.poll();assert.equal(notifications.length,0,'never notify before dispatch receipt is delivered');
    bridge.acknowledge(calls);await bridge.poll();await bridge.poll();assert.equal(notifications.length,1);assert.equal(notifications[0].result,'real first result');
    f.tasks[1].status='failed';f.tasks[1].errorMessage='execution failed';await bridge.poll();assert.equal(notifications[1].status,'failed');
  } finally {bridge.close();}
});
test('follow-ups and ordered conversation reads use the owned child and invalid calls never execute',async()=>{
  const f=agentFixture(),bridge=new RealtimeAgentBridge(()=>{});bridge.update({...target(),agent:f.agent});
  try{
    await bridge.run(tool('a','subagent',{prompt:'one'}));
    assert.equal(JSON.parse(await bridge.run(tool('m','subagent',{task_id:'a',prompt:'correction'}))).status,'message_queued');
    assert.equal(f.tasks.length,1,'follow-up reuses the existing task');
    assert.equal(f.calls.at(-1).name,'subagent');
    assert.equal(JSON.parse(await bridge.run(tool('r','read_subagent_conversation',{task_id:'a'}))).messages[0].content,'child answer');
    for(const call of [tool('bad1','shell',{prompt:'no'}),tool('bad2','subagent',{prompt:'no',approved:true}),tool('bad3','await_subagents',{task_ids:['unrelated']}),{id:'bad4',name:'subagent',arguments:'invalid'},
      tool('bad5','subagent',{task_id:'',prompt:'no'}),tool('removed-message','send_subagent_message',{task_id:'a',prompt:'no'}),
      tool('removed-wait','await_subagent',{}),tool('removed-arg','subagent',{resume_task_id:'a',prompt:'no'})])
      assert.equal(JSON.parse(await bridge.run(call)).status,'error');
    assert.equal(f.calls.length,3);
  }finally{bridge.close();}
});
test('hangup detaches completion notices without cancelling tasks; reconnect observes running children',async()=>{
  const f=agentFixture(),notifications=[];const bridge=new RealtimeAgentBridge(()=>{},async r=>notifications.push(r));bridge.update({...target(),agent:f.agent});
  await bridge.run(tool('a','subagent',{prompt:'one'}));bridge.close();
  assert.equal(f.tasks[0].status,'running');assert.equal(JSON.parse(await bridge.run(tool('closed','subagent',{prompt:'no'}))).status,'detached');
  const next=new RealtimeAgentBridge(()=>{},async r=>notifications.push(r));next.update({...target(),agent:f.agent});
  try{await next.poll();f.tasks[0].status='stopped';await next.poll();assert.equal(notifications[0].status,'stopped');}finally{next.close();}
});

test('dispatch errors retain diagnostic codes, redact credentials and do not ask for voice approval', async () => {
  const notices = [], f = agentFixture();
  const bridge = new RealtimeAgentBridge(()=>{}, async()=>{}, ()=>{}, 1500, message=>notices.push(message));
  bridge.update({...target(), agent:{...f.agent, execute:async()=>{throw Object.assign(new Error('subagent is disabled; Authorization: Bearer fixture-secret https://example.test/?token=fixture-secret'), {fact:{code:'realtime_subagent_disabled'}});}}});
  try {
    const failed = tool('failed', 'subagent', {prompt:'inspect'});
    const result = JSON.parse(await bridge.run(failed));
    assert.equal(result.code, 'realtime_subagent_disabled');
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    assert.match(result.instruction, /not an inferred need for permission/);
    assert.equal(notices.length, 1); assert.match(notices[0], /realtime_subagent_disabled/);
    await bridge.run(failed); assert.equal(notices.length, 1, 'replayed failure is not redispatched');
    bridge.update({...target(), agent:f.agent});
    await bridge.run(tool('success','subagent',{prompt:'inspect'}));
    assert.equal(notices.at(-1), '');
  } finally { bridge.close(); }
});

test('a failed delegation is visible while the live microphone and playback continue', async () => {
  let event, frames, uploaded=0, played=0; const patches=[], results=[];
  const api={onEvent:fn=>(event=fn,()=>{}),start:async()=>{},audio:async()=>uploaded++,control:async()=>{},close:async()=>{},results:async(id,value)=>results.push(value),notify:async()=>{}};
  const audio={prepare:async()=>{},mute(){},append(){played++;},stop(){},close(){}};
  const call=new RealtimeVoiceCall(api,p=>patches.push(p),()=>{},frame=>(frames=frame,audio));
  call.update({...target(),agent:{list:async()=>[],execute:async()=>{throw Object.assign(new Error('Restart the updated Runtime'),{code:'realtime_runtime_outdated'});}}});
  try {
    await call.start('','female');
    event({id:call.id,type:'tools',calls:[tool('fail','subagent',{prompt:'inspect'})]}); await pause();
    assert.equal(JSON.parse(results[0][0].output).code, 'realtime_runtime_outdated');
    assert.ok(patches.some(p=>p.agentError?.includes('realtime_runtime_outdated')));
    assert.ok(!patches.some(p=>p.phase==='idle'));
    frames(new ArrayBuffer(640)); event({id:call.id,type:'audio',pcm:'AAA=',sampleRate:24000});
    assert.equal(uploaded,1); assert.equal(played,1);
  } finally { call.close(); }
});
test('voice context contains bounded complete visible QA only',()=>{
  const context=realtimeConversationContext(target([{id:'u',role:'user',content:'问题'},terminal('t','回答'),{id:'secret',role:'assistant',content:'internal',metadata:{visibility:'internal'}},{id:'dangling',role:'user',content:'未完成'}]));
  assert.deepEqual(context,[{role:'user',text:'问题'},{role:'assistant',text:'回答'}]);
});
test('audio and dialogue continue during concurrent dispatch and await batches',async()=>{
  const f=agentFixture();let callback,frames,uploaded=0,played=0,closed=0;const results=[],patches=[];
  const api={onEvent:fn=>(callback=fn,()=>{}),start:async()=>{},audio:async()=>uploaded++,control:async()=>{},close:async()=>closed++,results:async(id,r)=>results.push(r),notify:async()=>{}};
  const audio={prepare:async()=>{},mute(){},append(){played++;},stop(){},close(){}};
  const call=new RealtimeVoiceCall(api,p=>patches.push(p),()=>{},frame=>(frames=frame,audio));call.update({...target(),agent:f.agent,sending:true});await call.start('','female');
  callback({id:call.id,type:'tools',calls:[tool('1','subagent',{prompt:'one'}),tool('2','subagent',{prompt:'two'})]});await pause();
  assert.deepEqual(results[0].map(r=>JSON.parse(r.output).status),['running','running']);
  callback({id:call.id,type:'tools',calls:[tool('wait','await_subagents',{task_ids:['1','2']})]});await pause();
  assert.equal(JSON.parse(results[1][0].output).status,'watching');
  frames(new ArrayBuffer(640));callback({id:call.id,type:'audio',pcm:'AAA=',sampleRate:24000});
  callback({id:call.id,type:'transcript',role:'assistant',text:'我们继续聊',itemId:'a1',final:true});
  assert.equal(uploaded,1);assert.equal(played,1);assert.ok(patches.some(p=>p.spokenText==='我们继续聊'));
  call.close();await pause();assert.equal(closed,1);assert.equal(f.tasks.filter(t=>t.status==='running').length,2);
});
test('background notifications wait for a speech gap, use paired context and do not reuse tool call IDs',async t=>{
  const f=fixture();await f.start();
  t.mock.timers.enable({apis:['setTimeout']});
  const result=JSON.stringify({taskId:'t',status:'completed',result:'done'});
  assert.throws(()=>f.service.notify(2,'call-1',result));assert.throws(()=>f.service.notify(1,'call-1','{"taskId":"t","status":"running"}'));
  f.socket.event({type:'conversation.item.input_audio_transcription.started'});
  f.service.notify(1,'call-1',result);t.mock.timers.tick(1000);
  assert.ok(!f.socket.sent.some(e=>e.type==='speech_text_buffer.commit'));
  f.socket.event({type:'conversation.item.input_audio_transcription.completed',transcript:'still here'});
  t.mock.timers.tick(751);const message=f.socket.sent.find(e=>e.type==='conversation.item.create');
  assert.equal(f.socket.sent.at(-1).type,'speech_text_buffer.commit');
  assert.equal(message.items.length,2);assert.equal(message.items[1].role,'assistant');
  f.service.notify(1,'call-1',result);t.mock.timers.tick(1000);assert.equal(f.socket.sent.filter(e=>e.type==='speech_text_buffer.commit').length,1);
  assert.equal(message.type,'conversation.item.create');assert.equal(message.items[0].role,'user');assert.equal(message.items[0].call_id,undefined);
  assert.match(message.items[0].content[0].text,/background task notification/);
  f.service.close(1);f.socket.event({type:'session.closed'});
});

test('AudioWorklet sends exact little-endian 20 ms frames and discards partial audio on mute',()=>{
  let Processor;const frames=[];
  const context=vm.createContext({AudioWorkletProcessor:class{port={postMessage:buffer=>frames.push(buffer),onmessage:null};},registerProcessor:(_name,ctor)=>Processor=ctor,Int16Array,Math});
  vm.runInContext(fs.readFileSync('public/voice/realtime-capture-worklet.js','utf8'),context);const processor=new Processor();
  processor.process([[new Float32Array(128).fill(.5)]]);assert.equal(frames.length,0);
  processor.port.onmessage({data:true});for(let i=0;i<5;i++)processor.process([[new Float32Array(128).fill(.5)]]);
  assert.equal(frames.length,2);assert.equal(frames[0].byteLength,640);assert.equal(new DataView(frames[0]).getInt16(0,true),16383);
  processor.process([[new Float32Array(128)]]);processor.port.onmessage({data:false});processor.process([[new Float32Array(320)]]);assert.equal(frames.length,2);
  processor.port.onmessage({data:true});processor.process([[new Float32Array(320).fill(-1)]]);assert.equal(new DataView(frames[2]).getInt16(0,true),-32768);
});

test('renderer runs background compaction without blocking audio, persists an initial conversation ID, and aborts on hangup',async()=>{
  let event,frames,signal,release;let uploaded=0,played=0,started;const summaries=[];
  const api={onEvent:fn=>(event=fn,()=>{}),start:async input=>{started=input;},audio:async()=>uploaded++,control:async()=>{},close:async()=>{},
    results:async()=>{},notify:async()=>{},compacted:async(...args)=>summaries.push(args)};
  const audio={prepare:async()=>{},mute(){},append(){played++;},stop(){},close(){}};
  const agent={execute:async()=>({}),list:async()=>[],prepareConversation:async()=>'persistent-voice',compact:async(job,s)=>{
    signal=s;await new Promise(resolve=>release=resolve);return {jobId:job.jobId,revision:0,through:1,summary:'saved'};
  }};
  const call=new RealtimeVoiceCall(api,()=>{},()=>{},frame=>(frames=frame,audio));
  call.update({...target(),sessionId:'',agent});await call.start('','female');
  assert.equal(started.sessionId,'persistent-voice');
  event({id:call.id,type:'context-compact',job:{jobId:'job',sessionId:'persistent-voice',revision:0,through:1,previousSummary:'',pairs:[{user:'u',assistant:'a'}]}});
  frames(new ArrayBuffer(640));event({id:call.id,type:'audio',pcm:'AAA=',sampleRate:24000});
  assert.equal(uploaded,1);assert.equal(played,1);assert.equal(summaries.length,0);
  call.close();assert.equal(signal.aborted,true);release();await pause();assert.equal(summaries.length,0);
});

test('final voice transcripts remain in the owning chat; both sides of assistant calls are internal and page_write is assistant-only', async()=>{
  for (const personal of [false,true]) {
    let callback,started;const recorded=[],pages=[],results=[];
    const api={onEvent:fn=>(callback=fn,()=>{}),start:async input=>{started=input;},audio:async()=>{},control:async()=>{},close:async()=>{},
      results:async(_,items)=>results.push(items),notify:async()=>{}};
    const audio={prepare:async()=>{},mute(){},append(){},stop(){},close(){}};
    const agent={execute:async()=>({}),list:async()=>[],record:async e=>recorded.push(e),pageWrite:async(...args)=>pages.push(args)};
    const call=new RealtimeVoiceCall(api,()=>{},()=>{},()=>audio);
    call.update({...target(),sessionId:'owner',agent,...(personal?{assistant:{name:'Lumi',persona:'可靠'}}:{})});
    await call.start('','female');
    call.update({...target(),sessionId:'another-chat',agent:{...agent,record:async()=>assert.fail('wrong conversation')}});
    callback({id:call.id,type:'transcript',role:'user',text:'我想',itemId:'u',final:false});
    callback({id:call.id,type:'transcript',role:'user',text:'我想了解方案',itemId:'u',final:true});
    callback({id:call.id,type:'transcript',role:'assistant',text:'可以，我们聊聊。',itemId:'a',final:true});
    callback({id:call.id,type:'tools',calls:[tool('page','page_write',{content:'## 方案'})]});await pause();
    call.close();
    assert.equal(started.sessionId,'owner');assert.equal(recorded.length,2);assert.equal(recorded[0].content,'我想了解方案');
    assert.equal(recorded[0].visibility,personal?'internal':'conversation');assert.equal(recorded[1].visibility,personal?'internal':'conversation');
    assert.equal(pages.length,personal?1:0);
    assert.equal(JSON.parse(results[0][0].output).status,personal?'written':'error');
  }
});

test('personal voice session advertises page_write and custom persona without changing ordinary call tools',()=>{
  const ordinary=provider.start(defaults,'female').session;
  const personal=provider.start(defaults,'female',{name:'Lumi',persona:'安静、可靠'}).session;
  assert.equal(ordinary.tools.length,3);assert.equal(personal.tools.length,4);
  assert.ok(!ordinary.instructions.includes('你是 CardBush'));
  assert.match(personal.instructions,/Lumi/);assert.match(personal.instructions,/page_write/);
});


test('a short microphone IPC stall keeps the call alive and drains frames in order', async()=>{
  let frame, closed=0, maximum=0;
  const pending=[], sent=[], patches=[];
  const api={onEvent:()=>()=>{},start:async()=>{},close:async()=>closed++,control:async()=>{},
    audio:async(_,pcm)=>{sent.push(new Int16Array(pcm)[0]);await new Promise(resolve=>pending.push(resolve));},notify:async()=>{}};
  const audio={prepare:async()=>{},mute(){},append(){},stop(){},close(){}};
  const call=new RealtimeVoiceCall(api,p=>patches.push(p),()=>{},fn=>(frame=fn,audio));
  call.update(target());await call.start('','female');
  try {
    for(let i=0;i<60;i++){const pcm=new Int16Array(320);pcm[0]=i;frame(pcm.buffer);maximum=Math.max(maximum,pending.length);}
    assert.equal(closed,0,'1.2 seconds of queued capture must not disconnect');
    assert.equal(patches.some(p=>p.error),false);
    while(pending.length){pending.splice(0).forEach(resolve=>resolve());await pause();maximum=Math.max(maximum,pending.length);}
    assert.deepEqual(sent,Array.from({length:60},(_,i)=>i));
    assert.ok(maximum<=4,'IPC upload concurrency stays bounded');
    for(let i=0;i<20;i++)frame(new ArrayBuffer(640));
    const beforeMute=sent.length;call.mute(true);
    pending.splice(0).forEach(resolve=>resolve());await pause();
    assert.equal(sent.length,beforeMute,'mute discards unsent audio instead of replaying it later');
    call.mute(false);frame(new ArrayBuffer(640));
    assert.equal(sent.length,beforeMute+1);
    for(let i=0;i<20;i++)frame(new ArrayBuffer(640));
    const beforeClose=sent.length;call.close();
    pending.splice(0).forEach(resolve=>resolve());await pause();
    assert.equal(sent.length,beforeClose,'hangup discards unsent frames');
  } finally {call.close();pending.splice(0).forEach(resolve=>resolve());await pause();}
  assert.equal(closed,1);
});

test('faster-than-realtime speech can buffer a complete reply and interruption clears playback',()=>{
  const playing=[], sources=[];
  const audio=new RealtimeVoiceAudio(()=>{},value=>playing.push(value),()=>{},()=>{});
  const context={currentTime:0,destination:{},
    createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
    createBufferSource:()=>{const source={connect(){},disconnect(){},start(at){this.at=at;},stop(){this.stopped=true;}};sources.push(source);return source;}};
  audio.output=context;
  const pcm=Buffer.alloc(48000).toString('base64');
  for(let i=0;i<30;i++)audio.append(pcm,24000);
  assert.equal(sources.length,30);assert.equal(sources.at(-1).at,29.02);
  audio.stop();assert.ok(sources.every(source=>source.stopped));assert.equal(playing.at(-1),false);
  context.currentTime=4;audio.append(pcm,24000);assert.equal(sources.at(-1).at,4.02);
  audio.stop();
  for(let i=0;i<100;i++)audio.append(pcm,24000);
  assert.throws(()=>{for(let i=0;i<30;i++)audio.append(pcm,24000);},/积压超过两分钟/,'unbounded playback is still rejected');
  audio.stop();
});

test('a sustained microphone transport stall has a bounded buffer and releases the call',async()=>{
  let frame,closed=0;const patches=[];
  const api={onEvent:()=>()=>{},start:async()=>{},close:async()=>closed++,audio:()=>new Promise(()=>{}),notify:async()=>{}};
  const audio={prepare:async()=>{},mute(){},append(){},stop(){},close(){}};
  const call=new RealtimeVoiceCall(api,p=>patches.push(p),()=>{},fn=>(frame=fn,audio));
  call.update(target());await call.start('','female');
  try {
    for(let i=0;i<300;i++)frame(new ArrayBuffer(640));
    assert.equal(closed,1);assert.match(patches.find(p=>p.error).error,/持续积压超过 5 秒/);
    assert.equal(patches.at(-1).phase,'idle');
  } finally {call.close();}
});
