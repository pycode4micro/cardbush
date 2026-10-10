// Browser regression harness. Loopback, synthetic accounts and image; no model/API calls.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { conversationFixtureState, fixtureRecords, sessions, job, imagePath, initialEvents, finalEvents } from './web-transcript-data.mjs';
const root=resolve(process.argv[2]||'dist-web'), evidence=resolve('tmp/web-transcript-browser');await mkdir(evidence,{recursive:true});
const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="700"><rect width="700" height="700" fill="#e5e0d7"/><rect x="50" y="50" width="600" height="600" rx="24" fill="#f3f0e9"/><path d="M240 160 170 190 100 360 170 395 230 275 230 550 470 550 470 275 530 395 600 360 530 190 460 160 390 205 310 205Z" fill="#92948f"/><path d="M240 160 350 270 460 160M350 270V550" fill="none" stroke="#646962" stroke-width="12"/><path d="M240 505H320M380 505H460" stroke="#777d75" stroke-width="9"/><g fill="#deded4"><circle cx="365" cy="315" r="6"/><circle cx="365" cy="385" r="6"/><circle cx="365" cy="455" r="6"/></g><text x="350" y="610" text-anchor="middle" fill="#777363" font-size="20">GREY KNIT · RENDER TEST</text></svg>')).png().toBuffer();
const tokens=new Map(), watchers=new Set();let active=false,finished=false;const stats={imageReads:0,stateReads:0};
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const body=async req=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>1_000_000)throw Error('Payload too large');}return text?JSON.parse(text):{};};
const identity=owner=>({user:{id:owner,username:owner,display_name:'渲染验收',role:'member',is_active:true,department_id:null},csrf:'fixture',models:[{id:'fixture',name:'本地渲染测试'}],defaultModelId:'fixture',toolsEnabled:true});
const frame=(event,index)=>({type:'event',event:{...event,turnId:job.turnId,sequence:index+1,createdAt:job.createdAt}});
const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
  if(path==='/__test') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><title>渲染验收控制</title><h1>本机渲染验收</h1><button id="finish">完成流式回复</button><p id="status"></p><textarea aria-label="截图数据"></textarea><input aria-label="截图名称" value="native-rendering"/><button id="save">保存截图</button><p id="proof"></p><script>finish.onclick=async()=>{await fetch("/__test/finish",{method:"POST"});status.textContent="已完成";};save.onclick=async()=>{const result=await(await fetch("/__test/screenshot",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jpeg:document.querySelector("textarea").value,name:document.querySelector("input").value})})).json();proof.textContent=result.path||result.error;};</script>');return;}
  if(path==='/__test/screenshot'&&req.method==='POST'){const input=await body(req),data=Buffer.from(input.jpeg,'base64');if(!/^[a-z0-9-]+$/.test(input.name)||data[0]!==255||data[1]!==216)throw Error('Invalid screenshot');const file=join(evidence,input.name+'.jpg');await writeFile(file,data);json(res,{path:file});return;}
  if(path==='/__test/finish'&&req.method==='POST'){finished=true;for(const watcher of watchers){for(const [i,event] of finalEvents.entries())watcher.write('data: '+JSON.stringify(frame(event,initialEvents.length+i))+'\n\n');watcher.write('data: {"type":"end"}\n\n');watcher.end();}json(res,{finished,...stats});return;}
  if(path==='/__test/evidence'){json(res,{active,finished,...stats});return;}
  if(path==='/api/web/v1/auth/login'){const input=await body(req);if(!['alice','bob'].includes(input.username))throw Error('Use alice/bob');const token=randomUUID();tokens.set(token,input.username);res.setHeader('Set-Cookie',`fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);json(res,identity(input.username));return;}
  const token=req.headers.cookie?.match(/fixture=([^;]+)/)?.[1],owner=tokens.get(token);
  if(path.startsWith('/api/')){
    if(!owner){json(res,{error:'请登录'},401);return;}
    if(path.endsWith('/auth/me')){json(res,identity(owner));return;}
    if(path.endsWith('/auth/logout')){tokens.delete(token);json(res,{});return;}
    if(req.headers['x-cardbush-user']&&req.headers['x-cardbush-user']!==owner){json(res,{error:'账号已切换'},401);return;}
    if(path.endsWith('/sessions')){json(res,owner==='alice'?sessions:[]);return;}
    if(path.endsWith('/files/view')){if(owner!=='alice'||url.searchParams.get('path')!==imagePath){json(res,{error:'Not found'},404);return;}stats.imageReads++;res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length});res.end(image);return;}
    const session=sessions.find(item=>path.includes(item.id));if(!session||owner!=='alice'){json(res,{error:'不存在'},404);return;}
    if(path.endsWith('/messages')){await body(req);active=true;finished=false;json(res,{...job,status:'running',completedAt:undefined},202);return;}
    if(path.endsWith('/events')){res.writeHead(200,{'Content-Type':'text/event-stream'});const cursor=Number(url.searchParams.get('afterSequence')??0);for(const [i,event]of (finished?[...initialEvents,...finalEvents]:initialEvents).entries())if(i+1>cursor)res.write('data: '+JSON.stringify(frame(event,i))+'\n\n');if(finished){res.write('data: {"type":"end"}\n\n');res.end();return;}watchers.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),5000);res.on('close',()=>{watchers.delete(res);clearInterval(timer);});return;}
    if(path.endsWith('/tools')){json(res,fixtureRecords(session.id));return;}
    stats.stateReads++;json(res,session===sessions[0]||finished?conversationFixtureState(session):{conversation:session,solutions:[],jobs:active?[{...job,status:'running'}]:[],snapshot:{turns:[]}});return;
  }
  const file=path.startsWith('/assets/')?join(root,path):join(root,'index.html');if(!resolve(file).startsWith(root)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(await readFile(file));
}catch(error){json(res,{error:String(error)},500);}});
server.listen(5210,'127.0.0.1',()=>console.log('Transcript fixture http://127.0.0.1:5210 · alice/bob with any test password; control /__test'));
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
