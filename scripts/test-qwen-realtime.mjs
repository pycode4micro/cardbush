import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { RealtimeVoiceService, connectRealtimeVoice } from '../dist-electron/realtimeVoiceService.js';
import { RealtimeVoiceContext } from '../dist-electron/realtimeVoiceContext.js';
import { RealtimeVoiceHistory } from '../dist-electron/realtimeVoiceHistory.js';
import { defaultRealtimeVoiceSettings } from '../dist-electron/realtimeVoiceTypes.js';
import { realtimeVoiceCatalog } from '../dist-electron/realtimeVoiceCatalog.js';
import { qwenRealtimeVoice } from '../dist-electron/qwenRealtimeVoice.js';

const pause=()=>new Promise(resolve=>setImmediate(resolve));
const crypto={encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()};
const settings={...defaultRealtimeVoiceSettings,...realtimeVoiceCatalog.qwen.defaults,provider:'qwen',
  endpoint:'wss://fixture-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',apiKey:'fixture-key'};
class Socket {
  readyState=0;bufferedAmount=0;listeners=new Map();sent=[];
  addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
  fire(type,event={}){for(const fn of this.listeners.get(type)??[])fn(event);}
  open(){this.readyState=1;this.fire('open');}
  close(){this.readyState=3;this.fire('close',{code:1000,wasClean:true});}
  send(data){this.sent.push(JSON.parse(data));}
  event(value){this.fire('message',{data:JSON.stringify(value)});}
  ack(){const update=this.sent.findLast(event=>event.type==='session.update');assert.ok(update);this.event({type:'session.updated',session:structuredClone(update.session)});}
}
function fixture(t,connect) {
  const directory=fs.mkdtempSync(path.resolve('tmp/qwen-realtime-')),sockets=[],events=[],diagnostics=[];
  let language='en';
  const service=new RealtimeVoiceService(path.join(directory,'settings.json'),{...crypto,uiLanguage:()=>language,
    diagnostic:event=>diagnostics.push(event),connect:connect??(async(url,headers)=>{assert.equal(new URL(url).searchParams.get('model'),settings.model);
      assert.deepEqual(headers,{Authorization:'Bearer fixture-key'});const socket=new Socket();sockets.push(socket);return{socket,dispose(){}};})});
  service.save(settings);t.after(()=>service.closeAll());
  const start=async(owner=1,context=[])=>{const pending=service.start(owner,{id:'call-'+owner,sessionId:'conversation-'+owner,voice:'female',context},event=>events.push(event));
    void pending.catch(()=>{});await pause();const socket=sockets.at(-1);socket.open();assert.equal(socket.sent.length,0,'wait for server-created session');
    socket.event({type:'session.created',session:{model:settings.model}});return{pending,socket};};
  return {service,start,sockets,events,diagnostics,directory,setLanguage:value=>{language=value;}};
}
const response=(socket,id,output=[],status='completed')=>socket.event({type:'response.done',response:{id,status,output}});
const call=(id,name='subagent',args={prompt:'inspect the requested file'})=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});

test('Qwen profiles isolate secrets, validate workspace endpoints and preserve existing provider settings',t=>{
  const f=fixture(t);
  assert.equal(f.service.settings().provider,'qwen');assert.equal(f.service.settings().femaleVoice,'Tina');
  assert.ok(!JSON.stringify(f.service.settings()).includes('fixture-key'));
  f.service.save({...defaultRealtimeVoiceSettings,apiKey:'volc-fixture'});
  const {apiKey,...saved}=settings;
  assert.equal(f.service.save(saved).hasApiKey,true);
  assert.equal(f.service.save({...saved,endpoint:settings.endpoint.replace('cn-beijing','ap-southeast-1')}).hasApiKey,false);
  for(const endpoint of ['', 'wss://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    settings.endpoint+'?api_key=secret',settings.endpoint+'#key',settings.endpoint.replace('wss:','ws:'),
    settings.endpoint.replace('aliyuncs.com','aliyuncs.com.evil.example'),settings.endpoint.replace('wss://','wss://user:key@')]) {
    assert.throws(()=>f.service.save({...saved,endpoint}),/WebSocket/);
  }
  f.setLanguage('zh');assert.throws(()=>f.service.save({...saved,endpoint:''}),/业务空间/);
  f.service.save({...settings,femaleVoice:'Liora Mira'});
  assert.equal(f.service.settings().femaleVoice,'Liora Mira','official multiword voice identifiers are supported');
});

test('Qwen waits for configured session acknowledgement and restores history as data, never fabricated item receipts',async t=>{
  const f=fixture(t),context=[{role:'user',text:'之前说过的条件'},{role:'assistant',text:'已经记录，不重复执行。'}];
  const {pending,socket}=await f.start(1,context);let ready=false;void pending.then(()=>{ready=true;});await pause();assert.equal(ready,false);
  assert.throws(()=>f.service.audio(1,'call-1',new ArrayBuffer(640)));
  const session=socket.sent[0].session;
  assert.deepEqual(session.audio.input.format,{type:'pcm',sample_rate:16000});
  assert.equal(session.audio.output.format.sample_rate,24000);assert.equal(session.audio.output.voice,'Tina');
  assert.equal(session.turn_detection.type,'semantic_vad');
  assert.deepEqual(session.tools.map(tool=>tool.function.name),['subagent','tasks','hang_up','recall_conversation']);
  assert.ok(session.tools.every(tool=>tool.function.parameters.type==='object'));assert.ok(!session.tools.some(tool=>tool.type==='mcp'));
  assert.match(session.instructions,/之前说过的条件/);assert.match(session.instructions,/not new user requests/);
  socket.ack();await pending;
  f.service.audio(1,'call-1',new ArrayBuffer(640));assert.equal(socket.sent.at(-1).type,'input_audio_buffer.append');
  assert.equal(socket.sent.some(event=>event.type==='conversation.item.create'),false);
  f.service.control(1,'call-1','mute');const n=socket.sent.length;f.service.audio(1,'call-1',new ArrayBuffer(640));assert.equal(socket.sent.length,n);
  assert.equal(socket.sent.at(-1).type,'input_audio_buffer.clear');f.service.control(1,'call-1','unmute');
  f.service.control(1,'call-1','commit');assert.equal(socket.sent.length,n,'VAD does not send empty manual commits');
  f.service.close(2,'call-1');assert.equal(socket.readyState,1);
  f.service.close(1,'call-1');assert.equal(socket.readyState,3);assert.ok(!socket.sent.some(e=>e.type==='session.close'));
});

test('Qwen rejects unacknowledged context and redacts vendor errors in the current UI language',async t=>{
  for(const invalid of ['context','vendor']) {
    const f=fixture(t),{pending,socket}=await f.start();
    if(invalid==='context')socket.event({type:'session.updated',session:{instructions:'different'}});
    else {f.setLanguage('zh');socket.event({type:'error',error:{message:'secret-fixture-key private speech',code:'private-secret'}});}
    await assert.rejects(pending);assert.equal(socket.readyState,3);
    assert.ok(!JSON.stringify(f.events).includes('secret-fixture-key'));
    if(invalid==='vendor')assert.match(f.events.find(event=>event.type==='error').message,/Qwen 拒绝/);
  }
});

test('Qwen streams audio and replaces ASR hypotheses; only the complete response is archived',async t=>{
  const f=fixture(t),{pending,socket}=await f.start();socket.ack();await pending;
  socket.event({type:'input_audio_buffer.speech_started',item_id:'user'});
  for(const [text,stash] of [['帮我','看一'],['帮我看','一下']])socket.event({type:'conversation.item.input_audio_transcription.delta',item_id:'user',text,stash});
  socket.event({type:'conversation.item.input_audio_transcription.completed',item_id:'user',transcript:'帮我看一下'});
  socket.event({type:'response.created',response:{id:'reply'}});
  socket.event({type:'response.audio_transcript.delta',response_id:'reply',item_id:'assistant',delta:'可以'});
  socket.event({type:'response.audio.delta',response_id:'reply',delta:Buffer.alloc(960).toString('base64')});
  socket.event({type:'response.audio.done',response_id:'reply'});
  assert.equal(f.events.filter(event=>event.type==='audio-start').length,1);
  assert.equal(f.events.find(event=>event.type==='audio').sampleRate,24000);
  assert.deepEqual(f.events.filter(event=>event.type==='transcript'&&!event.final).slice(0,2).map(event=>[event.text,event.replace]),[['帮我看一',true],['帮我看一下',true]]);
  socket.event({type:'response.audio_transcript.done',response_id:'reply',item_id:'assistant',transcript:'可以，已经了解。'});
  response(socket,'reply');
  const history=new RealtimeVoiceHistory(path.join(f.directory,'voice-history'),'conversation-1',crypto);
  assert.equal(history.pairs[0].assistant,'可以，已经了解。','audio.done before final text cannot truncate history');
});

test('Qwen collects finalized tool calls once and sends all outputs before one continuation',async t=>{
  const f=fixture(t),{pending,socket}=await f.start();socket.ack();await pending;
  const calls=[call('task1'),call('task2')];socket.event({type:'response.created',response:{id:'tools'}});
  for(const c of calls)socket.event({...c,type:'response.function_call_arguments.done',response_id:'tools'});
  assert.equal(f.events.some(event=>event.type==='tools'),false,'never execute arguments before the response is settled');
  response(socket,'tools',calls);response(socket,'tools',calls);
  assert.equal(f.events.filter(event=>event.type==='tools').length,1);
  assert.equal(f.events.find(event=>event.type==='tools').calls.length,2);
  assert.throws(()=>f.service.results(1,'call-1',[{id:'task1',output:'done'}]));
  const n=socket.sent.length;
  f.service.results(1,'call-1',[{id:'task1',output:'{"status":"running"}'},{id:'task2',output:'{"status":"error"}'}]);
  const frames=socket.sent.slice(n);assert.deepEqual(frames.map(event=>event.type),['conversation.item.create','conversation.item.create','response.create']);
  assert.deepEqual(frames.slice(0,2).map(event=>event.item.call_id),['task1','task2']);
  assert.ok(frames.slice(0,2).every(event=>event.item.type==='function_call_output'&&!event.items));
  assert.equal(new Set(frames.map(event=>event.event_id)).size,3);
  assert.throws(()=>f.service.results(1,'call-1',[{id:'task1',output:'duplicate'},{id:'task2',output:'duplicate'}]));
});

test('Qwen barge-in discards unfinished calls and late output without cancelling the next reply',async t=>{
  const f=fixture(t),{pending,socket}=await f.start();socket.ack();await pending;
  socket.event({type:'response.created',response:{id:'old'}});
  socket.event({...call('must-not-run'),type:'response.function_call_arguments.done',response_id:'old'});
  socket.event({type:'input_audio_buffer.speech_started',item_id:'new-user'});
  const n=socket.sent.length;f.service.control(1,'call-1','interrupt');assert.equal(socket.sent.length,n,'native VAD already cancelled generation');
  socket.event({type:'response.created',response:{id:'new'}});
  socket.event({type:'response.audio.delta',response_id:'old',delta:Buffer.alloc(960).toString('base64')});
  response(socket,'old',[call('must-not-run')]);
  socket.event({type:'response.audio.delta',response_id:'new',delta:Buffer.alloc(960).toString('base64')});
  assert.equal(f.events.some(event=>event.type==='tools'),false);assert.equal(f.events.filter(event=>event.type==='audio').length,1);
  assert.match(f.events.find(event=>event.type==='audio').responseId,/:new$/);
  f.service.control(1,'call-1','interrupt');assert.equal(socket.sent.at(-1).type,'response.cancel');
  response(socket,'new',[],'cancelled');const count=socket.sent.length;f.service.control(1,'call-1','interrupt');assert.equal(socket.sent.length,count);
});

test('Qwen tool results do not start a response over a newer user turn',async t=>{
  const f=fixture(t),{pending,socket}=await f.start();socket.ack();await pending;
  response(socket,'tools',[call('task')]);socket.event({type:'input_audio_buffer.speech_started',item_id:'follow-up'});
  const n=socket.sent.length;f.service.results(1,'call-1',[{id:'task',output:'{"status":"running"}'}]);
  assert.deepEqual(socket.sent.slice(n).map(event=>event.type),['conversation.item.create']);
});

test('Qwen connection state is isolated between owners and resets on reconnect without switching providers',async t=>{
  const f=fixture(t),first=await f.start(1,[{role:'user',text:'保留的历史'},{role:'assistant',text:'已保存'}]);first.socket.ack();await first.pending;
  const other=await f.start(2);other.socket.ack();await other.pending;
  for(const socket of [first.socket,other.socket])response(socket,'same-id',[call('same-call')]);
  assert.equal(f.events.filter(event=>event.type==='tools').length,2);
  f.service.results(1,'call-1',[{id:'same-call',output:'{"status":"running","taskId":"kept"}'}]);
  f.service.save({...defaultRealtimeVoiceSettings,apiKey:'other-provider-key'});
  first.socket.fire('close',{code:1006,wasClean:false});
  await new Promise(resolve=>setTimeout(resolve,20));await pause();const reconnected=f.sockets.at(-1);assert.notEqual(reconnected,other.socket);
  reconnected.open();reconnected.event({type:'session.created'});
  assert.match(reconnected.sent[0].session.instructions,/保留的历史/);assert.match(reconnected.sent[0].session.instructions,/kept/);
  const readyBefore=f.events.filter(event=>event.type==='connection-state'&&event.state==='connected').length;
  first.socket.event({type:'session.updated',session:{instructions:'stale'}});assert.equal(reconnected.readyState,1);
  reconnected.ack();await pause();assert.equal(f.events.filter(event=>event.type==='connection-state'&&event.state==='connected').length,readyBefore+1);
  assert.equal(reconnected.sent.some(event=>event.type.startsWith('conversation.item.')),false);
});

test('Qwen background results update instructions quietly and retain the restored history',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t),{pending,socket}=await f.start(1,[{role:'user',text:'earlier request'},{role:'assistant',text:'earlier response'}]);socket.ack();await pending;
  const n=socket.sent.length;f.service.notify(1,'call-1',JSON.stringify({taskId:'task',status:'completed',finalResponse:'资料已就绪'}));
  t.mock.timers.tick(800);assert.deepEqual(socket.sent.slice(n).map(event=>event.type),['session.update']);
  assert.match(socket.sent.at(-1).session.instructions,/earlier request/);assert.match(socket.sent.at(-1).session.instructions,/task/);
  socket.ack();assert.equal(f.events.some(event=>event.type==='error'),false);
});

test('providers without item maintenance checkpoint and reconnect without sending retrieve or delete',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const history=new RealtimeVoiceHistory(undefined,'memory',crypto),jobs=[],sent=[];let restarts=0;
  for(let i=0;i<4;i++)history.append('question '+i+' details'.repeat(50),'answer '+i+' evidence'.repeat(50));
  const memory=new RealtimeVoiceContext(history,0,{restartOnly:true,maxPairs:4,create:qwenRealtimeVoice.context,
    send:event=>{sent.push(event);return 'id';},request:job=>jobs.push(job),status:()=>{},idle:()=>true,restart:async()=>{restarts++;}},48000,96000,Infinity);
  t.after(()=>memory.close());memory.initialContext(96000);memory.tick();assert.equal(jobs.length,1,'turn budget also protects vendor history retention');
  const job=jobs[0];memory.complete(job.jobId,{...job,summary:'Retained task facts and outcomes.'});t.mock.timers.tick(800);await pause();
  assert.equal(restarts,1);assert.deepEqual(sent,[]);assert.equal(history.summary,'Retained task facts and outcomes.');
});

test('Qwen changes a voice on the live connection without resetting audio or conversation settings',async t=>{
  const f=fixture(t);const {socket,pending}=await f.start();socket.ack();await pending;
  const before=socket.sent.length;
  f.service.setVoice(1,'call-1','Theo Calm');
  const update=socket.sent.at(-1);
  assert.deepEqual(update.session,{audio:{output:{voice:'Theo Calm'}}});
  socket.event({type:'session.updated',session:{instructions:'existing conversation',audio:{output:{voice:'Theo Calm'}}}});
  assert.equal(f.events.some(event=>event.type==='error'),false);
  assert.equal(f.sockets.length,1);assert.equal(socket.sent.slice(before).some(e=>e.type==='response.cancel'),false);
});

test('headless assistant preserves revised Qwen transcription snapshots',async()=>{
  const {AssistantDeviceCall,assistantHostSettingsSchema}=await import('../dist-electron/assistantVoiceHost.mjs');
  let emit;const records=[];
  const voice={start:async(_owner,_input,callback)=>{emit=callback;},close(){},control(){}};
  const call=new AssistantDeviceCall(voice,'device',assistantHostSettingsSchema.parse({}),{list:async()=>[],record:async item=>records.push(item)},()=>{});
  try {
    await call.start();
    for(const text of ['我想了解','我想看'])emit({id:'call',type:'transcript',role:'user',text,itemId:'user',final:false,replace:true});
    emit({id:'call',type:'transcript',role:'user',text:'',itemId:'user',final:true});await pause();
    assert.equal(records[0].content,'我想看');assert.equal(records.length,1);
  }finally{call.close();}
});

test('Qwen protocol runs over a real local WebSocket with native audio and tool continuation frames',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  t.after(()=>{for(const client of server.clients)client.terminate();server.close();});
  const frames=[],errors=[];let peer,configuredSession={};
  server.on('connection',(socket,request)=>{peer=socket;
    try {assert.equal(request.headers.authorization,'Bearer fixture-key');}catch(error){errors.push(error);}
    const send=event=>socket.send(JSON.stringify(event));
    send({type:'session.created',session:{model:settings.model}});
    socket.on('message',bytes=>{try{const event=JSON.parse(String(bytes));frames.push(event);
      if(event.type==='session.update'){
        configuredSession={...configuredSession,...event.session};
        assert.equal(configuredSession.tools[0].function.name,'subagent');send({type:'session.updated',session:configuredSession});
      }else if(event.type==='input_audio_buffer.append'){
        assert.equal(Buffer.from(event.audio,'base64').length,640);
        send({type:'conversation.item.input_audio_transcription.completed',item_id:'user',transcript:'Read the requested file'});
        send({type:'response.created',response:{id:'tool-response'}});
        send({...call('read-file'),type:'response.function_call_arguments.done',response_id:'tool-response'});
        send({type:'response.done',response:{id:'tool-response',status:'completed',output:[call('read-file')]}});
      }else if(event.type==='conversation.item.create')assert.equal(event.item.type,'function_call_output');
      else if(event.type==='response.create'){
        send({type:'response.created',response:{id:'answer'}});
        send({type:'response.audio_transcript.delta',response_id:'answer',item_id:'answer-item',delta:'The task has started.'});
        send({type:'response.audio.delta',response_id:'answer',delta:Buffer.alloc(960).toString('base64')});
        send({type:'response.audio_transcript.done',response_id:'answer',item_id:'answer-item',transcript:'The task has started.'});
        send({type:'response.audio.done',response_id:'answer'});send({type:'response.done',response:{id:'answer',status:'completed',output:[]}});
      }else assert.equal(event.type,'input_audio_buffer.clear');
    }catch(error){errors.push(error);socket.close();}});
  });
  const f=fixture(t,async(url,headers)=>{assert.match(url,/model=qwen3\.8-omni-flash-realtime$/);return connectRealtimeVoice('',`ws://127.0.0.1:${server.address().port}/realtime`,headers);});
  await f.service.start(1,{id:'real-socket',voice:'female',context:[]},event=>{f.events.push(event);
    if(event.type==='tools')f.service.results(1,'real-socket',event.calls.map(call=>({id:call.id,output:'{"status":"running","taskId":"file-task"}'})));});
  f.service.audio(1,'real-socket',new ArrayBuffer(640));
  for(let i=0;i<200&&!f.events.some(event=>event.type==='audio-end');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(errors,[]);assert.ok(f.events.some(event=>event.type==='audio-end'));
  assert.equal(frames.filter(event=>event.type==='response.create').length,1);assert.equal(f.events.filter(event=>event.type==='tools').length,1);
  f.service.close(1,'real-socket');await once(peer,'close');
});
