import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { normalizeIndividuation, assistantFeedbackInputSchema } from '@cardbush/bush-protocol';
import { IndividuationStore } from '../dist/individuationStore.js';
import { runtimeMemory } from './helpers/runtimeMemory.mjs';
import { InMemoryRuntimeHost } from '../dist/index.js';

const on=normalizeIndividuation({habits:true,predictions:true});
const off=normalizeIndividuation();
const context={user:'请用简明的表格比较两个方案。',assistant:'以下表格按成本、收益、风险比较两个方案，附上判断依据。'};
const input=(turnId='t1',rating='up',messageId='a1',sessionId='s1')=>({sessionId,turnId,messageId,rating});
const summary=(habits=[],predictions=[],reviews=[])=>({habits,predictions,reviews});
const habit=(ids,text='比较方案时偏好附判断依据的简明表格。')=>({text,sources:ids});
const owner=()=>({sessionId:'settings',turnId:randomUUID(),operationId:randomUUID()});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'cardbush-feedback-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const path=join(root,'personalization.sqlite'),store=new IndividuationStore(path);
  return {root,path,store,vote:(value,settings=on,operationId=randomUUID())=>store.feedback(value,settings,operationId,context)};
}
const row=async(store,id)=>(await store.read({ids:[id]},on)).memories[0];

test('feedback is gated by habits and retains one bounded event per reply with idempotent receipts',async t=>{
  const f=await fixture(t);
  for(const settings of [off,normalizeIndividuation({predictions:true})])assert.equal((await f.vote(input(),settings)).status,'disabled');
  await f.store.feedback(input('t1',null),off,'cancel');
  await assert.rejects(access(f.path),{code:'ENOENT'});
  const saved=await f.vote(input(),on,'save');assert.equal(saved.status,'ok');
  assert.deepEqual(await f.vote(input(),on,'save'),saved);
  await f.vote(input(),on,'retry-same-rating');
  let current=await row(f.store,saved.id);
  assert.equal(current.kind,'feedback');assert.equal(current.feedback.rating,'up');
  assert.equal(current.feedback.messageId,'a1');assert.deepEqual(current.source,{session_id:'s1',turn_id:'t1'});
  assert.ok(current.text.includes(context.user)&&current.text.includes(context.assistant));
  assert.equal((await f.store.history(on)).changes.length,1,'repeated clicks are not fresh evidence');
  const changed=await f.vote(input('t1','down'));
  assert.equal(changed.id,saved.id);current=await row(f.store,saved.id);
  assert.equal(current.feedback.rating,'down');assert.equal(current.revision,2);
  assert.equal((await f.store.status(on)).feedback,1);
  await assert.rejects(f.vote(input('t1','down'),on,'save'),/reused/);
  await f.store.feedback(input('t1',null),off,'withdraw');
  assert.equal((await row(f.store,saved.id)).state,'retracted');
  assert.equal((await f.store.status(on)).records,0);
  const reselected=await f.vote(input());assert.equal(reselected.id,saved.id);
  const otherSession=await f.vote(input('t1','up','a1','s2'));
  assert.notEqual(otherSession.id,saved.id,'reply identifiers are scoped by conversation');
  await f.store.feedback(input('long','up'),on,'long-context',{user:'问题'.repeat(10000),assistant:'回复'.repeat(10000)});
  const event=(await f.store.list(on)).records.find(value=>value.source.turn_id==='long');
  assert.ok(event.text.length<4000,'large replies have bounded excerpts');
  assert.deepEqual(await f.store.check('',normalizeIndividuation({predictions:true})),[]);
});

test('isolated ratings remain events and multiple replies in one turn do not fabricate repeated support',async t=>{
  const f=await fixture(t),first=await f.vote(input());
  let snapshot=await f.store.begin(on,'events',true);
  await assert.rejects(f.store.apply(snapshot,summary([habit([first.id])]),on),error=>error.reason==='unsupported_promotion');
  await f.store.apply(snapshot,summary(),on);
  assert.equal((await row(f.store,first.id)).state,'active','ambiguous feedback is retained');
  const second=await f.vote(input('t1','up','a2'));
  snapshot=await f.store.begin(on,'events',true);
  await assert.rejects(f.store.apply(snapshot,summary([habit([first.id,second.id])]),on),error=>error.reason==='unsupported_promotion');
  assert.equal((await f.store.status(on)).habits,0);
  await f.store.fail(snapshot.lease,'release');
  const third=await f.vote(input('t2'));
  snapshot=await f.store.begin(on,'events',true);
  await assert.rejects(f.store.apply(snapshot,summary([],[habit([first.id,third.id])]),on),error=>error.reason==='unsupported_promotion');
  const status=await f.store.apply(snapshot,summary([habit([first.id,third.id])]),on);
  assert.equal(status.habits,1);assert.equal(status.feedback,1);assert.equal(status.hits,0);assert.equal(status.misses,0);
  assert.equal((await row(f.store,second.id)).state,'active');
  assert.equal((await row(f.store,first.id)).state,'consolidated');
});

test('changing or withdrawing ratings invalidates derived summaries through later compaction and preserves other votes',async t=>{
  const f=await fixture(t),a=await f.vote(input()),b=await f.vote(input('t2'));
  await f.store.apply(await f.store.begin(on,'events',true),summary([habit([a.id,b.id])]),on);
  let snapshot=await f.store.begin(on,'habits',true);
  await f.store.apply(snapshot,summary([habit(snapshot.records.map(row=>row.id),'方案对比用简表。')]),on);
  await assert.rejects(f.store.feedback(input('t1','down'),on,'missing-context'),/unavailable/);
  assert.equal((await f.store.status(on)).habits,1,'invalid writes roll back all dependent changes');
  const revised=await f.vote(input('t1','down'));
  assert.equal((await f.store.status(on)).habits,0);
  assert.equal((await row(f.store,b.id)).state,'active');
  assert.equal((await row(f.store,a.id)).feedback.rating,'down');
  assert.ok((await f.store.list(on,0,true)).records.some(row=>row.kind==='habit'&&row.state==='disputed'));
  const history=await f.store.history(on),change=history.changes.find(item=>item.id===revised.change_id);
  assert.ok(change.can_undo);assert.ok(change.after.some(row=>row.state==='disputed'));
  await f.store.undo(change.id,on,owner());
  assert.equal((await f.store.status(on)).habits,1,'undo restores the rating and derived summary atomically');
  await f.vote(input('t1',null));
  assert.equal((await row(f.store,a.id)).state,'retracted');
  assert.equal((await f.store.status(on)).habits,0);
});

test('pinned habits survive changed ratings; settings retraction uses the same event path and agent edits are rejected',async t=>{
  const f=await fixture(t),a=await f.vote(input()),b=await f.vote(input('t2'));
  const original=await row(f.store,a.id);
  assert.equal((await f.store.change({id:a.id,revision:original.revision,action:'dispute',reason:'unclear'},on,owner(),'agent')).status,'rejected');
  assert.equal((await f.store.change({id:a.id,revision:original.revision,action:'confirm',reason:'pin'},on,owner(),'user')).status,'rejected');
  await f.store.apply(await f.store.begin(on,'events',true),summary([habit([a.id,b.id])]),on);
  const preference=(await f.store.list(on)).records.find(row=>row.kind==='habit');
  await f.store.change({id:preference.id,revision:preference.revision,action:'confirm',reason:'Explicit preference'},on,owner(),'user');
  await f.vote(input('t1','down'));
  assert.equal((await row(f.store,preference.id)).state,'active');
  const current=await row(f.store,a.id);
  assert.equal((await f.store.change({id:a.id,revision:current.revision,action:'retract',reason:'Remove this feedback'},on,owner(),'user')).status,'ok');
  assert.equal((await row(f.store,a.id)).state,'retracted');
  assert.equal((await row(f.store,preference.id)).origin,'user');
});

test('a rating change during summarization rejects the stale conclusion',async t=>{
  const f=await fixture(t),a=await f.vote(input()),b=await f.vote(input('t2'));
  const snapshot=await f.store.begin(on,'events',true);
  await f.vote(input('t1','down'));
  await assert.rejects(f.store.apply(snapshot,summary([habit([a.id,b.id])]),on),error=>error.code==='memory_snapshot_changed');
  const status=await f.store.status(on);assert.equal(status.habits,0);assert.equal(status.feedback,2);
});

test('fresh feedback can re-establish the same summarized habit without reviving old withdrawn support',async t=>{
  const f=await fixture(t),a=await f.vote(input()),b=await f.vote(input('t2'));
  await f.store.apply(await f.store.begin(on,'events',true),summary([habit([a.id,b.id])]),on);
  await f.vote(input('t1',null));
  const c=await f.vote(input('t3'));
  const status=await f.store.apply(await f.store.begin(on,'events',true),summary([habit([b.id,c.id])]),on);
  assert.equal(status.habits,1);assert.equal(status.feedback,0);
  const preference=(await f.store.list(on)).records.find(row=>row.kind==='habit');
  assert.deepEqual(new Set(preference.source_ids),new Set([b.id,c.id]));
  assert.equal((await row(f.store,a.id)).state,'retracted');
  // Changing the withdrawn, unrelated old signal must not invalidate the fresh conclusion.
  await f.vote(input('t1','down'));
  assert.equal((await f.store.status(on)).habits,1);
});

test('rating changes follow replacement links even when a large summary truncates its visible source list',async t=>{
  const f=await fixture(t),votes=[];
  for(let i=0;i<102;i++)votes.push(await f.vote(input('turn-'+i)));
  const snapshot=await f.store.begin(on,'events',true);
  await f.store.apply(snapshot,summary([habit(votes.map(vote=>vote.id))]),on);
  const preference=(await f.store.list(on)).records.find(row=>row.kind==='habit');
  assert.equal(preference.source_ids.length,100);
  assert.ok(!preference.source_ids.includes(votes[101].id));
  await f.vote(input('turn-101',null));
  const status=await f.store.status(on);assert.equal(status.habits,0);assert.equal(status.feedback,101);
  assert.equal((await row(f.store,preference.id)).state,'disputed');
});

test('the existing memory summarizer receives positive and negative events and consolidates supported feedback',async t=>{
  const f=await fixture(t),a=await f.vote(input()),b=await f.vote(input('t2')),c=await f.vote(input('t3','down'));
  let calls=0;
  const memory=runtimeMemory(f.path,{async *stream(request){
    calls++;const rows=JSON.parse(request.messages.at(-1).content);
    assert.equal(request.metadata.memoryStage,'events');assert.equal(rows.length,3);
    assert.ok(rows.every(row=>row.kind==='feedback'));assert.equal(rows.filter(row=>row.feedback.rating==='down').length,1);
    assert.ok(request.messages[0].content.includes('without a specific reason')||request.messages[0].content.includes('no specific reason'));
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'text_delta',delta:JSON.stringify(summary([habit(rows.filter(row=>row.feedback.rating==='up').map(row=>row.id))]))};
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:1,kind:'response_completed',finishReason:'stop'};
  }});t.after(()=>memory.close());
  const status=await memory.compact(on,{model:'fixture',metadata:{contextWindowTokens:400000}},true);
  assert.equal(calls,1);assert.equal(status.habits,1);assert.equal(status.feedback,1);assert.equal(status.hits,0);
  assert.equal((await row(f.store,c.id)).state,'active','unexplained negative feedback is still available');
});

test('runtime resolves the actual rated reply and user request; nonexistent and spoofed sources are rejected',async t=>{
  const f=await fixture(t);let calls=0;
  const host=new InMemoryRuntimeHost({dataRoot:f.root,registerDefaultWorkspaceTools:false,provider:{async *stream(request){
    calls++;
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'text_delta',delta:context.assistant};
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:1,kind:'response_completed',finishReason:'stop'};
  }}});t.after(()=>host.sendCommand({kind:'runtime.shutdown',payload:{}}));
  const result=await host.runSessionTurn({protocol:'bush.session_turn_request.v1',requestId:'request',sessionId:'s1',turnId:'t1',model:'fixture',tools:[],prefixMessages:[],
    inputMessages:[{messageId:'u1',message:{role:'user',content:context.user}}],metadata:{individuation:on}});
  assert.equal(result.payload.status,'completed');
  const session=await host.sendCommand({kind:'runtime.get_session',payload:{sessionId:'s1'}});
  const reply=session.turns[0].messages.find(row=>row.message.role==='assistant');assert.ok(reply);
  const command=value=>host.sendCommand({kind:'runtime.personalization',payload:{action:'feedback',feedback:value,settings:on,operationId:randomUUID()}});
  for(const value of [input(),input('t1','up','u1'),input('missing','up',reply.messageId),input('t1','up',reply.messageId,'missing')])
    await assert.rejects(command(value),/unavailable/);
  assert.equal(assistantFeedbackInputSchema.safeParse({...input(),assistant:'forged user preference'}).success,false);
  const saved=await command(input('t1','up',reply.messageId));
  const event=await row(f.store,saved.id);assert.ok(event.text.includes(context.user)&&event.text.includes(context.assistant));
  assert.equal(calls,1,'clicking feedback does not issue a separate model request');
});
