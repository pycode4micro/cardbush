import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistantContextMaintenance, assistantCheckpointPlan } from '../dist/assistantContextMaintenance.js';
import { AssistantModelHistory } from '../dist/assistantModelHistory.js';
import { registerContextCompactionTool } from '../dist/contextCompaction.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { validateConversation } from '../dist/sessionStore.js';
const parent={protocol:'bush.session_turn_request.v1',sessionId:'assistant',turnId:'p',requestId:'r',model:'fixture',tools:[],inputMessages:[],prefixMessages:[],metadata:{contextWindowTokens:530000},maxOutputTokens:8000};
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('timed out');};
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'assistant-idle-')), path=join(root,'history.jsonl'), history=new AssistantModelHistory(path), maintenance=new AssistantContextMaintenance();
  const registry=new ToolRegistry();registerContextCompactionTool(registry,()=>assert.fail('maintenance has no execution tools'));
  for(let i=0;i<60;i++)history.append([{role:'user',content:`Input ${i} `+'history data '.repeat(800)},
    {role:'assistant',content:'',toolCalls:[{id:`c${i}`,name:'read',argumentsText:'{}'}]},
    {role:'tool',toolCallId:`c${i}`,content:'fact '.repeat(1500)},
    {role:'assistant',content:`Answer ${i}`,toolCalls:[]}],[`input-${i}`]);
  history.append([],[],[{sessionId:'assistant',taskId:'done',attempt:'old'}],[]);
  t.after(()=>{maintenance.cancel();rmSync(root,{recursive:true,force:true});});
  return {history,maintenance,path,checkpoint:registry.definitions().find(t=>t.name==='checkpoint_context')};
}
async function* checkpoint(request,summary='User constraints and identifiers retained. Work remains a historical observation.') {
  const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
  yield {...base,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'checkpoint',nameDelta:'checkpoint_context',argumentsDelta:JSON.stringify({updates:[{source:0,summary}]})};
  yield {...base,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
}
test('idle checkpoint bounds the working set, preserves complete exchanges, IDs and original source across restart',async t=>{
  const f=fixture(t), before=f.history.read(), requests=[];
  const plan=assistantCheckpointPlan(before,parent);assert.ok(plan);validateConversation(plan.messages);
  const tail=before.messages.slice(plan.through-before.through);validateConversation(tail);assert.ok(tail.length>=8);
  const configured={...parent,tools:[{name:'unrelated_tool',description:'Unrelated foreground tool contract. '.repeat(6000),inputSchema:{type:'object'}}]};
  await f.maintenance.compact(f.history,configured,{async *stream(request){requests.push(request);yield*checkpoint(request);}},f.checkpoint,new AbortController().signal,[]);
  assert.ok(requests.length>=1&&requests.length<30);
  assert.ok(requests.every(r=>r.metadata.runtimeMaintenance==='assistant_context_compaction'&&r.tools.length===1));
  const after=f.history.read();assert.ok(after.through>0);assert.deepEqual(after.messages.slice(-8),before.messages.slice(-8));
  validateConversation(after.messages);assert.equal(assistantCheckpointPlan(after,parent),undefined);
  assert.deepEqual(after.entryIds,before.entryIds);assert.deepEqual(after.taskResults,before.taskResults);
  assert.match(readFileSync(f.path,'utf8'),/Input 0/);assert.deepEqual(new AssistantModelHistory(f.path).read(),after);
  assert.equal(f.maintenance.snapshot().phase,'completed');assert.ok(f.maintenance.snapshot().afterTokens<64000);
});
for(const mutation of ['cancel','checkpoint','unfinished-reply'])test(`a ${mutation} during maintenance prevents stale checkpoint commit`,async t=>{
  const f=fixture(t), gate=Promise.withResolvers(), controller=new AbortController();let started=false;
  const run=f.maintenance.compact(f.history,parent,{async *stream(request){started=true;await gate.promise;yield*checkpoint(request);}},f.checkpoint,controller.signal,[]);
  t.after(gate.resolve);await until(()=>started);
  if(mutation==='cancel')controller.abort();
  if(mutation==='checkpoint')f.history.checkpoint(4,'A newer checkpoint');
  if(mutation==='unfinished-reply')f.history.append([{role:'user',content:'Fresh input'}],['fresh'],[],['fresh']);
  const expected=f.history.read();gate.resolve();
  if(mutation==='cancel')await assert.rejects(run);else await run;
  assert.deepEqual(f.history.read(),expected);
});
test('new input cancels scheduled or in-flight idle work immediately, with no foreground error or retry storm',async t=>{
  const f=fixture(t), gate=Promise.withResolvers();let calls=0,signal;
  f.maintenance.schedule(async s=>{signal=s;calls++;await gate.promise;s.throwIfAborted();},1);
  t.after(gate.resolve);await until(()=>calls===1);f.maintenance.cancel();assert.equal(signal.aborted,true);
  f.maintenance.schedule(async()=>{calls++;throw Error('provider unavailable');},1);await until(()=>calls===2);
  await new Promise(r=>setTimeout(r,10));assert.equal(f.maintenance.snapshot().phase,'failed');
  f.maintenance.schedule(async()=>{calls++;},1);await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);
  gate.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(f.maintenance.snapshot().phase,'failed','stale cancellation must not replace the newer job status');
});

test('checkpoint source budgeting counts historical reasoning serialized as text',t=>{
  const f=fixture(t), source=f.history.read();
  const plain=assistantCheckpointPlan(source,parent);
  source.messages=source.messages.map(message=>message.role==='assistant'
    ? {...message,reasoningContent:'Historical reasoning with quoted "facts". '.repeat(500)}:message);
  const withReasoning=assistantCheckpointPlan(source,parent);
  assert.ok(withReasoning.messages.length<plain.messages.length);
  validateConversation(withReasoning.messages);
  validateConversation(source.messages.slice(withReasoning.messages.length));
});

test('oversized indivisible sources retain original history and expose bounded failure diagnostics',async t=>{
  const f=fixture(t), source=f.history.read();
  source.messages[0]={role:'user',content:'one indivisible source '.repeat(100000)};
  const diagnostics=[];
  f.maintenance.schedule(async()=>assistantCheckpointPlan(source,parent),1,error=>diagnostics.push(error));
  await until(()=>f.maintenance.snapshot().phase==='failed');
  assert.equal(f.maintenance.snapshot().errorCode,'context_checkpoint_source_too_large');
  assert.equal(diagnostics.length,1);assert.doesNotMatch(diagnostics[0].message,/indivisible source/);
  assert.equal(f.history.read().through,0);
});
