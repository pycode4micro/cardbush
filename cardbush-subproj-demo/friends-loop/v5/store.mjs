import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export const id=p=>p+'_'+randomUUID();
export const parse=x=>x==null?null:JSON.parse(x);
export function atomic(path,content){writeFileSync(path+'.tmp',content,{mode:0o600});renameSync(path+'.tmp',path);}
export class Store {
 constructor(root){
  this.root=root;mkdirSync(root,{recursive:true,mode:0o700});
  this.db=new DatabaseSync(join(root,'state.sqlite'));this.db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;');
  this.db.exec(`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS signals(id TEXT PRIMARY KEY,dedup TEXT UNIQUE,kind TEXT,origin TEXT,data TEXT,created INTEGER,state TEXT DEFAULT 'pending',wake TEXT,attempts INTEGER DEFAULT 0,available INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS wakes(id TEXT PRIMARY KEY,started INTEGER,finished INTEGER,status TEXT,signal_ids TEXT,clock TEXT,final_text TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,source TEXT,version TEXT,data TEXT,wall_at INTEGER,virtual_at TEXT,UNIQUE(source,version));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,logical_key TEXT UNIQUE,title TEXT,intent TEXT,completion TEXT,habit_refs TEXT,not_before TEXT,state TEXT,revision INTEGER DEFAULT 1,created INTEGER,created_by TEXT,artifact_id TEXT,updated INTEGER);
CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,event_id TEXT,slot TEXT,kind TEXT,source TEXT,spec TEXT,active INTEGER,cursor TEXT,generation INTEGER,created_by TEXT,created INTEGER,UNIQUE(event_id,slot));
CREATE TABLE IF NOT EXISTS effects(id INTEGER PRIMARY KEY AUTOINCREMENT,wake TEXT,name TEXT,input TEXT,output TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,event_id TEXT UNIQUE,path TEXT,content TEXT,sha256 TEXT,evidence TEXT,created_by TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,wake TEXT,final_text TEXT,event_ids TEXT,artifact_ids TEXT,created INTEGER,virtual_at TEXT);
CREATE TABLE IF NOT EXISTS reported_events(event_id TEXT PRIMARY KEY,report_id TEXT);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT,wake TEXT,started INTEGER,finished INTEGER,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,status TEXT);
`);
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 set(k,v){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));}
 get(k,f=null){return parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value)??f;}
 enqueue(kind,origin,data,dedup){
  const key=id('signal');this.db.prepare('INSERT OR IGNORE INTO signals(id,dedup,kind,origin,data,created) VALUES(?,?,?,?,?,?)').run(key,dedup,kind,origin,JSON.stringify(data),Date.now());
  return this.db.prepare('SELECT id,state FROM signals WHERE dedup=?').get(dedup);
 }
 observe(source,version,data,clock){
  const key=id('obs');this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?)').run(key,source,version,JSON.stringify(data),Date.now(),clock);
  const r=this.db.prepare('SELECT * FROM observations WHERE source=? AND version=?').get(source,version);
  return {...r,data:parse(r.data)};
 }
 observation(key){const r=this.db.prepare('SELECT * FROM observations WHERE id=?').get(key);return r?{...r,data:parse(r.data)}:null;}
 effect(wake,name,input,output){this.db.prepare('INSERT INTO effects(wake,name,input,output,created) VALUES(?,?,?,?,?)').run(wake,name,JSON.stringify(input),JSON.stringify(output),Date.now());}
 recover(){return this.tx(()=>{const n=this.db.prepare("UPDATE signals SET state='pending',wake=NULL WHERE state='running'").run().changes;this.db.prepare("UPDATE wakes SET status='interrupted',finished=? WHERE status='running'").run(Date.now());return n;});}
 claim(clock){return this.tx(()=>{
  const rows=this.db.prepare("SELECT * FROM signals WHERE state='pending' AND available<=? ORDER BY created,id LIMIT 20").all(Date.now());if(!rows.length)return null;
  const key=id('wake');for(const r of rows)this.db.prepare("UPDATE signals SET state='running',wake=?,attempts=attempts+1 WHERE id=?").run(key,r.id);
  this.db.prepare('INSERT INTO wakes(id,started,status,signal_ids,clock) VALUES(?,?,?,?,?)').run(key,Date.now(),'running',JSON.stringify(rows.map(x=>x.id)),clock);
  return {id:key,clock,signals:rows.map(r=>({...r,data:parse(r.data)}))};
 });}
 finish(batch,finalText){
  return this.tx(()=>{
   const completed=this.db.prepare("SELECT e.* FROM events e LEFT JOIN reported_events r ON r.event_id=e.id WHERE e.state='completed' AND r.event_id IS NULL").all();
   let report=null;
   if(completed.length){
    if(!finalText.trim())throw Error('MISSING_FINAL_REPLY');
    const arts=completed.map(e=>this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(e.artifact_id));
    if(arts.some(a=>!a||hash(readFileSync(a.path,'utf8'))!==a.sha256))throw Error('ARTIFACT_VERIFICATION_FAILED');
    report={id:id('report'),wake:batch.id,final_text:finalText,event_ids:completed.map(e=>e.id),artifact_ids:arts.map(a=>a.id),created:Date.now(),virtual_at:batch.clock};
    this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?,?,?)').run(report.id,report.wake,report.final_text,JSON.stringify(report.event_ids),JSON.stringify(report.artifact_ids),report.created,report.virtual_at);
    for(const e of completed)this.db.prepare('INSERT INTO reported_events VALUES(?,?)').run(e.id,report.id);
   }
   this.db.prepare("UPDATE wakes SET status='completed',finished=?,final_text=? WHERE id=?").run(Date.now(),finalText,batch.id);
   this.db.prepare("UPDATE signals SET state='done' WHERE wake=? AND state='running'").run(batch.id);
   return report;
  });
 }
 fail(batch,error){
  this.tx(()=>{this.db.prepare("UPDATE wakes SET status='failed',finished=?,error=? WHERE id=?").run(Date.now(),error,batch.id);
   this.db.prepare("UPDATE signals SET state=CASE WHEN attempts>=3 THEN 'blocked' ELSE 'pending' END,available=? WHERE wake=?").run(Date.now()+15000,batch.id);
  });
 }
 events(){return this.db.prepare('SELECT * FROM events ORDER BY created,id').all().map(x=>({...x,habit_refs:parse(x.habit_refs)}));}
 registrations(){return this.db.prepare('SELECT * FROM registrations ORDER BY created,id').all().map(x=>({...x,spec:parse(x.spec)}));}
 report(){
  const rows=(sql)=>this.db.prepare(sql).all();
  return {root:this.root,model:this.get('model'),metrics:this.get('metrics'),events:this.events(),registrations:this.registrations(),
   wakes:rows('SELECT * FROM wakes ORDER BY started'),reports:rows('SELECT * FROM reports ORDER BY created'),
   artifacts:rows('SELECT * FROM artifacts ORDER BY created'),
   signals:rows('SELECT * FROM signals ORDER BY created').map(x=>({...x,data:parse(x.data)})),
   calls:rows('SELECT count(*) calls,coalesce(sum(input_tokens),0) input_tokens,coalesce(sum(output_tokens),0) output_tokens,coalesce(sum(cached_tokens),0) cached_tokens FROM requests')[0],
   effects:rows('SELECT * FROM effects ORDER BY id').map(x=>({...x,input:parse(x.input),output:parse(x.output)})),
   user_signal_count:rows("SELECT count(*) n FROM signals WHERE origin IN ('user','fixture_user')")[0].n,
   user_model_message_count:this.get('user_model_message_count',0)};
 }
 save(){atomic(join(this.root,'audit.json'),JSON.stringify(this.report(),null,2));}
 close(){this.db.close();}
}
