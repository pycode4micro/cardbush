import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, InMemoryRuntimeHost } from '../dist/index.js';

test('turn leases preserve exact owners, settle independently and release only once',async()=>{
  const registry=new ToolRegistry(), owner={}, other={}, released=[];
  registry.retainTurnResource('s','t',owner,async()=>{released.push('first');throw Error('closed transport');});
  registry.retainTurnResource('s','t',owner,async()=>released.push('duplicate'));
  registry.retainTurnResource('s','t',other,async()=>released.push('second'));
  registry.retainTurnResource('s','other',owner,async()=>released.push('other-turn'));
  await registry.releaseTurnResources('s','t');
  await registry.releaseTurnResources('s','t');
  assert.deepEqual(released,['first','second']);
  await registry.releaseTurnResources('s','other');
  assert.deepEqual(released,['first','second','other-turn']);
});

for(const mode of ['completed','failed','stopped'])test(`production turn lifecycle releases its resources on ${mode}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'turn-lease-')),registry=new ToolRegistry(),controller=new AbortController();
  let acquired=0,released=0;
  const host=new InMemoryRuntimeHost({dataRoot:root,toolRegistry:registry,maxAttempts:1,provider:{async *stream(request){
    acquired++;registry.retainTurnResource(request.sessionId,request.turnId,registry,async()=>{released++;});
    if(mode==='failed')throw Error('Fixture failure');
    if(mode==='stopped'){controller.abort();return;}
    const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
    yield {...base,sequence:0,kind:'text_delta',delta:'Done'};
    yield {...base,sequence:1,kind:'response_completed',finishReason:'stop'};
  }}});
  t.after(async()=>{await host.sendCommand({kind:'runtime.shutdown',payload:{}});await rm(root,{recursive:true,force:true});});
  const result=await host.runModelTurn({protocol:'bush.model_request.v1',requestId:'r',sessionId:'s',turnId:'t',
    model:'fixture',messages:[{role:'user',content:'Fixture'}],tools:[]},{signal:controller.signal});
  assert.equal(result.payload.status,mode);assert.equal(acquired,1);assert.equal(released,1);
});
