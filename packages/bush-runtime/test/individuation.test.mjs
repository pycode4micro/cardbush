import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { normalizeIndividuation, summaryForUserInputSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionCoordinator, ToolExecutionStore, InMemoryRuntimeHost,
  InMemoryRuntimeEventLog, RuntimeEventProjector } from '../dist/index.js';
import { registerIndividuationTools, hasPendingUserSummary, deliveredMemoryIds } from '../dist/individuationTools.js';
import { IndividuationStore } from '../dist/individuationStore.js';
import { IndividuationMemory } from '../dist/individuationMemory.js';
import { memoryTokens } from '../dist/individuationText.js';

const off=normalizeIndividuation(),on=normalizeIndividuation({habits:true,predictions:true});
const habits=normalizeIndividuation({habits:true}),predictions=normalizeIndividuation({predictions:true});
const owner={sessionId:'first',turnId:'one'};
const memoryInput=input=>Object.fromEntries(Object.entries(input).map(([key,value])=>[key,typeof value==='string'?{text:value}:value]));
const write=(store,input,...args)=>store.summarize(memoryInput(input),...args);
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'cardbush-individuation-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const path=join(root,'personalization.sqlite'),registry=new ToolRegistry();registerIndividuationTools(registry,path);
  const coordinator=new ToolExecutionCoordinator({registry,permissions:{request(){throw Error('Unexpected permission');}}});let calls=0;
  return {root,path,registry,store:new IndividuationStore(path),async run(name,args,settings=off,identity=owner,messages=[]) {
    if(name==='summary_for_user')args=memoryInput(args);
    const call={protocol:'bush.tool_call.v1',id:`call-${++calls}`,name,argumentsText:JSON.stringify(args)};
    return coordinator.execute(call,{requestId:'r',...identity,round:calls,ordinal:0},undefined,
      {request:{metadata:{individuation:settings},tools:registry.definitions(),permissionMode:'task_free'},contextMessages:messages});
  }};
}
const result=value=>{assert.equal(value.kind,'returned',JSON.stringify(value));return value.result;};
const model={model:'fixture',metadata:{maxContextTokens:32000}};
const summarizeProvider=fn=>({async *stream(request){let records;try{records=JSON.parse(request.messages.at(-1).content);}catch{}const answer=await fn(request,records);
  yield event(request,0,'text_delta',{delta:typeof answer==='string'?answer:JSON.stringify(answer)});
  yield event(request,1,'response_completed',{finishReason:'stop'});}});

test('optional free text tools keep compact receipts and do not open a database while disabled',async t=>{
  const f=await fixture(t);
  assert.equal(f.registry.isParallelSafe('summary_for_user'),true);
  assert.deepEqual(Object.keys(f.registry.definitions().find(t=>t.name==='summary_for_user').inputSchema.properties),['habit','prediction']);
  assert.equal(summaryForUserInputSchema.safeParse({summary:'mixed note'}).success,false,'the public API no longer accepts a mixed summary');
  assert.deepEqual(Object.keys(f.registry.definitions().find(t=>t.name==='check_habit').inputSchema.properties),['mode','kind','cursor','topics','ids','count_only']);
  assert.deepEqual(result(await f.run('summary_for_user',{habit:'用户关注 A 股走势。',prediction:'用户可能还需要 XLSX 报表。'})),{status:'ok',final_response:true,saved:false,writes:[{category:'habit',status:'skipped',reason:'category_disabled'},{category:'prediction',status:'skipped',reason:'category_disabled'}]});
  assert.equal(result(await f.run('check_habit',{})).status,'disabled');
  assert.deepEqual(result(await f.run('summary_for_user',{},on)),{status:'ok',final_response:true,saved:false,writes:[]},
    'enabled memory with nothing new to save still supports the final-display signal');
  await assert.rejects(access(f.path),{code:'ENOENT'});
});

test('deduplication, independent gates, cross-session search and bounded retrieval',async t=>{
  const f=await fixture(t);
  const note='查看 A 股走势时，用户偏好 XLSX 数据表。';
  await f.run('summary_for_user',{habit:note},habits);
  assert.equal(result(await f.run('summary_for_user',{habit:note+' '},habits)).writes.every(entry=>entry.status==='deduplicated'),true);
  assert.equal((await f.store.status(habits)).records,1);
  const found=await new IndividuationStore(f.path).check('A 股 数据表',habits);
  assert.equal(found.length,1);assert.equal(found[0].text,note);
  assert.deepEqual(await f.store.check('数据表',predictions),[]);
  const before=await readFile(f.path);await f.run('summary_for_user',{habit:'not saved'},off);
  assert.deepEqual(await readFile(f.path),before);
  for(let i=0;i<20;i++) await write(f.store,{habit:`用户在股市分析场景 ${i} 的偏好：`+'A 股数据和数据表需要核实，'.repeat(12)},habits,{...owner,turnId:String(i)});
  const many=await f.store.check('股市 数据表',habits);
  assert.ok(many.length<=5);assert.ok(memoryTokens(JSON.stringify(many))<=1000);
  assert.deepEqual(await f.store.check('不会匹配的蛋糕话题',habits),[]);
  assert.deepEqual(await f.store.check('',off),[]);
  const excluded=await f.store.check('A 股 数据表',habits,found.map(r=>r.id));assert.ok(excluded.every(r=>r.id!==found[0].id));
});

test('habit and prediction are persisted and retrieved independently before any model summary',async t=>{
  const f=await fixture(t),input={habit:'查看股市走势时默认关注 A 股。',prediction:'查看 A 股后可能需要 XLSX 报表。'};
  const saved=result(await f.run('summary_for_user',input,on));
  assert.equal(saved.final_response,true);assert.equal(saved.saved,true);assert.deepEqual(saved.writes.map(row=>[row.category,row.status]),[['habit','created'],['prediction','created']]);assert.ok(saved.writes.every(row=>row.id));
  const status=await f.store.status(on);assert.equal(status.habits,1);assert.equal(status.predictions,1);assert.equal(status.notes,0);
  for(const [kind,settings] of [['habit',habits],['prediction',predictions]]) {
    const records=await new IndividuationStore(f.path).check('',settings);
    assert.equal(records.length,1);assert.equal(records[0].kind,kind);assert.equal(records[0].text,input[kind]);
  }
  const snapshot=await f.store.begin(on,true,10000);
  assert.deepEqual(snapshot.records.map(r=>[r.kind,r.scope]),[['habit',1],['prediction',2]]);
});

test('each optional field follows only its own switch and never opens storage for a disabled category',async t=>{
  for(const [kind,disabled,settings] of [['habit','prediction',habits],['prediction','habit',predictions]]) {
    const f=await fixture(t);
    assert.deepEqual(result(await f.run('summary_for_user',{[disabled]:'disabled category'},settings)),{status:'ok',final_response:true,saved:false,writes:[{category:disabled,status:'skipped',reason:'category_disabled'}]});
    await assert.rejects(access(f.path),{code:'ENOENT'});
    const saved=result(await f.run('summary_for_user',{habit:'需要简明回答',prediction:'可能需要进一步解释'},settings));
    assert.equal(saved.saved,true);assert.deepEqual(saved.writes.filter(row=>row.status==='created').map(row=>row.category),[kind]);
    const records=await f.store.check('',on);assert.equal(records.length,1);assert.equal(records[0].kind,kind);
    const before=await readFile(f.path);
    assert.equal(result(await f.run('summary_for_user',{[disabled]:'still disabled'},settings)).saved,false);
    assert.deepEqual(await readFile(f.path),before);
  }
});

test('deduplication and already-delivered filtering cannot collapse different memory categories',async t=>{
  const f=await fixture(t),text='股市分析需要 XLSX 数据表',input={habit:text,prediction:text};
  await f.run('summary_for_user',input,on);
  assert.equal(result(await f.run('summary_for_user',input,on)).writes.every(entry=>entry.status==='deduplicated'),true);
  const records=await f.store.check('XLSX',on);assert.deepEqual(records.map(r=>r.kind).sort(),['habit','prediction']);
  const habit=records.find(r=>r.kind==='habit'),forecast=records.find(r=>r.kind==='prediction');
  assert.deepEqual((await f.store.check('XLSX',on,[habit.id])).map(r=>r.id),[forecast.id]);
  const snapshot=await f.store.begin(on,true,10000);assert.equal(snapshot.records.length,2);
  assert.ok(snapshot.records.every(r=>r.observations===1),'same-turn replay does not add observations');
});

test('prediction evidence survives disabling habits and habits cannot be reviewed as forecasts',async t=>{
  const f=await fixture(t);let time=1000;const store=new IndividuationStore(f.path,()=>time);
  await write(store,{habit:'用户查看股市时通常关注 A 股。'},on,owner);
  time+=100;await store.observe('请查看 A 股走势',on,{...owner,turnId:'two'});
  assert.equal((await store.status(on)).records,1,'a habit alone must not collect prediction evidence');
  await write(store,{prediction:'查看 A 股后，用户可能需要 XLSX 数据表。'},on,{...owner,turnId:'two'});
  time+=100;await store.observe('请给我一份 A 股 XLSX 数据表',on,{...owner,turnId:'three'});
  const all=await store.begin(on,true,10000),habit=all.records.find(r=>r.kind==='habit'),forecast=all.records.find(r=>r.kind==='prediction'),evidence=all.records.find(r=>r.kind==='evidence');
  assert.deepEqual(JSON.parse(evidence.metadata).related,[forecast.id]);assert.equal(evidence.scope,2);
  await assert.rejects(store.apply(all,{habits:[],predictions:[],reviews:[{prediction:habit.id,evidence:evidence.id,outcome:'hit',reason:'invalid category'}]},on),/subsequent user evidence/);
  await store.fail(all.lease,'fixture release');
  const onlyPredictions=await store.begin(predictions,true,10000);
  assert.deepEqual(onlyPredictions.records.map(r=>r.kind),['prediction','evidence']);
  const reviewed=await store.apply(onlyPredictions,{habits:[],predictions:[{text:'看 A 股后可能需要 XLSX。',sources:[forecast.id,evidence.id]}],
    reviews:[{prediction:forecast.id,evidence:evidence.id,outcome:'hit',reason:'用户明确要求 XLSX'}]},predictions);
  assert.equal(reviewed.hits,1);assert.equal(reviewed.predictions,1);
  assert.deepEqual((await store.check('',habits)).map(r=>r.id),[habit.id],'reviewing predictions leaves habits untouched');
});

test('an oversized enabled category rejects the write atomically without losing the final-display signal',async t=>{
  const f=await fixture(t),input={habit:'偏好简洁回答',prediction:'长'.repeat(300)};
  assert.ok(memoryTokens(input.prediction)>400);
  assert.deepEqual(result(await f.run('summary_for_user',input,on)),
    {status:'ok',final_response:true,saved:false,writes:[{category:'habit',status:'rejected',reason:'atomic_write_rejected'},{category:'prediction',status:'rejected',reason:'note_too_long'}]});
  await assert.rejects(access(f.path),{code:'ENOENT'});
  assert.deepEqual(result(await f.run('summary_for_user',input,habits)).writes.filter(row=>row.status==='created').map(row=>row.category),['habit'],'disabled content is not stored or token-validated');
});

test('failed and cancelled persistence leave final response available',async t=>{
  const f=await fixture(t),registry=new ToolRegistry();registerIndividuationTools(registry,f.root);
  const returned=await registry.resolve('summary_for_user').execute({input:summaryForUserInputSchema.parse(memoryInput({habit:'偏好简洁回答'})),...owner,turn:{request:{metadata:{individuation:on}},contextMessages:[]}});
  assert.equal(returned.final_response,true);assert.equal(returned.storage_status,'unavailable');
  const controller=new AbortController();controller.abort();
  await assert.rejects(write(f.store,{habit:'text'},on,owner,'',controller.signal),{name:'AbortError'});
  await assert.rejects(access(f.path),{code:'ENOENT'});
});

test('threshold invokes one protocol-independent model summary, replaces records, and coalesces concurrent requests',async t=>{
  const f=await fixture(t),settings={...on,summaryTokenThreshold:1000};let calls=0;
  const gate=Promise.withResolvers();
  const memory=new IndividuationMemory(f.path,summarizeProvider(async(request,rows)=>{
    calls++;assert.deepEqual(request.tools,[]);assert.equal(request.metadata.runtimeMaintenance,'personalization_summary');await gate.promise;
    return {habits:[{text:'查看 A 股时提供 XLSX 数据表。',sources:rows.filter(r=>r.kind==='habit').map(r=>r.id)}],predictions:[],reviews:[]};
  }));t.after(()=>memory.close());
  await memory.compact(settings,model,false);assert.equal(calls,0);
  for(let i=0;i<8;i++) await write(f.store,{habit:`第${i}次：`+'用户明确要求查看大 A 股市并提供 XLSX 数据表。'.repeat(8)},settings,{...owner,turnId:String(i)});
  assert.ok((await f.store.status(settings)).estimatedTokens>=1000);
  const a=memory.compact(settings,model,false),b=memory.compact(settings,model,false);assert.equal(a,b);
  await until(()=>calls===1);assert.equal((await f.store.status(settings)).running,true);
  gate.resolve();const status=await a;assert.equal(status.notes,0);assert.equal(status.habits,1);assert.ok(status.estimatedTokens<1000);assert.equal(status.running,false);
  await memory.compact(settings,model,false);assert.equal(calls,1,'no repeated auto-summary without new data');
  assert.equal((await f.store.check('A 股 数据表',settings))[0].kind,'habit');
});

test('reviews require later user evidence, persist hits/misses, and consolidate conditional habits',async t=>{
  const f=await fixture(t);let time=1000;const store=new IndividuationStore(f.path,()=>time);
  await write(store,{prediction:'预测：下一次看 A 股走势时可能还会要求 XLSX 数据表。'},on,owner,'看看大 A 走势');
  time+=100;await store.observe('再看 A 股走势，还要一份 XLSX 数据表。',on,{...owner,turnId:'two'});
  time+=100;await store.observe('下次不要自动生成 XLSX 数据表，这次不需要。',on,{...owner,turnId:'three'});
  const snapshot=await store.begin(on,true,10000);const note=snapshot.records.find(r=>r.kind==='prediction');const evidence=snapshot.records.filter(r=>r.kind==='evidence');assert.equal(evidence.length,2);
  const output={habits:[{text:'A 股分析可按需提供 XLSX；用户明确不需要时不要生成。',sources:[note.id,...evidence.map(r=>r.id)]}],predictions:[],
    reviews:[{prediction:note.id,evidence:evidence[0].id,outcome:'hit',reason:'用户明确要求数据表'},{prediction:note.id,evidence:evidence[1].id,outcome:'miss',reason:'用户明确拒绝自动生成'}]};
  const stats=await store.apply(snapshot,output,on);assert.equal(stats.hits,1);assert.equal(stats.misses,1);assert.equal(stats.records,1);
  assert.equal((await store.check('XLSX',on))[0].hits,1);
  await assert.rejects(store.apply(snapshot,output,on),/superseded/,'a completed snapshot cannot count again');
});

test('invalid model output, invented evidence, and concurrent writes preserve original memory',async t=>{
  const f=await fixture(t);await write(f.store,{prediction:'用户常要 A 股数据表；是否每次都要尚未验证。'},on,owner);
  const snapshot=await f.store.begin(on,true,10000),source=snapshot.records[0];
  await assert.rejects(f.store.apply(snapshot,{habits:[],predictions:[],reviews:[{prediction:source.id,evidence:source.id,outcome:'hit',reason:'invented'}]},on),/subsequent user evidence/);
  assert.equal((await f.store.status(on)).records,1);await f.store.fail(snapshot.lease,'invalid evidence');
  let calls=0;const memory=new IndividuationMemory(f.path,summarizeProvider(()=>{calls++;return 'bad JSON';}));
  await assert.rejects(memory.compact(on,model,true));assert.equal((await f.store.status(on)).records,1);assert.ok((await f.store.status(on)).lastError);
  await memory.compact({...on,summaryTokenThreshold:1000},model,false);assert.equal(calls,1);
  const gate=Promise.withResolvers(),entered=Promise.withResolvers();const concurrent=new IndividuationMemory(f.path,summarizeProvider(async(_,rows)=>{entered.resolve();await gate.promise;return {habits:[{text:'按需提供 A 股数据表',sources:[rows[0].id]}],predictions:[],reviews:[]};}));
  const running=concurrent.compact(on,model);await entered.promise;
  await write(f.store,{habit:'用户新要求：xlsx 内同时保存来源日期。'},on,{...owner,turnId:'new'});gate.resolve();
  await assert.rejects(running);assert.equal((await f.store.status(on)).records,2,'new and old memory both survive conflict');
});

test('automatic context is relevant, bounded, internal and not duplicated by follow-up tools or later turns',async t=>{
  const f=await fixture(t),seen=[];
  await write(f.store,{habit:'查看 A 股趋势时偏好 XLSX 数据表。'},habits,owner,'以后看 A 股走势都加上数据表');
  const host=new InMemoryRuntimeHost({dataRoot:f.root,registerDefaultWorkspaceTools:false,provider:summarizeProvider(request=>{seen.push(structuredClone(request));return 'answer';})});
  t.after(()=>host.sendCommand({kind:'runtime.shutdown',payload:{}}));
  const request=id=>({protocol:'bush.session_turn_request.v1',requestId:id,sessionId:'dialog',turnId:id,model:'fixture',tools:[],prefixMessages:[],
    inputMessages:[{messageId:`u-${id}`,message:{role:'user',content:'查看 A 股趋势'}}],metadata:{individuation:habits}});
  assert.equal((await host.runSessionTurn(request('one'))).payload.status,'completed');
  const refs=seen[0].messages.filter(m=>m.name==='habit_reference');assert.equal(refs.length,1);assert.equal(refs[0].visibility,'internal');assert.ok(memoryTokens(refs[0].content)<=600);
  assert.deepEqual(await f.store.check('A 股 趋势',habits,deliveredMemoryIds(seen[0].messages)),[]);
  assert.equal((await host.runSessionTurn(request('two'))).payload.status,'completed');assert.equal(seen[1].messages.filter(m=>m.name==='habit_reference').length,1);
  const toolMessages=[{role:'assistant',content:'',toolCalls:[{id:'lookup',name:'check_habit',argumentsText:'{}'}]},
    {role:'tool',toolCallId:'lookup',content:JSON.stringify({memories:JSON.parse(refs[0].content).memories})}];
  assert.deepEqual(deliveredMemoryIds(toolMessages),deliveredMemoryIds(refs));
});

test('bounded batches keep forecast sources until all subsequent evidence can be reviewed',async t=>{
  const f=await fixture(t);let now=1000;const store=new IndividuationStore(f.path,()=>now);
  await write(store,{prediction:'预测用户查看大 A 股市时还需要 XLSX 数据表。'},on,owner);
  for(let i=0;i<6;i++){now+=100;await store.observe(`第 ${i} 次需要大 A 股市 XLSX 数据表。`+'需要包含来源日期。'.repeat(10),on,{...owner,turnId:String(i)});}
  const all=await store.begin(on,true,10000),note=all.records.find(r=>r.kind==='prediction'),first=all.records.find(r=>r.kind==='evidence');
  await store.fail(all.lease,'fixture');
  const limited=await store.begin(on,true,note.tokens+first.tokens+161);
  assert.equal(limited.records.length,2,'the forecast and one later user message fit the bounded input');
  const partial=await store.apply(limited,{habits:[],predictions:[],reviews:[{prediction:note.id,evidence:first.id,outcome:'hit',reason:'explicit request'}]},on);
  assert.equal(partial.hits,1);assert.equal(partial.records,6,'source stays with five remaining evidence rows');
  const next=await store.begin(on,true,10000);assert.ok(next.records.some(r=>r.id===note.id));
  const rest=next.records.filter(r=>r.kind==='evidence');assert.equal(rest.length,5);
  const final=await store.apply(next,{habits:[{text:'大 A 股市分析通常需要带来源日期的 XLSX 表。',sources:[note.id,...rest.map(r=>r.id)]}],predictions:[],
    reviews:rest.map(r=>({prediction:note.id,evidence:r.id,outcome:'hit',reason:'explicit request'}))},on);
  assert.equal(final.hits,6);assert.equal(final.records,1);
});

test('manual runtime command works below threshold and a second database owner cannot take the active lease',async t=>{
  const f=await fixture(t);await write(f.store,{habit:'用户明确偏好：在股市分析中提供 XLSX 表格。'},habits,owner);
  const snapshot=await f.store.begin(habits,true,10000);
  assert.equal(await new IndividuationStore(f.path).begin(habits,true,10000),null);
  await f.store.fail(snapshot.lease,'fixture unlock');
  let calls=0;const host=new InMemoryRuntimeHost({dataRoot:f.root,registerDefaultWorkspaceTools:false,provider:summarizeProvider((request,rows)=>{
    calls++;assert.equal(request.model,'manual-model');return {habits:[{text:'股市分析附 XLSX',sources:[rows[0].id]}],predictions:[],reviews:[]};
  })});t.after(()=>host.sendCommand({kind:'runtime.shutdown',payload:{}}));
  assert.ok(host.capabilities().supportedCommands.includes('runtime.personalization'));
  const status=await host.sendCommand({kind:'runtime.personalization',payload:{action:'summarize',settings:habits,model:{protocol:'bush.model_request.v1',requestId:'manual',sessionId:'m',turnId:'m',model:'manual-model',messages:[],tools:[],metadata:{}}}});
  assert.equal(calls,1);assert.equal(status.habits,1);assert.equal(status.notes,0);
  assert.equal((await host.sendCommand({kind:'runtime.personalization',payload:{action:'status',settings:habits}})).lastSummaryAt,status.lastSummaryAt);
});

test('cancelling a model summary releases the lease and retains the source',async t=>{
  const f=await fixture(t),entered=Promise.withResolvers();await write(f.store,{habit:'用户偏好简明的 XLSX 数据表。'},on,owner);
  const memory=new IndividuationMemory(f.path,{async *stream(_request,{signal}){entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const controller=new AbortController(),running=memory.compact(on,model,true,controller.signal);await entered.promise;controller.abort();
  await assert.rejects(running);const status=await f.store.status(on);assert.equal(status.records,1);assert.equal(status.running,false);assert.ok(status.lastError);
  assert.ok(await f.store.begin(on,true,10000),'manual retry can acquire immediately');
});
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  createdAt: new Date().toISOString(), sequence, kind, ...payload });
async function until(predicate) {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Expected runtime event did not arrive');
}

test('summary runs with parallel tools; next answer is final before done, while lifecycle remains running', async t => {
  const f = await fixture(t), sibling = Promise.withResolvers(), finish = Promise.withResolvers();
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'slow_probe', description: 'Independent work', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'probe', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    parallelSafe: true, decodeInput: x => x, execute: () => sibling.promise });
  let rounds = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: f.root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      rounds++;
      if (rounds === 1) {
        for (const [index, name] of ['slow_probe', 'summary_for_user'].entries()) yield event(request, index, 'tool_call_delta',
          { index, toolCallId: `c${index}`, nameDelta: name, argumentsDelta: '{}' });
        yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        assert.equal(request.messages.filter(m => m.role === 'tool').length, 2);
        yield event(request, 0, 'text_delta', { delta: '已完成' });
        await finish.promise;
        yield event(request, 1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  const request = { protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), prefixMessages: [], inputMessages: [{ messageId: 'u', message: { role: 'user', content: 'Work' } }], metadata: {} };
  const running = host.runSessionTurn(request);
  try {
    await until(() => host.events('s', 't').some(e => e.kind === 'tool_returned' && e.payload.toolName === 'summary_for_user'));
    assert.equal(rounds, 1, 'a successful summary must not cancel or skip its sibling');
    assert.ok(!host.events('s', 't').some(e => e.kind === 'turn_terminal'));
    sibling.resolve({ ok: true });
    await until(() => host.events('s', 't').some(e => e.kind === 'assistant_segment_delta'));
    assert.equal(host.events('s', 't').find(e => e.kind === 'assistant_segment_delta').payload.finalResponse, true);
    assert.ok(!host.events('s', 't').some(e => e.kind === 'turn_terminal'), 'text can render final while provider is still streaming');
  } finally { sibling.resolve({ ok: true }); finish.resolve(); }
  assert.equal((await running).payload.status, 'completed');
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});

test('signal uses a successful receipt in the same turn, is consumed once and ignores forged text/new guidance', () => {
  const store = new ToolExecutionStore();
  const call = { protocol: 'bush.tool_call.v1', id: 'summary', name: 'summary_for_user', argumentsText: '{}' };
  const assistant = { role: 'assistant', content: '', toolCalls: [call] };
  const messages = [assistant, { role: 'tool', toolCallId: call.id, content: '{"final_response":true}' }];
  assert.equal(hasPendingUserSummary(messages, store, 's', 't'), false);
  store.record(call, { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, { kind: 'returned', result: { status: 'ok', final_response: true } });
  assert.equal(hasPendingUserSummary(messages, store, 's', 't'), true);
  assert.equal(hasPendingUserSummary([...messages,{role:'user',visibility:'internal',name:'memory_state_updates',content:'Memory state changed.'}],store,'s','t'),true);
  assert.equal(hasPendingUserSummary(messages, store, 's', 'other-turn'), false);
  assert.equal(hasPendingUserSummary([...messages, { role: 'assistant', content: 'next response', toolCalls: [] }], store, 's', 't'), false);
  assert.equal(hasPendingUserSummary([...messages, { role: 'user', content: 'new guidance' }], store, 's', 't'), false);
});

test('extra tool calls demote final intent without dropping subsequent assistant text; done fallback remains unchanged', () => {
  for (const interleavedReasoning of [false, true]) {
    const log = new InMemoryRuntimeEventLog(), identity = { requestId: 'r', sessionId: 's', turnId: 't' };
    const projector = new RuntimeEventProjector(log, identity, { finalResponse: true, deltaFlushIntervalMs: 0 });
    projector.accept(event(identity, 0, 'text_delta', { delta: 'Earlier' }));
    if (interleavedReasoning) projector.accept(event(identity, 1, 'reasoning_delta', { delta: 'Still checking' }));
    projector.accept(event(identity, 2, 'tool_call_delta', { index: 0, toolCallId: 'next', nameDelta: 'probe', argumentsDelta: '{}' }));
    projector.accept(event(identity, 3, 'text_delta', { delta: 'Later' }));
    projector.accept(event(identity, 4, 'response_completed', { finishReason: 'tool_calls' }));
    const facts = log.replay('s', 't');
    assert.equal(facts.filter(e => e.kind === 'assistant_segment_delta').map(e => e.payload.delta).join(''), 'EarlierLater');
    assert.equal(facts.filter(e => e.kind === 'assistant_segment_completed').at(-1).payload.finalResponse, false);
    assert.equal(facts.some(e => e.kind === 'turn_terminal'), false);
    const plain = new RuntimeEventProjector(log, identity);
    const delta = plain.accept(event(identity, 5, 'text_delta', { delta: 'normal fallback' })).at(-1);
    assert.equal(delta.payload.finalResponse, undefined);
    plain.completeOpenSegment();
  }
});
