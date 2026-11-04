import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Store,atomic} from './store.mjs';
import {EnvironmentService} from './environment-service.mjs';
import {EventRegistry} from './event-registry.mjs';
function fixture(t){
 const root=mkdtempSync('/opt/friends-loop-demo-20261104/v5/test-');
 const s=new Store(root);mkdirSync(join(root,'inbox'));s.set('clock',{mode:'fixture',timezone:'Asia/Shanghai'});
 atomic(join(root,'clock.json'),JSON.stringify({now:'2026-11-04T16:55:00+08:00'}));
 const env=new EnvironmentService(s),events=new EventRegistry(s,env),refs=new Set(['h:1']);
 t.after(()=>{try{s.close();}catch{}rmSync(root,{recursive:true,force:true});});
 const create=key=>events.create({logical_key:key,title:'document task',intent:'Use the relevant source',completion:'verified result',not_before:'2026-11-04T17:00:00+08:00',habit_refs:[{id:'h',revision:1}]},'wake-1',refs).event;
 const clock=now=>atomic(join(root,'clock.json'),JSON.stringify({now}));
 return {root,s,env,events,refs,create,clock};
}
test('events originate from observed habit and repeated creation is idempotent',async t=>{
 const f=fixture(t),a=f.create('a'),b=f.create('a');assert.equal(a.id,b.id);assert.equal(f.s.events().length,1);
 assert.throws(()=>f.events.create({logical_key:'b',title:'x',intent:'x',completion:'x',habit_refs:[{id:'h',revision:2}]},'w',f.refs),/UNOBSERVED/);
 assert.equal(f.s.registrations().length,0);
});
test('clock registration survives reload, does not fire early and fires exactly once',async t=>{
 const f=fixture(t),e=f.create('a');
 await f.events.register({event_id:e.id,slot:'due',kind:'at_time',at:'2026-11-04T17:00:00+08:00'},'w');
 f.env.tick();assert.equal(f.s.db.prepare('SELECT count(*) n FROM signals').get().n,0);
 const second=new Store(f.root),env2=new EnvironmentService(second);
 f.clock('2026-11-04T17:00:00+08:00');env2.tick();env2.tick();
 assert.equal(second.db.prepare('SELECT count(*) n FROM signals').get().n,1);
 assert.equal(second.registrations()[0].active,0);second.close();
});
test('directory content change enqueues facts; same content and generated output do not retrigger',async t=>{
 const f=fixture(t),e=f.create('a');
 await f.events.register({event_id:e.id,slot:'source',kind:'directory_change',source_id:'inbox'},'w');
 writeFileSync(join(f.root,'inbox','a.md'),'fact 1');f.env.tick();
 assert.equal(f.s.report().signals[0].kind,'directory.changed');
 f.env.nextScan.clear();writeFileSync(join(f.root,'inbox','a.md'),'fact 1');f.env.tick();
 mkdirSync(join(f.root,'artifacts'));writeFileSync(join(f.root,'artifacts','b.md'),'own output');
 f.env.nextScan.clear();f.env.tick();assert.equal(f.s.report().signals.length,1);
 writeFileSync(join(f.root,'inbox','a.md'),'fact 2');f.env.nextScan.clear();f.env.tick();
 writeFileSync(join(f.root,'inbox','a.md'),'fact 1');f.env.nextScan.clear();f.env.tick();
 assert.equal(f.s.report().signals.length,3);
 assert.equal(f.s.report().user_signal_count,0);
});
test('read evidence must be real, scoped and current; future event cannot be completed',async t=>{
 const f=fixture(t),e=f.create('a');writeFileSync(join(f.root,'inbox','a.md'),'fact 1');
 const doc=f.env.readDocument('a.md');
 assert.throws(()=>f.events.writeArtifact({event_id:e.id,content:'result',evidence_ids:[doc.id]},'w',new Set()),/UNREAD/);
 const a=f.events.writeArtifact({event_id:e.id,content:'result: fact 1',evidence_ids:[doc.id]},'w',new Set([doc.id]));
 assert.throws(()=>f.events.complete({event_id:e.id,artifact_id:a.artifact_id}),/NOT_YET_DUE/);
 writeFileSync(join(f.root,'inbox','a.md'),'fact 2');
 assert.throws(()=>f.events.writeArtifact({event_id:e.id,content:'stale',evidence_ids:[doc.id]},'w',new Set([doc.id])),/STALE_DOCUMENT/);
 f.clock('2026-11-04T17:00:00+08:00');
 assert.throws(()=>f.events.complete({event_id:e.id,artifact_id:a.artifact_id}),/STALE_.*EVIDENCE/);
 assert.throws(()=>f.env.readDocument('../state.sqlite'),/INVALID_RESOURCE/);
 symlinkSync('/etc/passwd',join(f.root,'inbox','escape'));assert.throws(()=>f.env.readDocument('escape'),/OUT_OF_SCOPE/);
});
test('completion receipt alone does not deliver; actual final reply is committed once',async t=>{
 const f=fixture(t),e=f.create('a');writeFileSync(join(f.root,'inbox','a.md'),'verified fact');
 const doc=f.env.readDocument('a.md'),a=f.events.writeArtifact({event_id:e.id,content:'verified result',evidence_ids:[doc.id]},'w',new Set([doc.id]));
 f.clock('2026-11-04T17:00:00+08:00');f.events.complete({event_id:e.id,artifact_id:a.artifact_id});
 assert.equal(f.s.report().reports.length,0);
 f.s.enqueue('clock.reached','detector',{event_id:e.id},'due');
 const b=f.s.claim(f.env.clock().now);assert.throws(()=>f.s.finish(b,''),/MISSING_FINAL/);
 assert.equal(f.s.report().reports.length,0);
 const r=f.s.finish(b,'I completed this verified result.');assert.ok(r);
 assert.equal(f.s.report().wakes[0].status,'completed');
 f.s.enqueue('system.test','system',{},'next');const next=f.s.claim(f.env.clock().now);
 assert.equal(f.s.finish(next,'No new result.'),null);assert.equal(f.s.report().reports.length,1);
});
test('interrupted activation is recovered without losing the signal',async t=>{
 const f=fixture(t);f.s.enqueue('directory.changed','detector',{observation_id:'x'},'x');
 const old=f.s.claim(f.env.clock().now);assert.ok(old);
 assert.equal(f.s.recover(),1);const next=f.s.claim(f.env.clock().now);
 assert.equal(old.signals[0].id,next.signals[0].id);assert.notEqual(old.id,next.id);
});
test('source unavailability is a health fact, not user absence or a fabricated success',async t=>{
 const f=fixture(t),e=f.create('a');
 await f.events.register({event_id:e.id,slot:'source',kind:'directory_change',source_id:'inbox'},'w');
 rmSync(join(f.root,'inbox'),{recursive:true});f.env.tick();
 const sig=f.s.report().signals[0],obs=f.s.observation(sig.data.observation_id);
 assert.equal(obs.data.health,'unavailable');assert.equal(f.s.report().reports.length,0);
 assert.equal('user_activity' in obs.data,false);
});
test('stale event revision and invalid timezone are rejected',async t=>{
 const f=fixture(t),e=f.create('a');
 await assert.rejects(()=>f.events.register({event_id:e.id,slot:'bad',kind:'at_time',at:'2026-11-04T17:00:00'},'w'),/TIME_REQUIRES/);
 await f.events.register({event_id:e.id,slot:'due',kind:'at_time',at:'2026-11-04T17:00:00+08:00'},'w');
 assert.throws(()=>f.events.update({event_id:e.id,revision:e.revision,state:'active'}),/STALE_EVENT/);
});

test('web search evidence cannot substitute for publisher reads and old fetches expire',async t=>{
 const f=fixture(t);
 f.env.transport=async url=>({status:'ok',url,retrieved_at:new Date().toISOString(),text:'Publisher evidence',format:'page',title:'Test',content_hash:'a'});
 const found=await f.env.search('general topic');
 assert.throws(()=>f.env.verifyEvidence(found),/PUBLISHER_SOURCE/);
 const article=await f.env.readWeb('https://example.com/article');
 assert.doesNotThrow(()=>f.env.verifyEvidence(article));
 article.data.retrieved_at=new Date(Date.now()-121000).toISOString();
 assert.throws(()=>f.env.verifyEvidence(article),/STALE_WEB_EVIDENCE/);
});
test('agent-selected HTTP registration persists and returns the current event revision',async t=>{
 const f=fixture(t),e=f.create('web-event');
 f.env.transport=async url=>({status:'ok',url,retrieved_at:new Date().toISOString(),text:'Some facts',format:'page',title:'Test',content_hash:'a'});
 const result=await f.events.register({event_id:e.id,slot:'external',kind:'http_change',url:'https://example.com/feed',interval_seconds:60,not_before:''},'agent-wake');
 assert.equal(result.registration.created_by,'agent-wake');
 assert.equal(result.event.revision,2);assert.equal(result.registration.source,'web:https://example.com/feed');
 const reopened=new Store(f.root);assert.equal(reopened.registrations()[0].spec.url,'https://example.com/feed');reopened.close();
});
