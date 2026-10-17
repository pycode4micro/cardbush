import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIndividuation } from '@cardbush/bush-protocol';
import { IndividuationMemory } from '../dist/individuationMemory.js';
import { IndividuationStore, MAX_ACTIVE_MEMORY_RECORDS, MAX_ACTIVE_EVIDENCE_RECORDS } from '../dist/individuationStore.js';
import { recallIndividuation } from '../dist/individuationContext.js';
import { registerIndividuationTools } from '../dist/individuationTools.js';
import { ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';

const settings=normalizeIndividuation({habits:true,predictions:true,eventTokenThreshold:1000,habitTokenThreshold:1000});
const owner={sessionId:'maintenance',turnId:'first'};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'cardbush-local-memory-'));
  let now=Date.now(),calls=0;
  const path=join(root,'personalization.sqlite');
  const store=new IndividuationStore(path,()=>now);
  const memory=new IndividuationMemory(path,async()=>{calls++;throw Error('Unexpected background model request');});
  t.after(async()=>{await memory.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  await store.summarize({habit:{text:'Keep dated sources in market reports.'}},settings,owner);
  return {root,path,store,memory,calls:()=>calls,advance(ms){now+=ms;},now:()=>now};
}
function sql(f,fn){const db=new DatabaseSync(f.path);try{return fn(db);}finally{db.close();}}
function seed(f,kind,count,{tokens=100,expires=null}={}){
  sql(f,db=>{
    const insert=db.prepare('INSERT INTO memory_records(id,kind,text,scope,tokens,created,updated,metadata,expires) VALUES(?,?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for(let i=0;i<count;i++)insert.run(`seed_${kind}_${i}`,kind,`Retained ${kind} ${i}`,kind==='habit'?1:2,tokens,f.now(),f.now(),'{}',expires);
    db.exec('COMMIT');
  });
}

test('conversation maintenance never calls a model, even above both manual thresholds',async t=>{
  const f=await fixture(t);
  seed(f,'habit',30);seed(f,'prediction',30);
  const before=await f.store.status(settings);
  assert.ok(before.habitTokens>1000&&before.eventTokens>1000);
  const first=f.memory.schedule(settings),second=f.memory.schedule(settings);
  assert.equal(first,second,'concurrent hooks share local housekeeping');
  await first;await f.memory.schedule(settings);await f.memory.status(settings);
  assert.equal(f.calls(),0);
  const after=await f.store.status(settings);
  assert.equal(after.records,before.records);assert.equal(after.hits,0);assert.equal(after.misses,0);
  assert.equal(after.lastSummaryAt,null);assert.equal(after.lastError,null);
});

test('automatic recall does not collect subsequent user messages as evaluation evidence',async t=>{
  const f=await fixture(t);
  await f.store.summarize({prediction:{text:'Export a dated market report.',applies_when:'When requesting a market report'}},settings,{...owner,turnId:'forecast'});
  for(let i=0;i<12;i++){
    const recall=await recallIndividuation(f.store,settings,'Export a dated market report.',[],{...owner,turnId:`next-${i}`});
    assert.ok(recall);assert.ok(JSON.parse(recall.content).memories.length<=5);
  }
  assert.equal(sql(f,db=>db.prepare("SELECT COUNT(*) n FROM memory_records WHERE kind='evidence'").get().n),0);
  assert.equal((await f.store.status(settings)).predictions,1);
});

test('large retained evidence has its own quota and cannot block habits, predictions or feedback',async t=>{
  const f=await fixture(t);
  seed(f,'evidence',MAX_ACTIVE_EVIDENCE_RECORDS,{tokens:600});
  const before=await f.store.status(settings);
  assert.equal(before.records,1);assert.equal(before.eventTokens,0);
  assert.equal(before.evidenceRecords,MAX_ACTIVE_EVIDENCE_RECORDS);
  assert.equal(before.evidenceTokens,MAX_ACTIVE_EVIDENCE_RECORDS*600);
  assert.equal(before.estimatedTokens,before.habitTokens);
  const result=await f.store.summarize({habit:{text:'Use concise Chinese explanations.'},prediction:{text:'Export a dated market report.'}},settings,{...owner,turnId:'write'});
  assert.equal(result.saved,true);assert.ok(result.writes.every(row=>row.status==='created'));
  const feedback=await f.store.feedback({sessionId:owner.sessionId,turnId:'write',messageId:'reply',rating:'up'},settings,'rating',{user:'Export a dated market report.',assistant:'The report is ready.'});
  assert.equal(feedback.status,'ok');
  await f.store.observe('Export a dated market report.',settings,{...owner,turnId:'explicit-evaluation'});
  assert.equal((await f.store.status(settings)).evidenceRecords,MAX_ACTIVE_EVIDENCE_RECORDS,'explicit evaluation is bounded independently');
});

test('storage admission does not use manual consolidation token thresholds',async t=>{
  const f=await fixture(t);seed(f,'habit',500,{tokens:400});
  assert.ok((await f.store.status(settings)).estimatedTokens>80_000);
  const result=await f.store.summarize({habit:{text:'Include source links.'}},settings,{...owner,turnId:'after-large-store'});
  assert.equal(result.saved,true);
  const recall=await recallIndividuation(f.store,settings,'Include source links.',[],{...owner,turnId:'recall'});
  assert.ok(JSON.parse(recall.content).memories.some(row=>row.text==='Include source links.'));
});

test('record cap allows deduplication and rejects a two-record write atomically',async t=>{
  const f=await fixture(t);seed(f,'habit',MAX_ACTIVE_MEMORY_RECORDS-2);
  const result=await f.store.summarize({habit:{text:'Use concise tables.'},prediction:{text:'Export another table.'}},settings,{...owner,turnId:'two'});
  assert.equal(result.saved,false);assert.ok(result.writes.every(row=>row.reason==='memory_capacity_reached'));
  assert.equal((await f.store.status(settings)).records,MAX_ACTIVE_MEMORY_RECORDS-1);
  assert.equal((await f.store.summarize({habit:{text:'Use concise tables.'}},settings,{...owner,turnId:'one'})).saved,true);
  const repeat=await f.store.summarize({habit:{text:'Use concise tables.'}},settings,{...owner,turnId:'repeat'});
  assert.equal(repeat.writes[0].status,'deduplicated');
  assert.equal((await f.store.summarize({habit:{text:'Use source footnotes.'}},settings,{...owner,turnId:'overflow'})).writes[0].reason,'memory_capacity_reached');
});

test('local expiry and evidence archiving preserve raw sources, pinned habits and undo',async t=>{
  const f=await fixture(t);
  const habit=(await f.store.read({topics:['market reports']},settings)).memories[0];
  await f.store.change({id:habit.id,revision:habit.revision,action:'confirm',reason:'Keep this preference.'},settings,{...owner,turnId:'pin'},'user');
  await f.store.summarize({prediction:{text:'Export a dated market report.'}},settings,{...owner,turnId:'forecast'});
  await f.store.observe('Export a dated market report.',settings,{...owner,turnId:'later'});
  const before=sql(f,db=>db.prepare("SELECT * FROM memory_records WHERE kind='evidence'").get());
  await f.store.maintain(settings);
  assert.equal((await f.store.status(settings)).evidenceRecords,1,'pending reviews are retained');
  f.advance(8*86400000);
  const after=await f.store.maintain(settings);
  assert.equal(after.predictions,0);assert.equal(after.habits,1);assert.equal(after.evidenceRecords,0);
  assert.equal(after.lastSummaryAt,null);assert.equal(after.hits,0);assert.equal(after.misses,0);
  const raw=sql(f,db=>db.prepare('SELECT * FROM memory_records WHERE id=?').get(before.id));
  assert.equal(raw.text,before.text);assert.equal(raw.metadata,before.metadata);assert.equal(raw.state,'consolidated');
  const pinned=(await f.store.read({ids:[habit.id]},settings)).memories[0];
  assert.equal(pinned.state,'active');assert.equal(pinned.origin,'user');
  const change=(await f.store.history(settings)).changes.find(row=>row.actor==='maintenance');
  assert.ok(change?.can_undo);
  assert.equal((await f.store.undo(change.id,settings,{...owner,turnId:'undo'})).status,'ok');
  assert.equal(sql(f,db=>db.prepare('SELECT state FROM memory_records WHERE id=?').get(before.id).state),'active');
});

test('local maintenance leaves manual snapshots alone and tolerates full undo history',async t=>{
  const f=await fixture(t);seed(f,'evidence',1);
  const snapshot=await f.store.begin(settings,'habits',true);
  await f.store.maintain(settings);
  assert.equal((await f.store.status(settings)).evidenceRecords,1);
  await f.store.fail(snapshot.lease,'manual job stopped');
  sql(f,db=>{
    db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO memory_changes(id,created,actor,reason,before_rows,after_rows) SELECT 'full_'||x,0,'user','fixture','[]','[]' FROM n");
  });
  assert.equal((await f.store.maintain(settings)).evidenceRecords,1,'full history retains raw evidence instead of failing housekeeping');
});

test('summary_for_user retains its final-display signal and writes without background model work',async t=>{
  const f=await fixture(t),registry=new ToolRegistry();
  registerIndividuationTools(registry,f.path,f.memory);
  const coordinator=new ToolExecutionCoordinator({registry,permissions:{request(){throw Error('Unexpected permission');}}});
  for(const [index,args] of [{habit:{text:'Include source links.'}},{}].entries()){
    const result=await coordinator.execute({protocol:'bush.tool_call.v1',id:`summary-${index}`,name:'summary_for_user',argumentsText:JSON.stringify(args)},
      {requestId:'r',sessionId:'current',turnId:'t',round:index,ordinal:0},undefined,
      {request:{metadata:{individuation:settings},tools:registry.definitions(),permissionMode:'task_free'},contextMessages:[{role:'user',content:'Include source links.'}]});
    assert.equal(result.kind,'returned');assert.equal(result.result.final_response,true);
    if(index===0)assert.equal(result.result.saved,true);
  }
  await f.memory.close();assert.equal(f.calls(),0);
});
