import { mkdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id,hash,parse,atomic } from './store.mjs';
const text=(v,max=3000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('INVALID_TEXT');return v;};
const absoluteTime=v=>{if(typeof v!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('TIME_REQUIRES_ISO_WITH_ZONE');return new Date(v).toISOString();};
export class EventRegistry {
 constructor(store,environment){this.store=store;this.environment=environment;}
 event(key){const e=this.store.events().find(e=>e.id===key);if(!e)throw Error('UNKNOWN_EVENT');return e;}
 create(x,wake,habits){
  text(x.logical_key,160);text(x.title,160);text(x.intent);text(x.completion);
  if(!Array.isArray(x.habit_refs)||!x.habit_refs.length||x.habit_refs.some(r=>!habits.has(r.id+':'+r.revision)))throw Error('UNOBSERVED_HABIT_REFERENCE');
  const existing=this.store.events().find(e=>e.logical_key===x.logical_key);if(existing)return {status:'exists',event:existing};
  const key=id('event'),notBefore=x.not_before?absoluteTime(x.not_before):null;
  this.store.db.prepare('INSERT INTO events(id,logical_key,title,intent,completion,habit_refs,not_before,state,created,created_by,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(key,x.logical_key,x.title,x.intent,x.completion,JSON.stringify(x.habit_refs),notBefore,'planned',Date.now(),wake,Date.now());
  return {status:'created',event:this.event(key)};
 }
 async register(x,wake){
  const e=this.event(x.event_id);if(['completed','cancelled'].includes(e.state))throw Error('EVENT_CLOSED');
  text(x.slot,100);
  if(!['at_time','directory_change','http_change'].includes(x.kind))throw Error('INVALID_DETECTOR_KIND');
  let spec={},source,cursor=null,observation=null;
  if(x.kind==='at_time'){
   spec.at=absoluteTime(x.at);if(Date.parse(spec.at)<=Date.parse(this.environment.clock().now))throw Error('DETECTOR_TIME_MUST_BE_FUTURE');
   source='clock';
  }else if(x.kind==='http_change'){
   if(typeof x.url!=='string'||!x.url.startsWith('https://'))throw Error('PUBLIC_HTTPS_URL_REQUIRED');
   if(!Number.isInteger(x.interval_seconds)||x.interval_seconds<60||x.interval_seconds>3600)throw Error('INTERVAL_MUST_BE_60_TO_3600_SECONDS');
   if(this.store.registrations().filter(r=>r.active&&r.kind==='http_change').length>=8)throw Error('ACTIVE_SOURCE_LIMIT');
   spec={url:x.url,interval_seconds:x.interval_seconds,not_before:x.not_before?absoluteTime(x.not_before):null};
   source='web:'+x.url;
   observation=await this.environment.readWeb(x.url,{purpose:'registration'});
   if(observation.status!=='ok')throw Error('SOURCE_UNAVAILABLE: '+observation.code);
   cursor=observation.data.content_hash;
  }else{
   if(x.source_id!=='inbox')throw Error('UNKNOWN_SOURCE');
   source='inbox';spec.not_before=x.not_before?absoluteTime(x.not_before):null;
   observation=this.environment.registerBaseline();cursor=observation.version;
  }
  const old=this.store.registrations().find(r=>r.event_id===e.id&&r.slot===x.slot);
  if(old&&old.active&&old.kind===x.kind&&JSON.stringify(old.spec)===JSON.stringify(spec))return {status:'exists',registration:old,observation};
  const key=old?.id??id('registration'),generation=(old?.generation??0)+1;
  this.store.db.prepare('INSERT INTO registrations VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,slot) DO UPDATE SET kind=excluded.kind,source=excluded.source,spec=excluded.spec,active=1,cursor=excluded.cursor,generation=excluded.generation,created_by=excluded.created_by,created=excluded.created').run(key,e.id,x.slot,x.kind,source,JSON.stringify(spec),1,cursor,generation,wake,Date.now());
  this.store.db.prepare("UPDATE events SET state='waiting',revision=revision+1,updated=? WHERE id=?").run(Date.now(),e.id);
  if(x.kind==='http_change')this.store.set('http-state:'+key,{health:'available',checked_at:Date.now(),next_at:Date.now()+spec.interval_seconds*1000,failures:0});
  return {status:'registered',registration:this.store.registrations().find(r=>r.id===key),observation,event:this.event(e.id)};
 }
 cancelRegistration(x){
  const r=this.store.registrations().find(r=>r.id===x.registration_id);if(!r)throw Error('UNKNOWN_REGISTRATION');
  this.store.db.prepare('UPDATE registrations SET active=0 WHERE id=?').run(r.id);return {status:'cancelled',registration_id:r.id};
 }
 update(x){
  const e=this.event(x.event_id);
  if(e.revision!==x.revision)throw Error('STALE_EVENT_REVISION');
  if(['completed','cancelled'].includes(e.state))throw Error('EVENT_CLOSED');
  if(!['waiting','active','cancelled'].includes(x.state))throw Error('INVALID_EVENT_STATE');
  if(x.state==='waiting'&&!this.store.registrations().some(r=>r.event_id===e.id&&r.active))throw Error('WAIT_REQUIRES_REGISTRATION');
  this.store.db.prepare('UPDATE events SET state=?,revision=revision+1,updated=? WHERE id=?').run(x.state,Date.now(),e.id);
  if(x.state==='cancelled')this.store.db.prepare('UPDATE registrations SET active=0 WHERE event_id=?').run(e.id);
  return {status:'updated',event:this.event(e.id)};
 }
 writeArtifact(x,wake,observed){
  const e=this.event(x.event_id);if(['completed','cancelled'].includes(e.state))throw Error('EVENT_CLOSED');
  text(x.content,24000);
  if(!Array.isArray(x.evidence_ids)||!x.evidence_ids.length)throw Error('EVIDENCE_REQUIRED');
  const observations=x.evidence_ids.map(key=>{
   const obs=this.store.observation(key);if(!observed.has(key)||!obs||!(obs.source.startsWith('inbox/')||obs.source.startsWith('web:'))||!obs.data.text)throw Error('UNREAD_DOCUMENT_EVIDENCE');
   this.environment.verifyEvidence(obs);
   return obs;
  });
  const old=this.store.db.prepare('SELECT * FROM artifacts WHERE event_id=?').get(e.id),key=old?.id??id('artifact');
  const path=join(this.store.root,'artifacts',e.id+'.md'),sha256=hash(x.content);
  mkdirSync(join(this.store.root,'artifacts'),{recursive:true,mode:0o700});
  atomic(path,x.content);
  this.store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET content=excluded.content,sha256=excluded.sha256,evidence=excluded.evidence,created_by=excluded.created_by,created=excluded.created').run(key,e.id,path,x.content,sha256,JSON.stringify(x.evidence_ids),wake,Date.now());
  return {status:'written',artifact_id:key,event_id:e.id,path,sha256,evidence:observations.map(o=>({id:o.id,source:o.source,version:o.version}))};
 }
 complete(x){
  const e=this.event(x.event_id);
  if(e.state==='completed')return {status:'already_completed',event:e};
  if(e.state==='cancelled')throw Error('EVENT_CLOSED');
  if(e.not_before&&Date.parse(this.environment.clock().now)<Date.parse(e.not_before))throw Error('EVENT_NOT_YET_DUE');
  const artifact=this.store.db.prepare('SELECT * FROM artifacts WHERE id=? AND event_id=?').get(x.artifact_id,e.id);
  if(!artifact||hash(readFileSync(artifact.path,'utf8'))!==artifact.sha256)throw Error('VERIFIED_ARTIFACT_REQUIRED');
  // Recheck evidence immediately before completion, including artifacts prepared in an earlier activation.
  for(const key of parse(artifact.evidence)){
   this.environment.verifyEvidence(this.store.observation(key));
  }
  this.store.tx(()=>{
   this.store.db.prepare("UPDATE events SET state='completed',revision=revision+1,artifact_id=?,updated=? WHERE id=?").run(artifact.id,Date.now(),e.id);
   this.store.db.prepare('UPDATE registrations SET active=0 WHERE event_id=?').run(e.id);
  });
  return {status:'completed',event:this.event(e.id),artifact:{id:artifact.id,path:artifact.path,sha256:artifact.sha256},delivery:'awaiting_actual_terminal_model_reply'};
 }
 context(){return {events:this.store.events(),registrations:this.store.registrations(),artifacts:this.store.db.prepare('SELECT id,event_id,path,sha256,evidence FROM artifacts').all(),reported_events:this.store.db.prepare('SELECT event_id FROM reported_events').all()};}
}
