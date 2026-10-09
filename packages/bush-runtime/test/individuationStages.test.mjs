import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { normalizeIndividuation } from '@cardbush/bush-protocol';
import { IndividuationStore } from '../dist/individuationStore.js';
import { IndividuationMemory } from '../dist/individuationMemory.js';
import { memoryTokens } from '../dist/individuationText.js';

const settings=normalizeIndividuation({habits:true,predictions:true,eventTokenThreshold:1000,habitTokenThreshold:1000});
const owner={sessionId:'stages',turnId:'forecast'};
const model={model:'fixture',reasoningEffort:'max',maxOutputTokens:128000,metadata:{contextWindowTokens:400000}};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'cardbush-memory-stages-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const path=join(root,'personalization.sqlite');return {path,store:new IndividuationStore(path)};
}
const write=(store,kind,text,turn)=>store.summarize({[kind]:{text}},settings,{...owner,turnId:turn});
const review=(prediction,evidence,outcome='hit')=>({prediction,evidence,outcome,reason:'Explicit subsequent user request'});
const result=(habits=[],predictions=[],reviews=[])=>({habits,predictions,reviews});
const provider=fn=>({async *stream(request){
  const data=await fn(request,JSON.parse(request.messages.at(-1).content));
  yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'text_delta',delta:JSON.stringify(data)};
  yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:1,kind:'response_completed',finishReason:'stop'};
}});

test('promotion crossing the habit threshold immediately runs one full habit pass',async t=>{
  const f=await fixture(t),stages=[];
  await write(f.store,'habit','既有习惯：用简短中文解释结果。','existing');
  for(let i=0;i<5;i++){
    const tag=`Market${i}`;
    await write(f.store,'prediction',`${tag}: May need a dated XLSX market report.`,'p'+i);
    for(let j=0;j<2;j++)await f.store.observe(`${tag}: Please provide the XLSX report. `+'Include the date, sources and price history. '.repeat(20),settings,{...owner,turnId:`e${i}-${j}`});
  }
  const initial=await f.store.status(settings);assert.ok(initial.eventTokens>=1000&&initial.habitTokens<1000);
  const memory=new IndividuationMemory(f.path,provider(async(request,rows)=>{
    stages.push(request.metadata.memoryStage);assert.equal(request.maxOutputTokens,128000);assert.equal(request.reasoningEffort,'max');
    if(stages.length===1){
      assert.equal(rows.length,15);assert.ok(rows.every(row=>row.kind!=='habit'));
      const forecasts=rows.filter(row=>row.kind==='prediction'),reviews=[];
      const habits=forecasts.map((forecast,i)=>{
        const evidence=rows.filter(row=>row.kind==='evidence'&&row.text.startsWith(`Market${i}:`));assert.equal(evidence.length,2);
        for(const row of evidence)reviews.push(review(forecast.id,row.id));
        return {text:`Market${i}: `+'For financial analysis provide an XLSX report with dated prices and sources. '.repeat(12),sources:[forecast.id,...evidence.map(row=>row.id)]};
      });
      return result(habits,[],reviews);
    }
    assert.ok(rows.every(row=>row.kind==='habit'));assert.equal(rows.length,6,'existing and newly promoted habits are compacted together');
    assert.ok((await f.store.status(settings)).habitTokens>=1000);
    return result([{text:'用简短中文说明；市场分析附带日期、价格和来源的 XLSX 报告。',sources:rows.map(row=>row.id)}]);
  }));t.after(()=>memory.close());
  const status=await memory.compact(settings,model,false);
  assert.deepEqual(stages,['events','habits']);assert.equal(status.records,1);assert.equal(status.hits,10);assert.equal(status.eventTokens,0);
  assert.ok(status.habitTokens<1000&&status.estimatedTokens<initial.estimatedTokens);
  await memory.compact(settings,model,false);assert.equal(stages.length,2);
});

test('one hit remains a forecast and a later independent hit completes the promotion cycle',async t=>{
  const f=await fixture(t);
  await write(f.store,'prediction','Market XLSX: The next market analysis may need a dated spreadsheet with sources.','p');
  await f.store.observe('Please give me the Market XLSX with prices, dates and sources.',settings,{...owner,turnId:'first-hit'});
  let snapshot=await f.store.begin(settings,'events',true),forecast=snapshot.records.find(row=>row.kind==='prediction'),evidence=snapshot.records.find(row=>row.kind==='evidence');
  await f.store.apply(snapshot,result([],[{text:'Market analysis may need XLSX.',sources:[forecast.id,evidence.id]}],[review(forecast.id,evidence.id)]),settings);
  let status=await f.store.status(settings);assert.equal(status.habits,0);assert.equal(status.predictions,1);assert.equal(status.hits,1);
  await f.store.observe('Again, please provide the Market XLSX with dates and sources for this analysis.',settings,{...owner,turnId:'second-hit'});
  snapshot=await f.store.begin(settings,'events',true);forecast=snapshot.records.find(row=>row.kind==='prediction');evidence=snapshot.records.find(row=>row.kind==='evidence');
  assert.equal(forecast.hits,1);
  status=await f.store.apply(snapshot,result([{text:'Market analysis uses dated XLSX reports.',sources:[forecast.id,evidence.id]}],[],[review(forecast.id,evidence.id)]),settings);
  assert.equal(status.hits,2);assert.equal(status.habits,1);assert.equal(status.predictions,0);
  assert.equal((await f.store.check('Market XLSX',settings))[0].hits,2);
});

test('unknown or single-hit predictions cannot be promoted, even above the token threshold',async t=>{
  const f=await fixture(t);await write(f.store,'prediction','Market XLSX: may need a market spreadsheet report.','p');
  await f.store.observe('Please provide the Market XLSX report with sources.',settings,{...owner,turnId:'e'});
  const snapshot=await f.store.begin(settings,'events',true),forecast=snapshot.records.find(row=>row.kind==='prediction'),evidence=snapshot.records.find(row=>row.kind==='evidence');
  const before=await f.store.status(settings);
  for(const reviews of [[],[review(forecast.id,evidence.id)]]){
    await assert.rejects(f.store.apply(snapshot,result([{text:'Always use XLSX.',sources:[forecast.id,evidence.id]}],[],reviews),settings),error=>error.reason==='unsupported_promotion');
    const after=await f.store.status(settings);assert.equal(after.hits,0);assert.equal(after.estimatedTokens,before.estimatedTokens);assert.equal(after.historyChanges,before.historyChanges);
  }
});

test('one user event matching two forecasts cannot fabricate repeated support',async t=>{
  const f=await fixture(t);
  await write(f.store,'prediction','Market XLSX: may need prices in a spreadsheet.','p1');
  await write(f.store,'prediction','Market XLSX: may ask for a dated spreadsheet.','p2');
  await f.store.observe('Please provide a Market XLSX spreadsheet report with date and price data.',settings,{...owner,turnId:'same-event'});
  const snapshot=await f.store.begin(settings,'events',true),forecasts=snapshot.records.filter(row=>row.kind==='prediction'),evidence=snapshot.records.find(row=>row.kind==='evidence');
  assert.equal(JSON.parse(evidence.metadata).related.length,2);
  await assert.rejects(f.store.apply(snapshot,result([{text:'Market analysis needs XLSX.',sources:snapshot.records.map(row=>row.id)}],[],forecasts.map(row=>review(row.id,evidence.id))),settings),error=>error.reason==='unsupported_promotion');
  assert.equal((await f.store.status(settings)).hits,0);
});

test('new dependent evidence cancels the stale snapshot without duplicating originals',async t=>{
  const f=await fixture(t);await write(f.store,'prediction','Market XLSX: may need a dated market spreadsheet report.','p');
  await f.store.observe('Please supply a Market XLSX report.',settings,{...owner,turnId:'e1'});
  const snapshot=await f.store.begin(settings,'events',true),forecast=snapshot.records.find(row=>row.kind==='prediction'),evidence=snapshot.records.find(row=>row.kind==='evidence');
  await f.store.observe('Also provide the Market XLSX with sources.',settings,{...owner,turnId:'e2'});
  const before=await f.store.status(settings);
  await assert.rejects(f.store.apply(snapshot,result([],[{text:'May need Market XLSX.',sources:[forecast.id,evidence.id]}],[review(forecast.id,evidence.id)]),settings),error=>error.code==='memory_snapshot_changed');
  const after=await f.store.status(settings);assert.equal(after.estimatedTokens,before.estimatedTokens);assert.equal(after.hits,0);assert.equal(after.historyChanges,before.historyChanges);
  await f.store.fail(snapshot.lease,'fixture release');
  assert.equal((await f.store.begin(settings,'events',true)).records.length,3,'the next pass contains both user events');
});

test('compression validates actual active tokens including provenance and rolls back growth',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)await write(f.store,'habit','H'+i,String(i));
  const snapshot=await f.store.begin(settings,'habits',true),before=await f.store.status(settings);
  // Shorter visible text still grows storage once all source IDs are included.
  const text='x'.repeat(Math.floor(snapshot.tokens*.64)*3.5);
  assert.ok(memoryTokens(text)<=snapshot.tokens*.65);
  assert.ok(memoryTokens(text+JSON.stringify({sources:snapshot.records.map(row=>row.id)}))>snapshot.tokens);
  await assert.rejects(f.store.apply(snapshot,result([{text,sources:snapshot.records.map(row=>row.id)}]),settings),error=>error.reason==='insufficient_reduction');
  const after=await f.store.status(settings);assert.equal(after.estimatedTokens,before.estimatedTokens);assert.equal(after.historyChanges,before.historyChanges);assert.equal(after.habits,10);
});

test('a completed stage stays idle even if pinned memory still exceeds the threshold',async t=>{
  const f=await fixture(t);
  for(let i=0;i<4;i++){
    const saved=await write(f.store,'habit','Pinned '+i+': '+'Use dated reports with sources. '.repeat(35),'p'+i),id=saved.writes[0].id;
    await f.store.change({id,revision:1,action:'confirm',reason:'Pinned by user'},settings,{...owner,turnId:'pin'+i},'user');
  }
  await write(f.store,'habit','Use a compact table for reports with date and source columns.','ordinary');
  const snapshot=await f.store.begin(settings,'habits',false);assert.equal(snapshot.records.length,1);
  await f.store.apply(snapshot,result([{text:'Use compact tables.',sources:snapshot.records.map(row=>row.id)}]),settings);
  assert.ok((await f.store.status(settings)).habitTokens>1000);
  assert.equal(await f.store.begin(settings,'habits',false),null,'unchanged successful outputs do not create a maintenance loop');
});
