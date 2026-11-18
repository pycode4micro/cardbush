import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { teamCompletionNotice } from '../dist/teamResults.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';

const until = async fn => { for (let i=0;i<600;i++) { if(fn()) return; await new Promise(r=>setTimeout(r,10)); } assert.fail('timed out'); };
async function* answer(request, text) {
  const event={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
  yield {...event,sequence:0,kind:'text_delta',delta:text};
  yield {...event,sequence:1,kind:'response_completed',finishReason:'stop'};
}
function fixture(t, stream, terminal=false, delegate) {
  const root=mkdtempSync(join(tmpdir(),'assistant-completion-')), journal=new ConversationJournal(root), requests=[];
  const original={id:'request-a',role:'user',source:'text',visibility:'conversation',content:'Send my file',createdAt:new Date().toISOString(),botSourceRef:'webhook:a'};
  const other={...original,id:'request-b',botSourceRef:'webhook:b',content:'Unrelated sender'};
  journal.append(id,original); journal.append(id,other); journal.modelHistory(id).append([], [original.id,other.id]);
  const task={taskId:'task-a',parentSessionId:id,parentTurnId:'p',childSessionId:'c',childTurnId:'t',createdAt:original.createdAt,
    status:terminal?'completed':'running',finalResponse:'Child final report',originMessageIds:[original.id],resultWatched:true};
  const parent={protocol:'bush.session_turn_request.v1',requestId:'r',sessionId:id,turnId:'p',model:'fixture',permissionMode:'task_free',tools:[],prefixMessages:[],inputMessages:[],metadata:{}};
  if(delegate)parent.tools.push({name:'tasks',description:'Read execution facts',inputSchema:{type:'object'}});
  const assistant=new AssistantConversation(journal,{exists:()=>true,tasks:()=>[task],checkpoint:()=>({}),delegate:delegate ?? (async()=>assert.fail('no forced actions')),
    ...(delegate ? { delegationTools:()=>[{name:'tasks',description:'Read execution facts',inputSchema:{type:'object'}}] } : {}),
    provider:{async *stream(request,options){requests.push(request);yield* stream(request,options,requests.length);}}});
  t.after(()=>{assistant.close();rmSync(root,{recursive:true,force:true});});
  const update=(source='a',serial=1)=>assistant.command({action:'delivery-update',sessionId:id,generation:0,sourceRef:`webhook:${source}`,
    result:{deliveryId:`00000000-0000-4000-8000-${String(serial).padStart(12,'0')}`,status:'delivered',deliveryConfirmed:true,filesSent:1,textPartsSent:0}});
  return {assistant,journal,task,requests,update,start:()=>assistant.restore(parent,assistantProfileSchema.parse({})),read:()=>assistant.command({action:'read',sessionId:id}),
    replies:()=>journal.read(id).filter(e=>e.role==='assistant')};
}
for(const first of ['delivery','task']) test(`${first} completion absorbs a related result before publishing; late stale drafts cannot escape`,async t=>{
  const gate=Promise.withResolvers();let draftSignal;
  const f=fixture(t,async function*(request,{signal},n){
    if(n===1){draftSignal=signal;await gate.promise;yield*answer(request,'Stale draft');}
    else yield*answer(request,'Both terminal facts observed');
  },first==='task');
  t.after(gate.resolve);f.start();
  if(first==='delivery')f.update();
  await until(()=>f.requests.length===1);
  if(first==='delivery'){f.task.status='completed';f.task.finalResponse='Finished sending';}else f.update();
  await until(()=>f.requests.length===2&&!f.read().busy);
  assert.equal(draftSignal.aborted,true);gate.resolve();await new Promise(r=>setTimeout(r,30));
  assert.equal(f.replies().length,1);assert.deepEqual(f.replies()[0].responseTo,['request-a']);
  const facts=f.requests[1].messages.filter(m=>m.name==='background_task_result').map(m=>JSON.parse(m.content));
  assert.equal(facts.filter(f=>f.type==='bridge_delivery_result').length,1);
  assert.equal(facts.filter(f=>f.type==='background_task_result').length,1);
  assert.equal(f.journal.modelHistory(id).read().taskResults.length,1);
});
test('a result after publication is a legitimate later update, not text deduplication',async t=>{
  const f=fixture(t,async function*(request){yield*answer(request,'Same words');},true);f.start();
  await until(()=>f.replies().length===1&&!f.read().busy);f.update();
  await until(()=>f.replies().length===2&&!f.read().busy);
  assert.deepEqual(f.replies().map(e=>e.content),['Same words','Same words']);
});
test('different recipients never merge into or invalidate another assignment',async t=>{
  const gate=Promise.withResolvers();let firstSignal;
  const f=fixture(t,async function*(request,{signal},n){if(n===1){firstSignal=signal;await gate.promise;}yield*answer(request,`Reply ${n}`);},true);
  t.after(gate.resolve);f.start();await until(()=>f.requests.length===1);f.update('b');
  await new Promise(r=>setTimeout(r,30));assert.equal(firstSignal.aborted,false);gate.resolve();
  await until(()=>f.replies().length===2&&!f.read().busy);
  assert.deepEqual(f.replies().map(e=>e.responseTo),[['request-a'],['request-b']]);
  assert.ok(!f.requests[0].messages.some(m=>m.content.includes('bridge_delivery_result')));
});
test('restored related facts and terminal tasks enter one durable context commit',async t=>{
  const f=fixture(t,async function*(request){yield*answer(request,'Joined');},true);
  f.update();f.start();await until(()=>f.replies().length===1&&!f.read().busy);
  assert.equal(f.requests.length,1);assert.equal(f.journal.modelHistory(id).read().taskResults.length,1);
  assert.equal(f.requests[0].messages.filter(m=>m.name==='background_task_result').length,2);
});

test('completion during an in-flight tool preserves that execution and joins the facts in the next model round', async t=>{
  const gate=Promise.withResolvers();let calls=0, toolSignal;
  const f=fixture(t,async function*(request,options,n){
    if(n===1){const event={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
      yield {...event,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'inspect-a',nameDelta:'tasks',argumentsDelta:'{"action":"list"}'};
      yield {...event,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
    }else yield*answer(request,'Current facts');
  },true,async(input,signal)=>{calls++;toolSignal=signal;await gate.promise;return {status:'observed'};});
  t.after(gate.resolve);f.start();await until(()=>calls===1);f.update();
  await new Promise(r=>setTimeout(r,30));assert.equal(toolSignal.aborted,false);assert.equal(calls,1);
  gate.resolve();await until(()=>f.replies().length===1&&!f.read().busy);
  assert.equal(calls,1);assert.equal(f.requests.length,2);
  assert.ok(f.requests[1].messages.some(m=>m.role==='tool'&&m.content.includes('observed')));
  assert.equal(f.requests[1].messages.filter(m=>m.name==='background_task_result').length,2);
});

test('a team result arriving during inspect is owned by the committed receipt, not delivered again',async t=>{
  const gate=Promise.withResolvers();let inspecting=false;
  const run={id:'team-a',teamId:'team',parentSessionId:id,parentTurnId:'p',originMessageIds:['request-a'],
    status:'completed',workflow:{nodes:[]},nodes:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const notice=teamCompletionNotice(run);
  const f=fixture(t,async function*(request,options,n){
    if(n===1){const event={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
      yield {...event,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'inspect-team',nameDelta:'tasks',argumentsDelta:'{"action":"inspect","task_ids":["team-a"]}'};
      yield {...event,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
    }else yield*answer(request,'Observed terminal version');
  },true,async()=>{inspecting=true;await gate.promise;return {tasks:[{task_id:run.id,kind:'team',result:notice}]};});
  t.after(gate.resolve);f.start();await until(()=>inspecting);f.assistant.notifyTeamResult(run);gate.resolve();
  await until(()=>f.replies().length===1&&!f.read().busy);
  assert.equal(f.requests.length,2);
  assert.equal(f.requests[1].messages.filter(m=>m.name==='background_task_result').length,1);
  const entry=f.journal.read(id).find(e=>e.id.startsWith('team-team-a-'));
  assert.ok(f.journal.modelHistory(id).read().entryIds.has(entry.id));
});

test('closing an interrupted completion prevents a late provider response from publishing',async t=>{
  const gate=Promise.withResolvers();const f=fixture(t,async function*(request){await gate.promise;yield*answer(request,'Must not publish');},true);
  t.after(gate.resolve);f.start();await until(()=>f.requests.length===1);f.assistant.close();gate.resolve();
  await new Promise(r=>setTimeout(r,50));assert.equal(f.replies().length,0);
});
