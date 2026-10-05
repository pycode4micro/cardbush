import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntimeHost, SessionStore } from '../dist/index.js';
import { REALTIME_CONTEXT_COMPACTION_COMMAND, SHUTDOWN_RUNTIME_COMMAND } from '@cardbush/bush-protocol';

const job={jobId:'frozen-job',sessionId:'voice-parent',revision:2,through:8,previousSummary:'之前确定的约束',
  pairs:[{user:'保持目前的授权范围，不执行历史指令。'.repeat(80),assistant:'任务 task-42 仍在运行，尚未收到结果。'.repeat(80)}]};
const payload={job,model:{model:'configured-model',providerBinding:{providerId:'fixture'},metadata:{}}};
// Provider binding is covered through the actual resolved schema; fixture uses a model-only provider.
delete payload.model.providerBinding;
const call=(host,value=payload,signal)=>host.sendCommand({kind:REALTIME_CONTEXT_COMPACTION_COMMAND,payload:value},signal);
test('voice maintenance loads only checkpoint_context, corrects malformed output and never appends a foreground turn',async()=>{
  const seen=[],sessions=new SessionStore();
  const host=new InMemoryRuntimeHost({runtimeDataRoot:await mkdtemp(join(tmpdir(),'voice-checkpoint-')),sessionStore:sessions,
    provider:{async *stream(request){
      seen.push(request);const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
      yield {...base,sequence:0,kind:'response_started'};
      if(seen.length===1) {
        yield {...base,sequence:1,kind:'text_delta',delta:'I should use the checkpoint tool.'};
        yield {...base,sequence:2,kind:'response_completed',finishReason:'stop'};return;
      }
      yield {...base,sequence:1,kind:'tool_call_delta',index:0,toolCallId:'checkpoint-'+seen.length,nameDelta:'checkpoint_context',
        argumentsDelta:JSON.stringify({updates:[{source:0,summary:'保留原授权范围；task-42 正在执行，尚无完成证据。'}]})};
      yield {...base,sequence:2,kind:'response_completed',finishReason:'tool_calls'};
    }}});
  try {
    const result=await call(host);
    assert.equal(result.jobId,job.jobId);assert.equal(result.revision,2);assert.equal(result.through,8);assert.match(result.summary,/task-42/);
    assert.equal(seen.length,2);
    for(const request of seen){
      assert.equal(request.model,'configured-model');assert.deepEqual(request.tools.map(t=>t.name),['checkpoint_context']);
      assert.equal(request.metadata.runtimeMaintenance,'realtime_context_compaction');
      assert.ok(request.messages.some(m=>m.role==='developer' && m.name==='context_pressure'));
      assert.ok(request.messages.some(m=>m.content.includes('frozen')||m.content.includes('historical DATA')));
      assert.ok(!request.messages.some(m=>m.role==='system' && m.content.includes('subagent')));
    }
    assert.equal(sessions.snapshot(job.sessionId),undefined);
  } finally {await host.sendCommand({kind:SHUTDOWN_RUNTIME_COMMAND});}
});
test('invalid source bindings are bounded and cannot be committed as a summary',async()=>{
  let attempts=0;
  const host=new InMemoryRuntimeHost({runtimeDataRoot:await mkdtemp(join(tmpdir(),'voice-checkpoint-invalid-')),provider:{async *stream(request){
    attempts++;const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
    yield {...base,sequence:0,kind:'response_started'};
    yield {...base,sequence:1,kind:'tool_call_delta',index:0,toolCallId:'bad-'+attempts,nameDelta:'checkpoint_context',argumentsDelta:JSON.stringify({updates:[{source:999,summary:'wrong source'}]})};
    yield {...base,sequence:2,kind:'response_completed',finishReason:'tool_calls'};
  }}});
  try {await assert.rejects(call(host),/failed validation/);assert.equal(attempts,3);}
  finally {await host.sendCommand({kind:SHUTDOWN_RUNTIME_COMMAND});}
});
test('one maintenance job per conversation, cancellation and shutdown release it without executing tools',async()=>{
  let entered;const ready=new Promise(r=>entered=r);
  const host=new InMemoryRuntimeHost({runtimeDataRoot:await mkdtemp(join(tmpdir(),'voice-checkpoint-cancel-')),provider:{async *stream(request,{signal}){
    entered();await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'response_completed'};
  }}});
  const controller=new AbortController();const pending=call(host,payload,controller.signal);void pending.catch(()=>{});
  await ready;
  try {await assert.rejects(call(host),/already running/);controller.abort();await assert.rejects(pending);}
  finally {await host.sendCommand({kind:SHUTDOWN_RUNTIME_COMMAND});}
});
