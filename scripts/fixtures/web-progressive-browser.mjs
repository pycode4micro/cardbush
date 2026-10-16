// Synthetic multi-account, long-conversation fixture; no model requests or production credentials.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WebArtifactArchives, archiveRequest } from '../../dist-electron/webArtifactArchives.mjs';
import { conversationFixtureState, fixtureRecords, initialEvents, finalEvents, job } from './web-transcript-data.mjs';
const root=resolve(process.argv[2]||'dist-web');
const conversion=process.argv.includes('--conversion');
const large=process.argv.includes('--large-archive');
// Exercise downloads under the same CSP as the deployed gateway, including blob URLs.
const gatewaySource=await readFile(new URL('../../electron/webServer.mts',import.meta.url),'utf8');
const csp=gatewaySource.match(/setHeader\('Content-Security-Policy', "([^"]+)"\)/)?.[1];
if(!csp)throw new Error('Production CSP not found');
const picture=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBAAAAAAASUVORK5CYII=','base64');
const imagePaths=large?Array.from({length:32},(_,i)=>`/data/workspaces/generated/image-${i}/成品.png`):['/data/workspaces/generated/one/成品.png','/data/workspaces/generated/two/成品.png','/data/workspaces/generated/three/成品.png'];
const sessions=Array.from({length:85},(_,i)=>({id:'web-'+i.toString(16).padStart(40,'0'),title:`测试会话 ${String(i).padStart(3,'0')}`,archived:i>=80,pinned:false,updated_at:'2026-10-16T04:00:00.000Z',created_at:'2026-10-10T04:00:00.000Z'}));
const tokens=new Map(), watchers=new Set();let running=false,finished=false,delay=0,failImage=false,activeImages=0;
const stats={lists:[],states:[],imageReads:0,maxImages:0,tools:0,status:0,aborted:0,archiveReads:0,archiveRequests:0};
const archiveSize=large?5*1024*1024:picture.length;
const archives=new WebArtifactArchives({get:async owner=>({call:async(operation,input)=>{
  if(owner!=='alice'||operation!=='web.files'||!imagePaths.includes(input.path)||failImage)throw Error('Fixture file unavailable');
  const file={path:input.path,size:archiveSize,mime:'image/png'};
  if(input.action==='describe')return file;
  stats.archiveReads++;
  const bytes=large?Buffer.alloc(Math.min(512*1024,archiveSize-input.offset),imagePaths.indexOf(input.path)):picture;
  return {name:'成品.png',size:file.size,mime:file.mime,offset:input.offset,content:bytes.toString('base64'),done:input.offset+bytes.length===archiveSize};
}})});
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const body=async req=>{let value='';for await(const c of req)value+=c;return value?JSON.parse(value):{};};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const identity=owner=>({user:{id:owner,username:owner,display_name:owner==='alice'?'分页验收':'隔离账号',role:'member',is_active:true,department_id:null},csrf:'fixture',models:[{id:'fixture',name:'本地验收模型'}],defaultModelId:'fixture',toolsEnabled:true});
function fullState(session) {
  if(session===sessions[1])return finished?conversationFixtureState(session):{conversation:session,jobs:running?[{...job,status:'running'}]:[],solutions:[],snapshot:{turns:[]}};
  const state=conversationFixtureState(session);
  if(conversion)state.toolExecutions.at(-1).toolCall.name='mcp__plugin_volcengine_images_images__image_convert';
  state.snapshot.turns[0].messages.at(-1).message.content=`已生成本轮图片，可从产物下载。\n\n![款式一](${imagePaths[0]})\n\n![款式二](${imagePaths[1]})`;
  state.snapshot.turns.unshift(...Array.from({length:64},(_,i)=>({turnId:`older-${i}`,status:'completed',createdAt:session.created_at,messages:[
    {messageId:`user-${i}`,message:{role:'user',content:`第 ${i+1} 轮提问`}},
    {messageId:`answer-${i}`,message:{role:'assistant',content:`第 ${i+1} 轮答案\n\n![图片](/data/workspaces/generated/history/${i}.png)`}},
  ]})));
  return state;
}
const server=createServer(async(req,res)=>{try{
  res.setHeader('Content-Security-Policy',csp);
  const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
  if(path==='/__test/control'){const input=await body(req);if(input.delay!==undefined)delay=input.delay;if(input.failImage!==undefined)failImage=input.failImage;if(input.finish){finished=true;running=false;for(const watcher of watchers){for(const [i,event] of finalEvents.entries())watcher.write('data: '+JSON.stringify({type:'event',event:{...event,turnId:job.turnId,sequence:i+initialEvents.length+1}})+'\n\n');watcher.write('data: {"type":"end"}\n\n');watcher.end();}}json(res,{...stats,pictureHash:createHash('sha256').update(picture).digest('hex')});return;}
  if(path.endsWith('/auth/login')){const input=await body(req),token=randomUUID();tokens.set(token,input.username);res.setHeader('Set-Cookie',`fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);json(res,identity(input.username));return;}
  const token=req.headers.cookie?.match(/fixture=([^;]+)/)?.[1],owner=tokens.get(token);
  if(path.startsWith('/api/')){
    if(!owner){json(res,{error:'请登录'},401);return;}
    if(path.endsWith('/auth/me')){json(res,identity(owner));return;}
    if(path.endsWith('/auth/logout')){tokens.delete(req.headers.cookie?.match(/fixture=([^;]+)/)?.[1]);json(res,{});return;}
    if(req.headers['x-cardbush-user']&&req.headers['x-cardbush-user']!==owner){json(res,{error:'账号已切换'},401);return;}
    if(path.endsWith('/files/archives')&&req.method==='POST'){
      const input=archiveRequest.parse(await body(req));if(owner!=='alice'||!sessions.some(s=>s.id===input.sessionId))throw Error('Unknown session');
      const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
      stats.archiveRequests++;json(res,archives.status(await archives.prepare(owner,token,input,abort.signal)),201);return;
    }
    const archive=path.match(/\/files\/archives\/([a-f0-9]{64})(?:\/(status))?$/);
    if(archive){const ticket=archives.get(archive[1],owner,token);if(archive[2]){json(res,archives.status(ticket));return;}
      const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
      await archives.download(ticket,res,abort.signal,async()=>tokens.get(token)===owner);return;
    }
    if(path.endsWith('/sessions')){
      const items=owner==='alice'?sessions.filter(s=>s.archived===(url.searchParams.get('archived')==='true')&&s.title.includes(url.searchParams.get('q')||'')):[];
      const offset=Number(url.searchParams.get('cursor')||0),limit=Number(url.searchParams.get('limit')||30);stats.lists.push({offset,limit,q:url.searchParams.get('q')});
      json(res,{items:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null});return;
    }
    if(path.endsWith('/files/view')){
      if(owner!=='alice'){json(res,{error:'不存在'},404);return;}stats.imageReads++;activeImages++;stats.maxImages=Math.max(stats.maxImages,activeImages);
      await pause(80);activeImages--;if(failImage){json(res,{error:'暂不可用'},503);return;}
      res.writeHead(200,{'Content-Type':'image/png','Content-Length':picture.length});res.end(picture);return;
    }
    const session=sessions.find(s=>path.includes(s.id));if(!session||owner!=='alice'){json(res,{error:'不存在'},404);return;}
    if(path.endsWith('/messages')){const input=await body(req);running=true;finished=false;json(res,{...job,id:input.requestId,status:'running',completedAt:undefined},202);return;}
    if(path.endsWith('/events')){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const [i,event] of initialEvents.entries())res.write('data: '+JSON.stringify({type:'event',event:{...event,turnId:job.turnId,sequence:i+1}})+'\n\n');watchers.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),4000);res.on('close',()=>{clearInterval(timer);watchers.delete(res);});return;}
    if(path.endsWith('/status')){stats.status++;json(res,{jobs:fullState(session).jobs});return;}
    if(path.endsWith('/tools')){stats.tools++;const records=fixtureRecords(session.id);if(conversion)records.at(-1).toolCall.name='mcp__plugin_volcengine_images_images__image_convert';records.at(-1).result={mcp:{name:records.at(-1).toolCall.name},result:{structuredContent:{items:[{observation:{task:{kind:conversion?'image_conversion':'seedream',status:'succeeded',result:{data:imagePaths.map(local_path=>({local_path}))}}}}]}}};json(res,records);return;}
    const limit=Number(url.searchParams.get('limit')||20),before=url.searchParams.get('before');stats.states.push({id:session.id,limit,before});
    res.on('close',()=>{if(!res.writableEnded)stats.aborted++;});if(delay)await pause(delay);if(res.destroyed)return;
    const state=fullState(session),turns=state.snapshot.turns,end=before?turns.findIndex(t=>t.turnId===before):turns.length,start=Math.max(0,end-limit);
    state.snapshot.turns=turns.slice(start,end);state.history={nextCursor:start>0?turns[start].turnId:null};if(before){state.jobs=[];state.toolExecutions=[];}
    json(res,state);return;
  }
  const file=path.startsWith('/assets/')?join(root,path):join(root,'index.html');if(!resolve(file).startsWith(root)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream'});res.end(await readFile(file));
}catch(error){if(!res.destroyed){if(res.headersSent)res.destroy();else json(res,{error:error.message||String(error)},error.status||500);}}});
server.listen(5212,'127.0.0.1',()=>console.log('Progressive fixture http://127.0.0.1:5212 (alice/bob, any test password)'));
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
