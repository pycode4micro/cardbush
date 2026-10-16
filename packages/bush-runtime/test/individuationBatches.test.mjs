import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIndividuation } from '@cardbush/bush-protocol';
import { IndividuationStore, memoryReviewCandidates } from '../dist/individuationStore.js';
import { memoryBatches, memoryBatchMessages, memoryTaskBudget } from '../dist/individuationBatch.js';
import { memorySummaryInstructions } from '../dist/individuationMemory.js';
import { memoryHash, memoryTokens } from '../dist/individuationText.js';
import { runtimeMemory } from './helpers/runtimeMemory.mjs';

const settings=normalizeIndividuation({habits:true,predictions:true}),model={model:'fixture',reasoningEffort:'max',maxOutputTokens:128000,metadata:{contextWindowTokens:530000}};
const output=(habits=[],predictions=[],reviews=[])=>({habits,predictions,reviews});
const hit=(prediction,evidence)=>({prediction,evidence,outcome:'hit',reason:'An explicit subsequent request.',quote:'dated XLSX file'});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'cardbush-memory-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'memory.sqlite');return {path,store:new IndividuationStore(path),owner:{sessionId:'batch',turnId:'forecast'}};}
async function forecast(f){return (await f.store.summarize({prediction:{text:'Market reports may need a dated XLSX file.',applies_when:'For market reports'}},settings,f.owner)).writes[0].id;}
async function evidence(f,turn,text='Market report: please include a dated XLSX file.'){await f.store.observe(text,settings,{...f.owner,turnId:turn});}
function withPairs(snapshot){return {...snapshot,reviewPairs:[...memoryReviewCandidates(snapshot.records)].flatMap(([evidence,predictions])=>predictions.map(prediction=>[prediction,evidence]))};}
function inspect(path,sql){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}}
const provider=fn=>({async *stream(request){const result=await fn(request,JSON.parse(request.messages.at(-1).content));
  yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'text_delta',delta:JSON.stringify(result)};
  yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:1,kind:'response_completed',finishReason:'stop'};}});

test('bounded projection contains complete text and only necessary metadata; batches cover every eligible pair',async t=>{
  const f=await fixture(t);await forecast(f);
  for(let i=0;i<35;i++)await evidence(f,`e${i}`,'Market report XLSX '+i+' '+ '请保留原始日期、范围和来源。'.repeat(25));
  const snapshot=await f.store.begin(settings,'events',true),budget=memoryTaskBudget(530000,128000);
  const batches=memoryBatches(snapshot,memorySummaryInstructions,budget.inputTokens);
  assert.ok(batches.length>1);assert.equal(budget.outputTokens,128000);
  assert.throws(()=>memoryTaskBudget(4096,8192),error=>error.code==='model_context_limits_invalid','an invalid configuration is not repaired by lowering output allowance');
  assert.equal(batches.flatMap(batch=>batch.reviewPairs).length,35);
  for(const batch of batches){const messages=memoryBatchMessages(batch,memorySummaryInstructions);
    assert.ok(memoryTokens(JSON.stringify(messages))*1.5+64<=10000);
    const rows=JSON.parse(messages[1].content);
    assert.ok(rows.every(row=>!('metadata' in row)&&!('created' in row)));
    rows.forEach((row,i)=>assert.equal(row.text,batch.records[i].text));
  }
});

test('promotion inherits source expiry without making the model calculate timestamps',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'one');await evidence(f,'two');
  const snapshot=withPairs(await f.store.begin(settings,'events',true)),p=snapshot.records.find(row=>row.id===id);
  const messages=memoryBatchMessages(snapshot,memorySummaryInstructions);
  assert.ok(JSON.parse(messages[1].content).every(row=>!('expires_at' in row)));
  const result=await f.store.apply(snapshot,output([{text:'Use dated XLSX files.',applies_when:p.applies_when,sources:[id]}],[],snapshot.records.filter(row=>row.kind==='evidence').map(row=>hit(id,row.id))),settings,undefined,{partial:true});
  assert.equal(result.habits,1);assert.equal(inspect(f.path,"SELECT expires FROM memory_records WHERE kind='habit' AND state='active'")[0].expires,p.expires);
});

test('orphan evidence is archived without a model call and remains undoable',async t=>{
  const f=await fixture(t);const id=await forecast(f);await evidence(f,'e');
  const db=new DatabaseSync(f.path);db.prepare('UPDATE memory_records SET expires=? WHERE id=?').run(Date.now()-1,id);db.close();
  let calls=0;const memory=runtimeMemory(f.path,provider(()=>{calls++;return output();}));t.after(()=>memory.close());
  await memory.compact(settings,model,true);assert.equal(calls,0);
  assert.equal(inspect(f.path,"SELECT state FROM memory_records WHERE kind='evidence'")[0].state,'consolidated');
  const change=inspect(f.path,"SELECT id FROM memory_changes WHERE reason='Archive evidence with no pending forecast review'")[0];
  await f.store.undo(change.id,settings,{...f.owner,turnId:"undo",operationId:"undo"});
  assert.equal(inspect(f.path,"SELECT state FROM memory_records WHERE kind='evidence'")[0].state,'active');
});

test('an unsupported promotion does not discard a valid review, and unknowns do not count as misses',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'e1');await evidence(f,'e2','Market report: unrelated color question.');
  const snapshot=withPairs(await f.store.begin(settings,'events',true)),rows=snapshot.records.filter(row=>row.kind==='evidence');
  const result=await f.store.apply(snapshot,output([{text:'Always create XLSX.',sources:[id,rows[0].id]}],[],[hit(id,rows[0].id)]),settings,undefined,{partial:true});
  assert.equal(result.hits,1);assert.equal(result.misses,0);assert.equal(result.habits,0);assert.equal(result.predictions,1);
  assert.equal(result.rejected[0].reason,'unsupported_promotion');
  assert.equal(inspect(f.path,"SELECT count(*) n FROM memory_reviews WHERE outcome='unknown'")[0].n,1);
  const change=inspect(f.path,"SELECT id FROM memory_changes WHERE reason='Consolidate memory' ORDER BY seq DESC LIMIT 1")[0];
  await f.store.undo(change.id,settings,{...f.owner,turnId:"undo",operationId:"undo"});
  assert.equal((await f.store.status(settings)).hits,0);
  assert.equal(inspect(f.path,'SELECT count(*) n FROM memory_reviews')[0].n,0);
});

test('multiple observations of one user turn cannot manufacture repeated support',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'same');await evidence(f,'same','Market report: yes, give the dated XLSX file.');
  const snapshot=withPairs(await f.store.begin(settings,'events',true)),rows=snapshot.records.filter(row=>row.kind==='evidence');
  const result=await f.store.apply(snapshot,output([{text:'Use dated XLSX reports.',applies_when:'For market reports',sources:[id]}],[],rows.map(row=>hit(id,row.id))),settings,undefined,{partial:true});
  assert.equal(result.hits,1);assert.equal(result.habits,0);assert.equal(result.rejected[0].reason,'unsupported_promotion');
  await evidence(f,'independent');const next=withPairs(await f.store.begin(settings,'events',true));
  const final=await f.store.apply(next,output([{text:'Use dated XLSX reports.',applies_when:'For market reports',sources:[id]}],[],[hit(id,next.records.find(row=>row.kind==='evidence').id)]),settings,undefined,{partial:true});
  assert.equal(final.hits,2);assert.equal(final.habits,1);assert.equal(final.rejected.length,0);
});

test('omitted habits and failed conditions are preserved while an independent merge succeeds',async t=>{
  const f=await fixture(t);
  for(let i=0;i<4;i++)await f.store.summarize({habit:{text:`Report ${i}: `+'Include dates and sources. '.repeat(20),applies_when:i===3?'Only for private reports':undefined}},settings,{...f.owner,turnId:String(i)});
  const snapshot=await f.store.begin(settings,'habits',true),ids=snapshot.records.map(row=>row.id);
  const result=await f.store.apply(snapshot,output([{text:'Include report dates and sources.',sources:ids.slice(0,2)},
    {text:'Always include sources.',sources:[ids[3]]}]),settings,undefined,{partial:true});
  assert.equal(result.habits,3);assert.equal(result.rejected[0].reason,'condition_lost');
  const active=inspect(f.path,"SELECT id,applies_when FROM memory_records WHERE state='active'");
  assert.ok(active.some(row=>row.id===ids[2]));assert.ok(active.some(row=>row.id===ids[3]&&row.applies_when==='Only for private reports'));
});

test('new dependent evidence retains the forecast while the frozen review can be saved',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'e1');const snapshot=withPairs(await f.store.begin(settings,'events',true));
  await evidence(f,'e2');const row=snapshot.records.find(row=>row.kind==='evidence');
  const result=await f.store.apply(snapshot,output([],[{text:'May need XLSX.',applies_when:'For market reports',sources:[id]}],[hit(id,row.id)]),settings,undefined,{partial:true});
  assert.equal(result.hits,1);assert.equal(result.predictions,1);assert.equal(result.rejected[0].reason,'unsupported_sources/pending_evidence');
  const next=withPairs(await f.store.begin(settings,'events',true));assert.equal(next.records.filter(row=>row.kind==='evidence').length,1);
  assert.equal(next.records.find(row=>row.id===id).hits,1);
});

test('Runtime corrects only the rejected source and preserves the completed merge',async t=>{
  const f=await fixture(t);
  for(let i=0;i<3;i++)await f.store.summarize({habit:{text:`Report ${i}: `+'Keep dates and sources in reports. '.repeat(20),applies_when:i===2?'For private reports':undefined}},settings,{...f.owner,turnId:String(i)});
  let calls=0;
  const memory=runtimeMemory(f.path,provider((request,rows)=>{
    assert.equal(request.reasoningEffort,'max');assert.equal(request.maxOutputTokens,128000);
    if(++calls===1)return output([{text:'Include report dates and sources.',sources:rows.slice(0,2).map(row=>row.id)},
      {text:'Keep report sources.',sources:[rows[2].id]}]);
    assert.equal(rows.length,1);assert.equal(rows[0].applies_when,'For private reports');
    return output([{text:'Keep report sources.',applies_when:rows[0].applies_when,sources:[rows[0].id]}]);
  }));t.after(()=>memory.close());
  const result=await memory.compact(settings,model,true);assert.equal(calls,2);assert.equal(result.habits,2);assert.equal(result.lastError,null);
  assert.equal(model.reasoningEffort,'max');assert.equal(model.maxOutputTokens,128000);
});

test('shared evidence stays active until every selected forecast has been reviewed',async t=>{
  const f=await fixture(t);const a=await forecast(f);
  const b=(await f.store.summarize({prediction:{text:'Market report may need sources in an XLSX.'}},settings,{...f.owner,turnId:'other'})).writes[0].id;
  await evidence(f,'e1');let snapshot=await f.store.begin(settings,'events',true),row=snapshot.records.find(row=>row.kind==='evidence');
  const one={...snapshot,records:snapshot.records.filter(r=>r.id!==b),reviewPairs:[[a,row.id]]};
  await f.store.apply(one,output([],[],[hit(a,row.id)]),settings,undefined,{partial:true});
  assert.equal(inspect(f.path,`SELECT state FROM memory_records WHERE id='${row.id}'`)[0].state,'active');
  snapshot=await f.store.begin(settings,'events',true);
  const two={...snapshot,records:snapshot.records.filter(r=>r.id!==a),reviewPairs:[[b,row.id]]};
  const result=await f.store.apply(two,output(),settings,undefined,{partial:true});
  assert.equal(result.hits,1);assert.equal(result.misses,0);
  assert.equal(inspect(f.path,`SELECT outcome FROM memory_reviews WHERE id='${memoryHash(`${b}:${row.id}`)}'`)[0].outcome,'unknown');
  assert.equal(inspect(f.path,`SELECT state FROM memory_records WHERE id='${row.id}'`)[0].state,'consolidated');
});

test('review work cannot rewrite memory and an unqualified forecast causes no consolidation call',async t=>{
  const f=await fixture(t);await forecast(f);await evidence(f,'one');let calls=0;
  const memory=runtimeMemory(f.path,provider((request,rows)=>{
    calls++;assert.equal(request.metadata.memoryPhase,'review');assert.equal(request.reasoningEffort,'max');
    const p=rows.find(row=>row.kind==='prediction'),e=rows.find(row=>row.kind==='evidence');
    return output([{text:'Invented permanent preference',sources:[p.id,e.id]}],[],[hit(p.id,e.id)]);
  }));t.after(()=>memory.close());
  const status=await memory.compact(settings,model);assert.equal(calls,1);assert.equal(status.hits,1);assert.equal(status.habits,0);
  await memory.compact(settings,model);assert.equal(calls,1,'already reviewed evidence and unchanged small forecasts need no model work');
});

test('invalid scored reviews retain just their pairs while independent omitted pairs become unknown',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'one');await evidence(f,'two');
  const snapshot=withPairs(await f.store.begin(settings,'events',true)),rows=snapshot.records.filter(row=>row.kind==='evidence');
  const result=await f.store.apply(snapshot,output([],[],[{...hit(id,rows[0].id),quote:'fabricated decisive words'}]),settings,undefined,{partial:true});
  assert.equal(result.hits,0);assert.equal(result.rejected[0].reason,'invalid_review/missing_quote');
  assert.deepEqual(inspect(f.path,'SELECT outcome,evidence FROM memory_reviews').map(row=>({...row})),[{outcome:'unknown',evidence:rows[1].id}]);
  assert.equal(inspect(f.path,`SELECT state FROM memory_records WHERE id='${rows[0].id}'`)[0].state,'active');
});

test('conflicting duplicate reviews count neither answer and retain their source',async t=>{
  const f=await fixture(t),id=await forecast(f);await evidence(f,'one');
  const snapshot=withPairs(await f.store.begin(settings,'events',true)),e=snapshot.records.find(row=>row.kind==='evidence');
  const result=await f.store.apply(snapshot,output([],[],[hit(id,e.id),{...hit(id,e.id),outcome:'miss'}]),settings,undefined,{partial:true});
  assert.equal(result.hits,0);assert.equal(result.misses,0);assert.equal(result.rejected.length,2);
  assert.equal(inspect(f.path,'SELECT count(*) n FROM memory_reviews')[0].n,0);
});

test('a later batch failure retains earlier reviews and a restart processes only pending pairs',async t=>{
  const f=await fixture(t);await forecast(f);
  for(let i=0;i<35;i++)await evidence(f,`e${i}`,'Market report XLSX '+i+' '+ '请保留原始日期、范围和来源。'.repeat(25));
  const visited=[],accepted=new Set();let calls=0;
  const memory=runtimeMemory(f.path,{async *stream(request){
    const rows=JSON.parse(request.messages.at(-1).content);calls++;
    if(calls===2){yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'response_completed',finishReason:'length'};return;}
    for(const row of rows.filter(row=>row.kind==='evidence'))accepted.add(row.text);
    yield* provider(()=>output()).stream(request);
  }});
  await assert.rejects(memory.compact(settings,model),/memory_summary_output_limit/);await memory.close();
  assert.ok(accepted.size>0&&accepted.size<35);
  const resumed=runtimeMemory(f.path,provider((request,rows)=>{
    assert.equal(request.metadata.memoryPhase,'review');assert.equal(request.reasoningEffort,'max');
    for(const row of rows.filter(row=>row.kind==='evidence')){assert.ok(!accepted.has(row.text));visited.push(row.text);}
    return output();
  }));t.after(()=>resumed.close());
  const status=await resumed.compact(settings,model);assert.equal(status.lastError,null);
  assert.equal(accepted.size+visited.length,35);assert.equal(inspect(f.path,"SELECT count(*) n FROM memory_reviews WHERE outcome='unknown'")[0].n,35);
});

test('bounded concurrent Runtime reviews preserve all counts for a shared forecast',async t=>{
  const f=await fixture(t);await forecast(f);
  for(let i=0;i<35;i++)await evidence(f,`e${i}`,'Market report: dated XLSX file '+i+' '+ '请保留原始日期、范围和来源。'.repeat(25));
  const overlap=Promise.withResolvers();let active=0,peak=0,reviewCalls=0;
  const memory=runtimeMemory(f.path,provider(async(request,rows)=>{
    assert.equal(request.reasoningEffort,'max');assert.equal(request.maxOutputTokens,128000);
    assert.equal(request.metadata.memoryPhase,'review','a concise forecast stays usable without another inference call');
    reviewCalls++;peak=Math.max(peak,++active);if(active===2)overlap.resolve();await overlap.promise;
    active--;
    return output([],[],rows.filter(row=>row.kind==='evidence').flatMap(row=>row.reviewable_predictions.map(id=>hit(id,row.id))));
  }));t.after(()=>memory.close());
  const status=await memory.compact(settings,model);assert.ok(reviewCalls>=2);assert.equal(peak,2);
  assert.equal(status.hits,35);assert.equal(status.lastError,null);assert.equal(status.predictions,1);
});
