import { readFileSync,writeFileSync,appendFileSync,existsSync,openSync,closeSync,unlinkSync,mkdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store,atomic,hash} from './store.mjs';
import {EnvironmentService} from './environment-service.mjs';
import {EventRegistry} from './event-registry.mjs';
const [command,rootArg,fixtureArg]=process.argv.slice(2);
const root=resolve(rootArg??'/opt/friends-loop-demo-20261104/v5/runs/live-01');
if(!root.startsWith('/opt/friends-loop-demo-20261104/v5/runs/'))throw Error('ISOLATED_RUN_PATH_REQUIRED');
if(command==='init'){
 if(existsSync(root))throw Error('FRESH_RUN_REQUIRED');
 const fixture=JSON.parse(readFileSync(fixtureArg,'utf8'));
 const target=new Date(Date.now()+(fixture.lead_seconds??300)*1000);
 const hhmmss=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(target);
 fixture.habit=fixture.habit.replace('{reading_time}',hhmmss);fixture.target_at=target.toISOString();
 const s=new Store(root);mkdirSync(join(root,'inbox'),{mode:0o700});
 s.set('clock',{mode:'wall',timezone:'Asia/Shanghai'});
 s.set('experiment',{label:fixture.label,synthetic:false,started_at:new Date().toISOString(),deadline:new Date(Date.now()+20*60000).toISOString()});s.set('dispatch_paused',false);
 const {IndividuationStore}=await import('/opt/cardbush/releases/1.0.14-20261102-1549/packages/bush-runtime/dist/individuationStore.js');
 const memory=new IndividuationStore(join(root,'habits.sqlite'));
 const result=await memory.summarize({habit:{text:fixture.habit,applies_when:fixture.applies_when}},{habits:true,predictions:false},{sessionId:'fixture-install',turnId:'before-agent-start',operationId:'preset-habit'},fixture.habit);
 const habits=(await memory.list({habits:true,predictions:false})).records;
 if(!habits.length)throw Error('HABIT_NOT_SAVED');
 s.set('target_at',fixture.target_at);
 s.set('preset_habits',habits.map(({id,revision,text,applies_when})=>({id,revision,text,applies_when})));
 s.enqueue('system.started','system',{reason:'runtime_initialized',habit_count:habits.length},'bootstrap');
 s.save();s.close();console.log(JSON.stringify({status:'initialized',root,habits:habits.length,events:0,registrations:0,user_messages:0,target_at:fixture.target_at,habit:fixture.habit}));
}else if(command==='inspect'){
 const s=new Store(root);console.log(JSON.stringify(s.report(),null,2));s.close();
}else if(command==='stop'){
 const lock=join(root,'daemon.lock');
 if(!existsSync(lock)){console.log('already stopped');process.exit(0);}
 const pid=Number(readFileSync(lock,'utf8')),cmd=readFileSync('/proc/'+pid+'/cmdline','utf8');
 if(!cmd.includes('/opt/friends-loop-demo-20261104/v5/main.mjs')||!cmd.includes(root))throw Error('PID_SCOPE_MISMATCH');
 process.kill(pid,'SIGTERM');console.log('stop requested '+pid);
}else if(command==='serve'){
 if(!existsSync(join(root,'state.sqlite')))throw Error('INIT_REQUIRED');
 const lock=join(root,'daemon.lock');
 if(existsSync(lock)){
  const old=Number(readFileSync(lock,'utf8'));try{process.kill(old,0);throw Error('ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;unlinkSync(lock);}
 }
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
 const s=new Store(root),environment=new EnvironmentService(s),events=new EventRegistry(s,environment);
 const emit=x=>{const line=JSON.stringify({wall_at:new Date().toISOString(),task_time:environment.clock().now,...x});appendFileSync(join(root,'activity.ndjson'),line+'\n',{mode:0o600});console.log(line);};
 const {FriendsLoop}=await import('./friends-loop.mjs');
 const maxCalls=80;
 const agent=new FriendsLoop(s,environment,events,{configPath:'/opt/friends-loop-demo-20261104/model.private.json',emit,maxCalls});
 const version=Object.fromEntries(['main.mjs','store.mjs','environment-service.mjs','event-registry.mjs','friends-loop.mjs'].map(f=>[f,hash(readFileSync(new URL(f,import.meta.url)))]));
 s.set('code_versions',[...s.get('code_versions',[]),{at:new Date().toISOString(),files:version}]);
 const recovered=s.recover();emit({event:'started',pid:process.pid,recovered});
 const controller=new AbortController();let stopping=false,active=null,lastHeartbeat=0,peakRss=0;
 const started=Date.now(),startCpu=process.cpuUsage();
 const stop=()=>{stopping=true;controller.abort();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{
  while(!stopping){
   if(Date.now()>=Date.parse(s.get('experiment').deadline)){emit({event:'test_window_ended'});stopping=true;break;}
   environment.tick();peakRss=Math.max(peakRss,process.memoryUsage().rss);
   const requests=s.db.prepare('SELECT count(*) n FROM requests').get().n,pending=s.db.prepare("SELECT count(*) n FROM signals WHERE state='pending'").get().n;
   if(Date.now()-lastHeartbeat>1000){
    const cpu=process.cpuUsage(startCpu);lastHeartbeat=Date.now();
    const metrics={pid:process.pid,phase:active?'working':s.get('dispatch_paused')?'dispatch_paused':requests>=maxCalls?'budget_paused':pending?'pending':'watching',model_requests:requests,pending,active_registrations:s.registrations().filter(r=>r.active).length,uptime_ms:Date.now()-started,cpu_ms:(cpu.user+cpu.system)/1000,peak_rss_bytes:peakRss,wall_at:new Date().toISOString(),task_time:environment.clock().now};
    s.set('metrics',metrics);atomic(join(root,'heartbeat.json'),JSON.stringify(metrics));
   }
   if(!active&&!s.get('dispatch_paused')&&requests<maxCalls){
    const batch=s.claim(environment.clock().now);
    if(batch){
     emit({event:'wake',wake:batch.id,signal_ids:batch.signals.map(x=>x.id)});
     active=(async()=>{
      try{
       const result=await agent.run(batch,controller.signal),report=s.finish(batch,result.finalText);
       emit({event:'terminal',wake:batch.id,status:result.terminalStatus,disposition:result.decision.disposition,report_id:report?.id??null});
       if(report)atomic(join(root,'latest-final-reply.txt'),report.final_text);
      }catch(e){const error=String(e.message).slice(0,1200);s.fail(batch,error);emit({event:'wake_failed',wake:batch.id,error});}
      finally{s.save();active=null;}
     })();
    }
   }
   await sleep(200);
  }
 }finally{
  controller.abort();if(active)await active;await agent.close();await environment.close();s.save();emit({event:'stopped',pid:process.pid});s.close();
  if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);
 }
}else throw Error('init|serve|inspect|stop required');
