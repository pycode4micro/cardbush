// Manual browser regression fixture: loopback only, no production credentials or model calls.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = resolve(process.argv[2] || 'dist-web');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBAAAAAAASUVORK5CYII=', 'base64');
const attachment = { id: randomUUID(), path: '/data/workspaces/uploads/cache-check.png', name: 'cache-check.png', mime: 'image/png', size: image.length };
const sessions = ['a','b'].map((key,index) => ({ id: 'web-'+key.repeat(40), title: index ? '会话乙 · 切换缓存' : '会话甲 · 图片缓存', pinned: false, archived: false, updated_at: new Date().toISOString(), created_at: new Date().toISOString() }));
const stats = { stateReads: 0, imageReads: 0, listReads: 0, blockedReads: 0 }; let hold = false;
const tokens = new Map(); const pending = new Map();
const json = (response, value, status=200) => { response.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); response.end(JSON.stringify(value)); };
const body = async request => { let result='';for await(const part of request)result+=part;return result?JSON.parse(result):{}; };
const server=createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://127.0.0.1'),path=url.pathname;
    if(path==='/__test/control'){const input=await body(request);if(input.hold!==undefined)hold=input.hold;json(response,{hold,...stats});return;}
    if(path==='/api/web/v1/auth/login'){const input=await body(request);const token=randomUUID();tokens.set(token,input.username);response.setHeader('Set-Cookie',`fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);json(response,identity(input.username));return;}
    const token=request.headers.cookie?.match(/fixture=([^;]+)/)?.[1],owner=tokens.get(token);
    if(path.startsWith('/api/')){
      if(!owner){json(response,{error:'请登录后继续'},401);return;}
      if(path.endsWith('/auth/me')){json(response,identity(owner));return;}
      if(path.endsWith('/auth/logout')){tokens.delete(token);json(response,{});return;}
      if(request.headers['x-cardbush-user']&&request.headers['x-cardbush-user']!==owner){json(response,{error:'账号已切换'},401);return;}
      if(request.method==='GET'&&!path.endsWith('/events')){if(hold)stats.blockedReads++;while(hold&&!response.destroyed)await new Promise(r=>setTimeout(r,100));if(response.destroyed)return;}
      if(path.endsWith('/sessions')){stats.listReads++;json(response,owner==='alice'?sessions:[]);return;}
      if(path.includes('/files/view')){stats.imageReads++;response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});response.end(image);return;}
      const session=sessions.find(item=>path.includes(item.id));if(!session||owner!=='alice'){json(response,{error:'不存在'},404);return;}
      if(path.endsWith('/messages')){const input=await body(request);const job={id:input.requestId,turnId:'turn-'+input.requestId,text:input.text,status:'running',modelId:'fixture',attachments:[attachment]};pending.set(session.id,job);json(response,job,202);return;}
      if(path.endsWith('/events')){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"type":"ready"}\n\n');const timer=setInterval(()=>response.write(': heartbeat\n\n'),5000);response.on('close',()=>clearInterval(timer));return;}
      stats.stateReads++;
      json(response,{conversation:session,solutions:[],jobs:pending.has(session.id)?[pending.get(session.id)]:[],snapshot:{turns:[{turnId:'done',messages:[{messageId:'user',message:{role:'user',content:session===sessions[0]?'这张图片会在本机保留，请帮我看一下。':'这里是另一段独立对话。'},metadata:{attachments:session===sessions[0]?[attachment]:[]}},{messageId:'assistant',message:{role:'assistant',content:session===sessions[0]?'图片与历史消息已显示。切换对话或刷新后，缓存会先呈现，再后台核对更新。':'切回会话甲时，原来的内容应当立即出现。'}}]}]}});return;
    }
    const file=path.startsWith('/assets/')?join(root,path):join(root,'index.html');if(!resolve(file).startsWith(root)){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});response.end(await readFile(file));
  }catch(error){json(response,{error:String(error)},500);}
});
function identity(owner){return {user:{id:owner,username:owner,display_name:owner==='alice'?'缓存测试甲':'缓存测试乙',role:'member',is_active:true,department_id:null},csrf:'fixture',models:[{id:'fixture',name:'本地测试模型'}],defaultModelId:'fixture',toolsEnabled:true};}
server.listen(5208,'127.0.0.1',()=>console.log('Cache browser fixture: http://127.0.0.1:5208 (alice/bob, any test password)'));
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
