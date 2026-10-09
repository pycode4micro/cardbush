import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeIndividuation, checkHabitInputSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionCoordinator, InMemoryRuntimeHost } from '../dist/index.js';
import { IndividuationStore } from '../dist/individuationStore.js';
import { registerIndividuationTools, deliveredMemoryIds, deliveredMemoryVersions } from '../dist/individuationTools.js';
import { memoryTokens } from '../dist/individuationText.js';

const on=normalizeIndividuation({habits:true,predictions:true}),habits=normalizeIndividuation({habits:true});
const owner={sessionId:'source',turnId:'first'};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'cardbush-recall-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const path=join(root,'personalization.sqlite');let now=Date.now(),calls=0;
  const store=new IndividuationStore(path,()=>now),registry=new ToolRegistry();
  registerIndividuationTools(registry,path,{store,schedule(){}});
  const coordinator=new ToolExecutionCoordinator({registry,permissions:{request(){throw Error('unexpected permission');}}});
  return {root,path,store,registry,advance(ms){now+=ms;},now:()=>now,
    async tool(name,args,messages=[],settings=on){
      const id=`call-${++calls}`,result=await coordinator.execute({protocol:'bush.tool_call.v1',id,name,argumentsText:JSON.stringify(args)},
        {requestId:'r',sessionId:'query',turnId:'t',round:calls,ordinal:0},undefined,
        {request:{metadata:{individuation:settings},tools:registry.definitions(),permissionMode:'task_free'},contextMessages:messages});
      assert.equal(result.kind,'returned',JSON.stringify(result));return result.result;
    },
  };
}
const firstId=receipt=>receipt.writes.find(row=>row.id).id;
const loaded=(memories)=>[{role:'user',name:'habit_reference',visibility:'internal',content:JSON.stringify({memories})}];

test('all habits use small repeatable category pages instead of guessed topic searches',async t=>{
  const f=await fixture(t),expected=new Set();
  for(let i=0;i<7;i++)expected.add(firstId(await f.store.summarize({habit:{text:`用户习惯 ${i}：希望针对不同任务保留清晰的记录。`}},on,{...owner,operationId:`habit-${i}`})));
  await f.store.summarize({prediction:{text:'可能需要后续报表。'}},on,{...owner,operationId:'prediction'});
  const first=await f.tool('check_habit',{mode:'list',kind:'habit'});
  assert.equal(first.matched_count,7);assert.equal(first.count_capped,false);
  assert.ok(first.memories.length>0&&first.memories.length<=5&&first.next_cursor);
  assert.deepEqual(await f.tool('check_habit',{mode:'list',kind:'habit'},loaded(first.memories)),first);
  const seen=first.memories.map(row=>row.id),bytes=await readFile(f.path);
  let cursor=first.next_cursor,pages=1;
  while(cursor){
    const input={mode:'list',kind:'habit',cursor};
    const page=await f.tool('check_habit',input,loaded(first.memories));
    assert.deepEqual(await f.tool('check_habit',input),page);
    assert.equal(page.matched_count,7);assert.ok(page.memories.length<=5);
    assert.ok(page.memories.every(row=>row.kind==='habit'));
    assert.ok(memoryTokens(JSON.stringify(page))<=1000,'each page includes metadata and cursor in its token bound');
    seen.push(...page.memories.map(row=>row.id));cursor=page.next_cursor;assert.ok(++pages<8);
  }
  assert.equal(seen.length,expected.size);assert.deepEqual(new Set(seen),expected);
  assert.deepEqual(await readFile(f.path),bytes,'listing does not mark entries consumed');
});

test('list cursors tolerate new writes without repeats and reject changed filters or invalid cursors',async t=>{
  const f=await fixture(t);
  for(let i=0;i<8;i++)await f.store.summarize({habit:{text:`分页记录 ${i}。`}},on,{...owner,operationId:`page-${i}`});
  const page=await f.tool('check_habit',{mode:'list',kind:'habit'});
  const added=firstId(await f.store.summarize({habit:{text:'分页过程中新增的记录。'}},on,{...owner,operationId:'later'}));
  const rest=await f.tool('check_habit',{mode:'list',kind:'habit',cursor:page.next_cursor});
  assert.equal(rest.matched_count,8);assert.ok(!rest.memories.some(row=>row.id===added||page.memories.some(first=>first.id===row.id)));
  assert.equal((await f.tool('check_habit',{mode:'list',kind:'prediction',cursor:page.next_cursor})).status,'invalid_cursor');
  assert.equal((await f.tool('check_habit',{mode:'list',cursor:'garbage'})).status,'invalid_cursor');
  assert.equal((await f.tool('check_habit',{mode:'list',kind:'prediction'},[],habits)).status,'disabled');
  assert.equal(checkHabitInputSchema.safeParse({mode:'list',topics:['x']}).success,false);
  assert.equal(checkHabitInputSchema.safeParse({cursor:page.next_cursor}).success,false);
  assert.equal(checkHabitInputSchema.safeParse({ids:['x'],mode:'list'}).success,false);
});

test('list counts are exact beyond the search candidate cap while content stays bounded',async t=>{
  const f=await fixture(t);
  for(let i=0;i<70;i++)await f.store.summarize({habit:{text:`不同习惯 ${i}：按任务编号 ${i} 处理。`}},on,{...owner,operationId:`count-${i}`});
  const count=await f.tool('check_habit',{kind:'habit',count_only:true});
  assert.equal(count.matched_count,70);assert.equal(count.count_capped,false);assert.deepEqual(count.memories,[]);
  const page=await f.tool('check_habit',{kind:'habit',mode:'list'});
  assert.equal(page.matched_count,70);assert.ok(page.next_cursor);assert.ok(page.memories.length<=5);
  assert.ok(memoryTokens(JSON.stringify(page))<=1000);
  const search=await f.tool('check_habit',{kind:'prediction',topics:['不同习惯']});assert.equal(search.matched_count,0);
});

test('long list records stay bounded including cursor overhead and remain readable by ID',async t=>{
  const f=await fixture(t),expected=[];
  for(let i=0;i<7;i++)expected.push(firstId(await f.store.summarize({habit:{text:`记录 ${i}：`+'需要简短说明。'.repeat(15)}},on,{...owner,operationId:`long-${i}`})));
  let cursor,seen=[];
  do {
    const page=await f.tool('check_habit',{mode:'list',kind:'habit',...(cursor?{cursor}:{})});
    assert.equal(page.status,'ok');assert.ok(memoryTokens(JSON.stringify(page))<=1000);
    assert.ok(page.memories.length>0&&page.memories.length<=5);
    seen.push(...page.memories.map(row=>row.id));cursor=page.next_cursor;
    assert.ok(seen.length<=expected.length);
  } while(cursor);
  assert.deepEqual(new Set(seen),new Set(expected));
  const full=await f.tool('check_habit',{ids:[expected[0]]});assert.equal(full.memories[0].truncated,false);
});

test('oversized legacy metadata defers an explicit ID without blocking later pages',async t=>{
  const f=await fixture(t),ids=[];
  for(let i=0;i<3;i++)ids.push(firstId(await f.store.summarize({habit:{text:`独立习惯 ${i}。`}},on,{...owner,operationId:`oversized-${i}`})));
  const appliesWhen='旧版记录中的适用条件。'.repeat(500),db=new DatabaseSync(f.path);
  try{db.prepare('UPDATE memory_records SET applies_when=? WHERE id=?').run(appliesWhen,ids[2]);}finally{db.close();}
  const first=await f.tool('check_habit',{mode:'list',kind:'habit'});
  assert.equal(first.status,'budget_limited');assert.equal(first.matched_count,3);
  assert.deepEqual(first.memories,[]);assert.deepEqual(first.omitted,[{id:ids[2],reason:'budget_limited'}]);
  assert.ok(first.next_cursor);assert.ok(memoryTokens(JSON.stringify(first))<=1000);
  const rest=await f.tool('check_habit',{mode:'list',kind:'habit',cursor:first.next_cursor});
  assert.deepEqual(new Set(rest.memories.map(row=>row.id)),new Set(ids.slice(0,2)));
  assert.equal(rest.next_cursor,null);assert.ok(memoryTokens(JSON.stringify(rest))<=1000);
  const full=await f.tool('check_habit',{ids:[ids[2]]});
  assert.equal(full.memories[0].applies_when,appliesWhen);assert.equal(full.memories[0].truncated,false);
});

test('the deployed pre-journal database upgrades without losing original note IDs, text or dates',async t=>{
  const f=await fixture(t),created=f.now()-86400000,id='note_97dc490978f6137e8ac08aa9',text='用户偏好核查原始调用记录，并保留预测验证的证据。';
  const db=new DatabaseSync(f.path);
  db.exec(`CREATE TABLE memory_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,
    text TEXT NOT NULL,scope INTEGER NOT NULL,tokens INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL,updated INTEGER NOT NULL,observations INTEGER NOT NULL DEFAULT 1,
    hits INTEGER NOT NULL DEFAULT 0,misses INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL DEFAULT '{}');`);
  db.prepare('INSERT INTO memory_records(id,kind,text,scope,tokens,created,updated,metadata) VALUES(?,?,?,?,?,?,?,?)')
    .run(id,'note',text,3,memoryTokens(text),created,created,JSON.stringify({session:'original-session',turn:'original-turn'}));
  db.close();
  const read=await f.tool('check_habit',{ids:[id]});
  assert.equal(read.status,'ok');assert.equal(read.memories[0].text,text);assert.equal(read.memories[0].created_at,created);
  assert.equal(read.memories[0].state,'active');assert.equal(read.memories[0].last_confirmed_at,null);
  assert.deepEqual(read.memories[0].source,{session_id:'original-session',turn_id:'original-turn'});
  assert.deepEqual(await f.tool('check_habit',{ids:[id]},loaded(read.memories)),read);
  assert.equal((await f.store.history(on)).changes.length,0,'schema migration is not a fabricated memory write');
  const oldResult=[{role:'assistant',content:'',toolCalls:[{id:'old-read',name:'check_habit',argumentsText:'{}'}]},
    {role:'tool',toolCallId:'old-read',content:JSON.stringify([{id,text}])}];
  assert.equal(deliveredMemoryVersions(oldResult).get(id),0,'legacy receipts remain trackable for later invalidation');
});

test('reported timeline: explicit identical reads remain stable after automatic or explicit delivery',async t=>{
  const f=await fixture(t),topic='记忆与工具机制讨论 下一步需求预测 用户偏好';
  const a=firstId(await f.store.summarize({habit:{text:'讨论记忆与工具机制时，用户偏好核对实际调用记录。'}},on,owner));
  const b=firstId(await f.store.summarize({prediction:{text:'讨论记忆与工具机制后，可能要求演示下一步需求预测。'}},on,{...owner,turnId:'second'}));
  const initial=await f.tool('check_habit',{topics:[topic]});assert.deepEqual(new Set(initial.memories.map(r=>r.id)),new Set([a,b]));
  const context=[...loaded(initial.memories),{role:'assistant',content:'',toolCalls:[{id:'prior',name:'check_habit',argumentsText:JSON.stringify({topics:[topic]})}]},
    {role:'tool',toolCallId:'prior',content:JSON.stringify(initial)}];
  const bytes=await readFile(f.path);
  const repeated=await Promise.all(Array.from({length:3},()=>f.tool('check_habit',{topics:[topic]},context)));
  for(const result of repeated)assert.deepEqual(result,initial);
  assert.deepEqual(await readFile(f.path),bytes,'reads do not mark records consumed or update timestamps');
  const automatic=await f.store.read({topics:[topic]},on,deliveredMemoryIds(context));
  assert.equal(automatic.status,'already_supplied');assert.equal(automatic.matched_count,2);assert.deepEqual(automatic.memories,[]);
  const c=firstId(await f.store.summarize({habit:{text:'用户偏好：记忆与工具机制的结论应区分预测和已有证据。'}},on,{...owner,turnId:'third'}));
  assert.ok((await f.tool('check_habit',{ids:[a,b,c]},context)).memories.every(r=>!r.truncated));
  assert.deepEqual((await f.store.read({topics:[topic]},on,deliveredMemoryIds(context))).memories.map(r=>r.id),[c]);
});

test('legacy long notes retain their full text by ID after excerpts were delivered',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({habit:{text:'检验原文：预测与习惯应独立。'}},on,owner));
  const original='检验原文：'+'关于预测和习惯的原始观察，不应在读回时丢失。'.repeat(120);
  const db=new DatabaseSync(f.path);db.prepare("UPDATE memory_records SET kind='note',text=?,tokens=? WHERE id=?").run(original,memoryTokens(original),id);db.close();
  const excerpt=await f.tool('check_habit',{topics:['检验原文']});assert.equal(excerpt.memories[0].truncated,true);assert.ok(excerpt.memories[0].text.length<original.length);
  for(let i=0;i<3;i++){
    const full=await f.tool('check_habit',{ids:[id]},loaded(excerpt.memories));
    assert.equal(full.memories[0].text,original);assert.equal(full.memories[0].truncated,false);
  }
});

test('multi-topic recall shares a budget; counts do not load content and empty states are explicit',async t=>{
  const f=await fixture(t);
  assert.equal((await f.tool('check_habit',{})).status,'no_match');await assert.rejects(access(f.path),{code:'ENOENT'});
  assert.equal((await f.tool('check_habit',{},[],normalizeIndividuation())).status,'disabled');
  for(const [turnId,text] of ['浏览器测试偏好 Edge。','终端命令使用 PowerShell。','表格输出偏好 XLSX。'].entries())await f.store.summarize({habit:{text}},on,{...owner,turnId:String(turnId)});
  const input={topics:['Edge 浏览器','PowerShell 终端','XLSX 表格']};
  const counted=await f.tool('check_habit',{...input,count_only:true});assert.equal(counted.matched_count,3);assert.deepEqual(counted.memories,[]);
  const result=await f.tool('check_habit',input);assert.ok(memoryTokens(JSON.stringify(result))<1100);assert.equal(new Set(result.memories.map(r=>r.id)).size,result.memories.length);
  assert.equal((await f.tool('check_habit',{topics:['完全没有相关内容的蛋糕']})).status,'no_match');
  assert.equal(checkHabitInputSchema.safeParse({topics:['a','b','c','d']}).success,false);
  const registry=new ToolRegistry();registerIndividuationTools(registry,f.root);
  const unavailable=await registry.resolve('check_habit').execute({input:{},turn:{request:{metadata:{individuation:on}}}});
  assert.equal(unavailable.status,'unavailable');
});

test('by-ID lookup reports missing and disabled IDs without leaking their contents',async t=>{
  const f=await fixture(t),receipt=await f.store.summarize({habit:{text:'偏好简洁'},prediction:{text:'可能继续询问细节'}},on,owner);
  const result=await f.tool('check_habit',{ids:[...receipt.writes.map(row=>row.id),'missing']},[],habits);
  assert.equal(result.memories.length,1);assert.equal(result.memories[0].kind,'habit');
  assert.deepEqual(result.omitted.map(row=>row.reason),['disabled','not_found']);
});

test('write receipts expose IDs, deterministic replay, refusal and no false confirmation',async t=>{
  const f=await fixture(t),input={habit:{text:'用户偏好简明回答。',applies_when:'日常解释'}},operation={...owner,operationId:'stable-write'};
  const first=await f.store.summarize(input,on,operation),bytes=await readFile(f.path);
  assert.equal(first.writes[0].status,'created');assert.deepEqual(await f.store.summarize(input,on,operation),first);
  assert.deepEqual(await readFile(f.path),bytes);
  const duplicate=await f.store.summarize(input,on,{...owner,turnId:'next'});assert.equal(duplicate.writes[0].status,'deduplicated');
  const record=(await f.store.read({ids:[firstId(first)]},on)).memories[0];assert.equal(record.last_confirmed_at,null);
  await assert.rejects(f.store.summarize({habit:{text:'different'}},on,operation),/reused/);
  const rejected=await f.tool('summary_for_user',{habit:{text:'字'.repeat(300)}});assert.equal(rejected.final_response,true);assert.equal(rejected.writes[0].reason,'note_too_long');
  const skipped=await f.tool('summary_for_user',{prediction:{text:'not saved'}},[],habits);assert.equal(skipped.writes[0].status,'skipped');
});

test('conditions are searchable; expired predictions leave recall and evidence but remain readable',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({prediction:{text:'可能需要 XLSX 报告。',applies_when:'查看 A 股走势',expires_at:new Date(f.now()+1000).toISOString()}},on,owner));
  const before=(await f.store.read({topics:['A 股走势']},on)).memories[0];assert.equal(before.id,id);assert.equal(before.state,'active');
  f.advance(2000);
  assert.equal((await f.store.read({topics:['XLSX']},on)).status,'no_match');
  const full=(await f.store.read({ids:[id]},on)).memories[0];assert.equal(full.state,'expired');assert.equal(full.text,'可能需要 XLSX 报告。');
  assert.deepEqual(await f.store.changedReferences(deliveredMemoryVersions(loaded([full])),on),[],'reading an expired original does not repeat the expiry notice');
  await f.store.observe('请提供 XLSX 报告。',on,{...owner,turnId:'late'});assert.equal((await f.store.status(on)).records,0);
  const changes=await f.store.changedReferences(deliveredMemoryVersions(loaded([before])),on);assert.equal(changes[0].state,'expired');
  assert.deepEqual(await f.store.changedReferences(deliveredMemoryVersions([...loaded([before]),{role:'user',name:'memory_state_updates',visibility:'internal',content:JSON.stringify({changes})}]),on),[]);
});

test('consolidation cannot renew a forecast or promote a source that expired while the model was running',async t=>{
  const f=await fixture(t),expires=f.now()+1000;
  const id=firstId(await f.store.summarize({prediction:{text:'下一次查看股市行情时，用户可能要求将数据整理为 XLSX 表格。',applies_when:'查看股市',expires_at:new Date(expires).toISOString()}},on,owner));
  const snapshot=await f.store.begin(on,'events',true);
  await f.store.apply(snapshot,{habits:[],predictions:[{text:'可能需要 XLSX。',applies_when:'查看股市',expires_at:new Date(expires+86400000).toISOString(),sources:[id]}],reviews:[]},on);
  const record=(await f.store.check('XLSX',on))[0];assert.equal(record.expires_at,expires);
  const pending=await f.store.begin(on,'events',true);f.advance(2000);
  await assert.rejects(f.store.apply(pending,{habits:[{text:'股市需表格',applies_when:'查看股市',sources:[record.id]}],predictions:[],reviews:[]},on),/expired while summarizing/);
  assert.equal((await f.store.read({ids:[record.id]},on)).memories[0].state,'expired');
  assert.equal((await f.store.status(on)).habits,0);
});

test('corrections require current evidence, preserve originals, are idempotent, and can be undone',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({habit:{text:'查看股市时默认附 XLSX。'}},on,owner));
  const old=(await f.store.read({ids:[id]},on)).memories[0],user='以后只在我明确要求时再生成 XLSX。';
  const input={id,revision:old.revision,action:'supersede',reason:'用户收窄了适用范围',replacement:{kind:'habit',text:'仅在用户要求时提供 XLSX。',applies_when:'股市报告'}};
  assert.equal((await f.tool('revise_memory',input)).status,'rejected');
  assert.equal((await f.tool('revise_memory',{...input,user_quote:'伪造的用户要求'},[{role:'user',content:user}])).status,'rejected');
  const action={...input,user_quote:user},operation={...owner,turnId:'correction',operationId:'correct'};
  const changed=await f.store.change(action,on,operation,'agent',user);assert.equal(changed.status,'ok');
  assert.deepEqual(await f.store.change(action,on,operation,'agent',user),changed);
  const full=(await f.store.read({ids:[id]},on)).memories[0];assert.equal(full.state,'superseded');assert.equal(full.text,old.text);assert.equal(full.last_rejected_at,f.now());
  assert.deepEqual(full.replaced_by,[changed.replacement_id]);assert.ok(!(await f.store.check('XLSX',on)).some(row=>row.id===id));
  assert.equal((await f.store.summarize({habit:{text:old.text}},on,{...owner,turnId:'try-again'})).writes[0].reason,'inactive_record_requires_review');
  const history=await f.store.history(on);assert.equal(history.changes[0].id,changed.change_id);assert.equal(history.changes[0].before[0].text,old.text);
  const undo=await f.store.undo(changed.change_id,on,{...owner,turnId:'undo'});assert.equal(undo.status,'ok');
  assert.equal((await f.store.read({ids:[id]},on)).memories[0].state,'active');
  assert.equal((await f.store.read({ids:[changed.replacement_id]},on)).memories[0].state,'retracted');
});

test('user-pinned memory is protected from agent changes and background summarization',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({habit:{text:'用户偏好简短说明。'}},on,owner));
  let row=(await f.store.read({ids:[id]},on)).memories[0];
  await f.store.change({id,revision:row.revision,action:'confirm',reason:'用户确认'},on,{...owner,turnId:'pin'},'user');
  row=(await f.store.read({ids:[id]},on)).memories[0];assert.equal(row.origin,'user');assert.equal(row.last_confirmed_at,f.now());
  assert.equal((await f.tool('revise_memory',{id,revision:row.revision,action:'dispute',reason:'模型自行怀疑'})).status,'rejected');
  assert.equal(await f.store.begin(on,'habits',true),null);
});

test('summary keeps historical IDs, source age and lineage; undo restores records and review totals',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({prediction:{text:'股市分析后可能需要 XLSX。'}},on,owner));
  const original=(await f.store.read({ids:[id]},on)).memories[0];f.advance(1000);
  await f.store.observe('给我 XLSX 股市报告。',on,{...owner,turnId:'followup'});
  const snapshot=await f.store.begin(on,'events',true),evidence=snapshot.records.find(row=>row.kind==='evidence');
  await f.store.apply(snapshot,{habits:[],predictions:[{text:'可能需要 XLSX。',sources:[id,evidence.id]}],reviews:[{prediction:id,evidence:evidence.id,outcome:'hit',reason:'用户明确要求'}]},on);
  const active=(await f.store.check('XLSX',on))[0];assert.equal(active.created_at,original.created_at);assert.ok(active.source_ids.includes(id));
  assert.equal((await f.store.read({ids:[id]},on)).memories[0].state,'consolidated');
  const event=(await f.store.history(on)).changes[0];assert.equal(event.actor,'summary');assert.equal(event.can_undo,true);
  assert.equal((await f.store.undo(event.id,on,{...owner,turnId:'undo-summary'})).status,'ok');
  const status=await f.store.status(on);assert.equal(status.hits,0);assert.equal(status.predictions,1);
  const again=await f.store.begin(on,'events',true);assert.ok(again.records.some(row=>row.id===evidence.id));
  await f.store.apply(again,{habits:[],predictions:[],reviews:[{prediction:id,evidence:evidence.id,outcome:'hit',reason:'复盘恢复证据'}]},on);
  assert.equal((await f.store.status(on)).hits,1,'undo removed only the batch review ledger entries, allowing an honest re-review');
});

test('stale corrections and undo never overwrite subsequent user edits',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({habit:{text:'偏好表格报告。'}},on,owner)),row=(await f.store.read({ids:[id]},on)).memories[0];
  const first=(await f.store.history(on)).changes[0];
  await f.store.change({id,revision:row.revision,action:'confirm',reason:'确认'},on,{...owner,turnId:'later'},'user');
  assert.equal((await f.store.undo(first.id,on,{...owner,turnId:'stale-undo'})).status,'conflict');
  assert.equal((await f.store.change({id,revision:row.revision,action:'retract',reason:'stale'},on,{...owner,turnId:'stale-edit'},'user')).status,'conflict');
  assert.equal((await f.store.read({ids:[id]},on)).memories[0].origin,'user');
});

test('manual history cleanup preserves active records and retired IDs without retaining inactive content',async t=>{
  const f=await fixture(t),a=firstId(await f.store.summarize({habit:{text:'旧的偏好'}},on,owner)),b=firstId(await f.store.summarize({habit:{text:'有效的偏好'}},on,{...owner,turnId:'b'}));
  const row=(await f.store.read({ids:[a]},on)).memories[0];await f.store.change({id:a,revision:row.revision,action:'retract',reason:'用户删除'},on,{...owner,turnId:'remove'},'user');
  await f.store.purgeHistory(on);assert.deepEqual((await f.store.history(on)).changes,[]);
  const rows=(await f.store.read({ids:[a,b]},on)).memories;assert.equal(rows[0].content_cleared,true);assert.equal(rows[0].state,'retracted');assert.equal(rows[1].text,'有效的偏好');
});

const event=(request,sequence,kind,payload={})=>({protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence,kind,...payload});
test('host hints contain no text; changed references invalidate and restore the current conversation',async t=>{
  const f=await fixture(t),id=firstId(await f.store.summarize({habit:{text:'股市报告通常提供 XLSX。'}},on,owner)),seen=[];
  const host=new InMemoryRuntimeHost({dataRoot:f.root,registerDefaultWorkspaceTools:false,provider:{async *stream(request){seen.push(structuredClone(request));yield event(request,0,'text_delta',{delta:'answer'});yield event(request,1,'response_completed',{finishReason:'stop'});}}});
  t.after(()=>host.sendCommand({kind:'runtime.shutdown',payload:{}}));
  const request=(turnId,settings=on,sessionId='dialog')=>({protocol:'bush.session_turn_request.v1',requestId:turnId,sessionId,turnId,model:'fixture',tools:[],prefixMessages:[],inputMessages:[{messageId:turnId,message:{role:'user',content:'查看股市报告'}}],metadata:{individuation:settings}});
  await host.runSessionTurn(request('hint',{...on,recallMode:'hint'},'hint-dialog'));
  const hint=JSON.parse(seen.at(-1).messages.find(row=>row.name==='habit_reference').content);assert.equal(hint.matched_count,1);assert.deepEqual(hint.memories,[]);
  await host.runSessionTurn(request('one'));
  const record=(await f.store.read({ids:[id]},on)).memories[0];
  const changed=await f.store.change({id,revision:record.revision,action:'retract',reason:'当前用户纠正'},on,{...owner,turnId:'remove'},'user');
  await host.runSessionTurn(request('two'));
  const correction=JSON.parse(seen.at(-1).messages.filter(row=>row.name==='memory_state_updates').at(-1).content);assert.equal(correction.changes[0].state,'retracted');
  await f.store.undo(changed.change_id,on,{...owner,turnId:'undo'});
  await host.runSessionTurn(request('three'));
  const restored=JSON.parse(seen.at(-1).messages.filter(row=>row.name==='memory_state_updates').at(-1).content);assert.equal(restored.changes[0].state,'active');
});
