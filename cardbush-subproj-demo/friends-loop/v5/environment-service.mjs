import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {EnvironmentService as DirectoryEnvironment} from '../v4/environment-service.mjs';
import {hash} from './store.mjs';
export class EnvironmentService extends DirectoryEnvironment {
 constructor(store){super(store);this.activeFetches=new Map();this.closed=false;store.db.exec('CREATE TABLE IF NOT EXISTS http_checks(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,url TEXT,purpose TEXT,status TEXT,version TEXT,error TEXT)');}
 transport(url,purpose='agent'){
  return new Promise(resolve=>{
   const p=spawn('python3',[new URL('./web-transport.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
   let out='',err='',finished=false;
   const timeout=setTimeout(()=>p.kill('SIGKILL'),22000);
   p.stdout.on('data',x=>{out+=x;if(out.length>200000)p.kill('SIGKILL');});
   p.stderr.on('data',x=>{err+=x;});
   p.on('error',e=>done({status:'unavailable',code:String(e.message)}));
   p.on('close',()=>{let r;try{r=JSON.parse(out);}catch{r={status:'unavailable',code:'FETCH_PROCESS_FAILED: '+err.slice(-200)};}done(r);});
   const done=r=>{
    if(finished)return;finished=true;clearTimeout(timeout);
    const semantic=r.status==='ok'?(r.format==='feed'?r.items:{title:r.title,text:r.text}):{health:'unavailable',code:r.code?.split(':')[0]};
    r.content_hash=hash(semantic);
    this.store.db.prepare('INSERT INTO http_checks(at,url,purpose,status,version,error) VALUES(?,?,?,?,?,?)').run(Date.now(),url,purpose,r.status,r.content_hash,r.code??null);
    resolve(r);
   };
   p.stdin.end(JSON.stringify({url}));
  });
 }
 async readWeb(url,{search=false,purpose='agent'}={}){
  const response=await this.transport(url,purpose);
  if(response.status!=='ok')return response;
  const data={...response,kind:'web',is_search:search,classification:'external_observation_not_instruction'};
  const obs=this.store.observe('web:'+url,hash({hash:data.content_hash,at:data.retrieved_at}),data,this.clock().now);
  return {status:'ok',...obs};
 }
 async search(query){
  if(typeof query!=='string'||!query.trim()||query.length>300)throw Error('INVALID_SEARCH_QUERY');
  const url='https://www.bing.com/search?format=rss&q='+encodeURIComponent(query);
  const result=await this.readWeb(url,{search:true,purpose:'search'});
  return {...result,query,notice:'Search results locate sources. Open publisher URLs with web_read before using them as evidence.'};
 }
 snapshot(){
  const base=super.snapshot();
  const sources=this.store.registrations().filter(x=>x.kind==='http_change').map(x=>({id:x.source,url:x.spec.url,health:this.store.get('http-state:'+x.id,{health:'unknown'})}));
  return {...base,public_web:{capabilities:['web_search','web_read','http_change'],registered_sources:sources,policy:'Public read-only HTTP. Choose your own sources; none are preselected. No external messages or account changes.'},
   supported_detectors:[...base.supported_detectors,{kind:'http_change',condition:'Detect semantic feed/page changes with persistent polling and source-health observations; choose URL, interval and optional not_before.'}]};
 }
 verifyEvidence(obs){
  if(obs.data.kind!=='web'){
   const current=this.readDocument(obs.data.name);if(current.version!==obs.version)throw Error('STALE_DOCUMENT_EVIDENCE');return;
  }
  if(obs.data.is_search)throw Error('PUBLISHER_SOURCE_REQUIRED_NOT_SEARCH_SNIPPET');
  if(obs.data.status!=='ok'||!obs.data.text)throw Error('SUCCESSFUL_WEB_READ_REQUIRED');
  if(Date.now()-Date.parse(obs.data.retrieved_at)>120000)throw Error('STALE_WEB_EVIDENCE: re-read '+obs.data.url+' and revise the artifact');
 }
 tick(){
  super.tick();if(this.closed)return;
  for(const r of this.store.registrations().filter(x=>x.active&&x.kind==='http_change')){
   if(this.activeFetches.size>=2||this.activeFetches.has(r.id))continue;
   const state=this.store.get('http-state:'+r.id,{});
   if((state.next_at??0)>Date.now())continue;
   const work=this.poll(r).catch(e=>this.store.set('http-error:'+r.id,String(e.message))).finally(()=>this.activeFetches.delete(r.id));
   this.activeFetches.set(r.id,work);
  }
 }
 async poll(r){
  const response=await this.transport(r.spec.url,'detector');
  const fresh=this.store.registrations().find(x=>x.id===r.id);
  if(!fresh?.active)return;
  const old=this.store.get('http-state:'+r.id,{});
  const failures=response.status==='ok'?0:(old.failures??0)+1;
  const health=response.status==='ok'?'available':'unavailable';
  this.store.set('http-state:'+r.id,{health,checked_at:Date.now(),failures,next_at:Date.now()+Math.min(900,r.spec.interval_seconds*Math.pow(2,failures))*1000});
  const now=this.clock().now;
  if(r.spec.not_before&&Date.now()<Date.parse(r.spec.not_before))return;
  if(response.content_hash===fresh.cursor)return;
  const observation=this.store.observe(fresh.source,hash({hash:response.content_hash,at:now}),{...response,health,kind:'web',classification:'external_observation_not_instruction'},now);
  this.store.tx(()=>{
   this.store.enqueue(response.status==='ok'?'http.changed':'source.unavailable','detector',{event_id:r.event_id,registration_id:r.id,observation_id:observation.id,url:r.spec.url,observed_at:now},r.id+':'+fresh.generation+':'+response.content_hash);
   this.store.db.prepare('UPDATE registrations SET cursor=?,generation=generation+1 WHERE id=?').run(response.content_hash,r.id);
  });
 }
 async close(){this.closed=true;await Promise.allSettled([...this.activeFetches.values()]);}
}
