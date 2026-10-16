import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { WebReadCache, historyPage, conversationPageQuery, conversationCursor, nextConversationCursor } from '../dist-electron/webSessionReads.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { WebError } from '../dist-electron/webCommon.mjs';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
const ui = await loadChatTranscript({ source: `export * from ${JSON.stringify(resolve('web/conversationPages.ts'))};` });
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = (n = 65) => ({ turns: Array.from({ length:n }, (_, i) => ({ turnId:`turn-${i}`, messages:[{message:{role:'assistant',content:`reply-${i}`,toolCalls:[{id:`call-${i}`}]}}] })) });

test('history anchors stay stable across appended turns, including the last partial page', () => {
  const all=snapshot(), head=historyPage(all,20); assert.equal(head.snapshot.turns.length,20); assert.equal(head.history.nextCursor,'turn-45');
  all.turns.push({turnId:'new',messages:[]}); const page=historyPage(all,20,head.history.nextCursor);
  assert.equal(page.snapshot.turns[0].turnId,'turn-25'); assert.equal(page.snapshot.turns.at(-1).turnId,'turn-44');
  assert.equal(historyPage(all,20,'turn-5').snapshot.turns.length,5); assert.equal(historyPage(all,20,'turn-5').history.nextCursor,null);
  assert.throws(()=>historyPage(all,20,'missing'),error=>error.status===409);
});
test('conversation cursors retain microsecond timestamps, filter scope and strict bounds', () => {
  const query=conversationPageQuery.parse({limit:'30',archived:'false',q:'shirt'}), timestamp='2026-10-16 04:00:00.123456+00';
  const cursor=nextConversationCursor({id:'a',pinned:false},timestamp,query);
  assert.equal(conversationCursor({...query,cursor}).updatedAt,timestamp);
  assert.throws(()=>conversationCursor({...query,cursor,archived:true}));
  assert.throws(()=>conversationCursor({...query,cursor:'invalid'}));
  assert.throws(()=>conversationPageQuery.parse({limit:'10000'}));
});
test('account-scoped cache coalesces same-page reads but never crosses accounts', async () => {
  const cache=new WebReadCache(), wait=deferred(); let reads=0;
  const load=async()=>{reads++;await wait.promise;return {text:'alice'};};
  const a=cache.get('alice:session:snapshot',5000,load), b=cache.get('alice:session:snapshot',5000,load);
  assert.equal(reads,1); wait.resolve(); assert.deepEqual(await a,await b);
  assert.deepEqual(await cache.get('bob:session:snapshot',5000,async()=>({text:'bob'})),{text:'bob'});
});
test('invalidated in-flight reads cannot repopulate the cache; failures can retry', async () => {
  const cache=new WebReadCache(), wait=deferred();
  const old=cache.get('alice:session:snapshot',5000,async()=>{await wait.promise;return 'old';});
  cache.invalidate('alice:session:'); await cache.get('alice:session:snapshot',5000,async()=> 'new'); wait.resolve(); await old;
  assert.equal(await cache.get('alice:session:snapshot',5000,async()=> 'wrong'),'new');
  await assert.rejects(cache.get('failed',5000,async()=>{throw Error('retry');}));
  assert.equal(await cache.get('failed',5000,async()=> 'recovered'),'recovered');
});
test('runtime reads have a global concurrency bound and oversized snapshots are not retained', async () => {
  const cache=new WebReadCache(()=>0,100), wait=deferred(); let active=0,peak=0;
  const work=Array.from({length:20},(_,i)=>cache.get(`owner-${i}`,10,async()=>{active++;peak=Math.max(active,peak);await wait.promise;active--;return i;}));
  assert.equal(peak,4);wait.resolve();await Promise.all(work);assert.equal(peak,4);
  let loads=0;const big=async()=>{loads++;return 'x'.repeat(101);};await cache.get('big',10,big);await cache.get('big',10,big);assert.equal(loads,2);
});
test('page merging preserves older history and newer live state, while isolating sessions', () => {
  const state=(ids,more,jobs=[])=>({conversation:{id:'a'},snapshot:{turns:ids.map(turnId=>({turnId,messages:[]}))},history:{nextCursor:more},jobs,solutions:[]});
  const head=state(['20','21'],'20',[{id:'live',turnId:'22',status:'running'}]);
  const merged=ui.mergeConversationPage(head,state(['18','19'],'18'),true);
  assert.deepEqual(plain(merged.snapshot.turns).map(x=>x.turnId),['18','19','20','21']);assert.equal(merged.jobs[0].status,'running');
  const refreshed=ui.mergeConversationPage(merged,state(['20','21','22'],'20',[{id:'live',turnId:'22',status:'completed'}]));
  assert.equal(refreshed.history.nextCursor,'18');assert.equal(refreshed.jobs[0].status,'completed');
  const other={...head,conversation:{id:'other'}}; assert.equal(ui.mergeConversationPage(merged,other),other);
});

test('HTTP pages only hydrate visible tools; status reads no history; foreign ownership is rejected before runtime access', async t => {
  const owner={id:'alice',role:'member',is_active:true}, sessionId='web-'+'a'.repeat(40), counts={snapshot:0,tools:0,jobs:0,agent:0};
  const conversation={id:sessionId,title:'test',archived:false,pinned:false};
  const store={authenticate:async token=>token==='k'.repeat(54)?owner:null,conversation:async(user,id)=>{if(id!==sessionId||user!=='alice')throw new WebError(404,'Not found');return conversation;},
    listPage:async(user,query)=>{assert.equal(user,'alice');assert.equal(query.limit,30);return {items:[conversation],nextCursor:null};}};
  const agents={get:async()=>{counts.agent++;return {call:async(operation,input)=>{
    if(operation==='sessions.get'){counts.snapshot++;return snapshot();}
    if(operation==='chat.jobs'){counts.jobs++;return [{id:'job',turnId:'turn-66',status:'running'}];}
    if(input.kind==='runtime.list_turn_tool_executions'){counts.tools++;return [{turnId:input.payload.turnId}];} return [];
  }};},close(){}};
  const server=await serveWeb({origin:'http://test',host:'127.0.0.1',port:0,staticRoot:resolve('dist-web'),modelSecret:'x'.repeat(64),models:[{id:'test'}],defaultModelId:'test'},store,agents);
  t.after(()=>server.close()); const request=path=>fetch(`http://127.0.0.1:${server.port}/api/web/v1${path}`,{headers:{Cookie:'cardbush_web='+'k'.repeat(54)}});
  const list=await request('/sessions?limit=30'); assert.equal((await list.json()).items.length,1);assert.equal(counts.agent,0);
  const first=await (await request(`/sessions/${sessionId}?limit=20`)).json();assert.equal(first.snapshot.turns.length,20);assert.equal(counts.tools,20);
  await request(`/sessions/${sessionId}/status`);assert.equal(counts.snapshot,1);assert.equal(counts.tools,20);
  const second=await (await request(`/sessions/${sessionId}?limit=20&before=${first.history.nextCursor}`)).json();assert.equal(second.snapshot.turns.length,20);assert.equal(counts.tools,40);assert.equal(counts.snapshot,1);
  await request(`/sessions/${sessionId}?limit=20`);assert.equal(counts.tools,40);
  const count=counts.agent;assert.equal((await request('/sessions/web-'+'b'.repeat(40)+'?limit=20')).status,404);assert.equal(counts.agent,count);
  assert.equal((await request(`/sessions/${sessionId}?limit=999999`)).status,400);
});
