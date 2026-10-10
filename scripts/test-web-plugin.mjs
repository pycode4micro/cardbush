import sharp from 'sharp';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentService } from '../dist-electron/agentService.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const prefix='mcp__plugin_volcengine_images_images__';
test('native image plugin installation, restricted schema, durable async task and private output', { timeout:60000 }, async t=>{
  const root=await mkdtemp(join(tmpdir(),'web-plugin-')); let paid=0,round=0,taskId,outputPath;
  const png=await sharp({create:{width:32,height:32,channels:3,background:'#ff0000'}}).png().toBuffer();
  const gateway=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    assert.equal(req.headers.authorization,'Bearer '+'g'.repeat(64));
    const body=JSON.parse(raw);assert.equal(body.response_format,'b64_json');assert.equal(body.tools,undefined);paid++;
    await pause(1100);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  });gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  const model=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    if(req.url.endsWith('input_tokens')){res.end(JSON.stringify({input_tokens:100}));return;}
    round++;
    const names=body.tools.map(tool=>tool.name ?? tool.function?.name);
    if(round<4) for(const name of ['seedream_create_task','seedream_get_task','generation_wait_tasks'])assert.ok(names.includes(prefix+name),JSON.stringify(names));
    assert.equal(names.length,round<4?10:6);assert.ok(!names.includes('terminal_exec'));
    if(round===2){const db=new DatabaseSync(join(root,'plugin-state/images/jobs.sqlite3'),{readOnly:true});taskId=db.prepare('SELECT id FROM jobs').get().id;db.close();}
    let item;
    if(round<3)item={id:'call-'+round,call_id:'call-'+round,type:'function_call',name:prefix+(round===1?'seedream_create_task':'generation_wait_tasks'),arguments:JSON.stringify(round===1?{request:{prompt:'A red square',size:'1K'},request_id:'web-native-test-001'}:{tasks:[{kind:'seedream',task_id:taskId}],timeout_seconds:10,mode:'all'}),status:'completed'};
    else item={id:'msg-'+round,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Completed image.',annotations:[]}]};
    res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=v=>res.write('data: '+JSON.stringify(v)+'\n\n');
    const response={id:'resp-'+round,object:'response',model:body.model,status:'in_progress',store:false,output:[]};
    emit({type:'response.created',response});emit({type:'response.output_item.added',output_index:0,item:{...item,content:[]}});
    emit(item.type==='function_call'?{type:'response.function_call_arguments.delta',output_index:0,delta:item.arguments}:{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'Completed image.'});
    emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120}}});res.end();
  });model.listen(0,'127.0.0.1');await once(model,'listening');
  const service=await AgentService.open({dataRoot:root,webRestricted:true,env:{CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS:'1'}});
  t.after(async()=>{await service.close();model.closeAllConnections();model.close();gateway.closeAllConnections();gateway.close();await rm(root,{recursive:true,force:true});});
  await service.call('product.command',{kind:'models.update',config:{defaultModelId:'fixture',models:[{id:'fixture',provider:'openai',model:'fixture',apiKey:'fixture',baseURL:`http://127.0.0.1:${model.address().port}/v1`}]}});
  await service.call('web.configure',{imageEnabled:true,gateway:`http://127.0.0.1:${gateway.address().port}/images/generations`,credential:'g'.repeat(64)});
  await service.call('sessions.create',{sessionId:'images'});
  await service.call('chat.send',{requestId:'image-round',sessionId:'images',text:'Generate a red square.',modelId:'fixture'});
  let jobs;
  for(let i=0;i<450;i++){jobs=await service.call('chat.jobs',{});if(jobs.every(job=>!['running','queued'].includes(job.status)))break;await pause(100);}
  if(jobs[0].status !== 'completed') console.log(JSON.stringify((await service.product.listMcpServers()).runtime));
  assert.equal(jobs[0].status,'completed',JSON.stringify(jobs));assert.equal(round,3);assert.equal(paid,1);
  const db=new DatabaseSync(join(root,'plugin-state/images/jobs.sqlite3'),{readOnly:true});const row=db.prepare('SELECT * FROM jobs').get();db.close();
  assert.equal(row.status,'succeeded',row.result);outputPath=JSON.parse(row.result).data[0].local_path;
  assert.ok(outputPath.startsWith(join(root,'workspaces','generated')));assert.ok((await readFile(outputPath)).length>20);
  assert.equal((await service.call('web.activity',{})).active,false);
  await service.call('web.configure',{imageEnabled:false,gateway:`http://127.0.0.1:${gateway.address().port}/images/generations`,credential:'g'.repeat(64)});
  await service.call('chat.send',{requestId:'revoked-round',sessionId:'images',text:'Continue without image tools.',modelId:'fixture'});
  for(let i=0;i<100;i++){jobs=await service.call('chat.jobs',{});if(jobs.every(job=>!['running','queued'].includes(job.status)))break;await pause(100);}
  assert.equal(jobs.find(job=>job.id==='revoked-round').status,'completed',JSON.stringify(jobs));
  assert.equal(await readFile(join(root,'plugins/volcengine_images/.codex-plugin/plugin.json')).then(()=>true,()=>false),false);
  assert.equal(paid,1);
});
