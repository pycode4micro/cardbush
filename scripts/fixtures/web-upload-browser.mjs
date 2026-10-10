// Loopback-only browser regression: generated images and private local upload folders, no production credentials or models.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { AgentWebFiles } from '../../dist-electron/agentWebFiles.mjs';

const staticRoot = resolve(process.argv[2] || 'dist-web');
const base = resolve('tmp/web-upload-browser'); await mkdir(base,{recursive:true});
const root = await mkdtemp(join(base,'run-')), sources = join(root,'sources'); await mkdir(sources);
const samples = [
  { name:'large-screenshot.png', bytes:await sharp({create:{width:6000,height:4000,channels:4,background:'#f5f0e8'}}).composite([{input:Buffer.from('<svg width="6000" height="4000"><text x="180" y="300" font-size="140" fill="#34372b">Large screenshot - 6000 x 4000 - upload check</text><rect x="180" y="550" width="4000" height="2600" rx="100" fill="#d4c7b3"/></svg>')}]).png().toBuffer() },
  { name:'large-photo.png', bytes:await sharp(randomBytes(3400*2400*3),{raw:{width:3400,height:2400,channels:3}}).png().toBuffer() },
];
for(const sample of samples) await writeFile(join(sources,sample.name),sample.bytes);
const tokens=new Map(), agents=new Map(), attachments=new Map(), evidence=[];
const json=(response,value,status=200)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
const body=async request=>{let text='';for await(const chunk of request){text+=chunk;if(text.length>800000)throw Error('request too large');}return text?JSON.parse(text):{};};
const identity=owner=>({user:{id:owner,username:owner,display_name:'上传测试',role:'member',is_active:true,department_id:null},csrf:'fixture',models:[{id:'fixture',name:'本地测试模型'}],defaultModelId:'fixture',toolsEnabled:true});
const server=createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://127.0.0.1'),path=url.pathname;
    if(path==='/__test/images') {
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      response.end(`<!doctype html><html lang="zh-CN"><title>上传回归图片</title><style>body{font:18px sans-serif;padding:40px}button,a{display:block;margin:20px 0;padding:12px}img{max-width:500px}</style><h1>生成的测试图片</h1><p>图片不含个人信息。仅用于本机上传回归。</p>${samples.map(sample=>`<button data-name="${sample.name}">复制 ${sample.name}</button><a href="/__test/source/${sample.name}" download>下载 ${sample.name}（${(sample.bytes.length/1024/1024).toFixed(1)} MB）</a>`).join('')}<p role="status">请选择测试图片</p><img alt="待粘贴测试图片"><a href="/">进入上传测试网站</a><details><summary>保存验收截图</summary><textarea aria-label="验收截图数据"></textarea><button id="save-proof">保存验收截图</button><p id="proof-result"></p></details><script>document.querySelector("#save-proof").onclick=async()=>{const result=await(await fetch("/__test/screenshot",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jpeg:document.querySelector("textarea").value})})).json();document.querySelector("#proof-result").textContent=result.path||result.error;};for(const button of document.querySelectorAll('button[data-name]'))button.onclick=async()=>{try{const blob=await(await fetch('/__test/source/'+button.dataset.name)).blob();const reader=new FileReader();reader.onload=()=>{document.querySelector('img').src=reader.result;document.querySelector('[role=status]').textContent='已准备 '+button.dataset.name;};reader.readAsDataURL(blob);}catch(error){document.querySelector('[role=status]').textContent=String(error);}};</script></html>`);return;
    }
    if(path.startsWith('/__test/source/')) {
      const sample=samples.find(value=>path==='/__test/source/'+value.name);if(!sample){response.writeHead(404);response.end();return;}
      response.writeHead(200,{'Content-Type':'image/png','Content-Length':sample.bytes.length});response.end(sample.bytes);return;
    }
    if(path==='/__test/evidence'){json(response,evidence);return;}
    if(path==='/__test/screenshot'&&request.method==='POST') {
      const input=await body(request),bytes=Buffer.from(String(input.jpeg||''),'base64');
      if(bytes.length<4||bytes.length>500000||bytes[0]!==255||bytes[1]!==216)throw Error('Invalid proof screenshot');
      const path=join(root,'upload-success.jpg');await writeFile(path,bytes);json(response,{path});return;
    }
    if(path==='/api/web/v1/auth/login'){
      const input=await body(request);if(!['alice','bob'].includes(input.username)){json(response,{error:'使用 alice 或 bob'},400);return;}
      const token=randomUUID();tokens.set(token,input.username);response.setHeader('Set-Cookie',`fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);json(response,identity(input.username));return;
    }
    const token=request.headers.cookie?.match(/fixture=([^;]+)/)?.[1],owner=tokens.get(token);
    if(path.startsWith('/api/')) {
      if(!owner){json(response,{error:'请登录'},401);return;}
      if(path.endsWith('/auth/me')){json(response,identity(owner));return;}
      if(path.endsWith('/auth/logout')){tokens.delete(token);json(response,{});return;}
      if(request.headers['x-cardbush-user']&&request.headers['x-cardbush-user']!==owner){json(response,{error:'账号已切换'},401);return;}
      let files=agents.get(owner);if(!files){files=new AgentWebFiles(join(root,owner));agents.set(owner,files);}
      if(path.endsWith('/sessions')){json(response,[]);return;}
      if(path.endsWith('/files')&&request.method==='POST') {
        const input=await body(request),value=await files.call({action:'upload',...input});
        if(value.attachment) {
          const stored=value.attachment,publicPath='/data/workspaces/uploads/'+stored.id+'/'+stored.name;
          attachments.set(owner+':'+publicPath,stored);
          const info=await sharp(await readFile(stored.path)).metadata();
          evidence.push({owner,receivedBytes:input.size,storedBytes:(await stat(stored.path)).size,width:info.width,height:info.height,mime:stored.mime,path:publicPath});
          value.attachment={...stored,path:publicPath};
          await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
        }
        json(response,value);return;
      }
      if(path.endsWith('/files/view')) {
        const file=attachments.get(owner+':'+url.searchParams.get('path'));
        if(!file){json(response,{error:'文件不存在'},404);return;}
        const bytes=await readFile(file.path);response.writeHead(200,{'Content-Type':file.mime,'Content-Length':bytes.length,'Cache-Control':'no-store'});response.end(bytes);return;
      }
      json(response,{error:'测试网站不调用模型'},404);return;
    }
    const file=path.startsWith('/assets/')?resolve(staticRoot,'.'+path):join(staticRoot,'index.html');
    if(!file.startsWith(staticRoot+sep)){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html; charset=utf-8'})[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});response.end(await readFile(file));
  } catch(error){json(response,{error:String(error)},400);}
});
server.listen(5209,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:5209',images:'http://127.0.0.1:5209/__test/images',root,samples:samples.map(({name,bytes})=>({name,size:bytes.length}))})));
process.on('SIGINT',()=>{server.closeAllConnections();server.close();});
