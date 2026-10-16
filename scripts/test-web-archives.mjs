import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { get } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as pause } from 'node:timers/promises';
import yauzl from 'yauzl';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { WebArtifactArchives } from '../dist-electron/webArtifactArchives.mjs';
import { AgentWebFiles } from '../dist-electron/agentWebFiles.mjs';
import { csrfToken, WebError } from '../dist-electron/webCommon.mjs';

const sessionId = 'web-' + 'a'.repeat(40), chunkSize = 512 * 1024;
const paths = Array.from({length:32}, (_,i)=>`/data/workspaces/generated/image-${i}/成品.png`);
const tokens = {alice:'a'.repeat(54), bob:'b'.repeat(54), renewed:'c'.repeat(54)};
const until = async check => { for(let i=0;i<100;i++){ if(await check())return; await pause(20); } assert.fail('Condition timed out'); };

async function fixture(t, {size=5*1024*1024, latency=1, badChunk=false, nativeFile}={}) {
  const calls = {reads:0,describes:0,active:0,peak:0,get:0}, revoked = new Set();
  const store = {
    authenticate:async token=>revoked.has(token)?null:({[tokens.alice]:{id:'alice'},[tokens.bob]:{id:'bob'},[tokens.renewed]:{id:'alice'}}[token]||null),
    conversation:async(owner,id)=>{ if(id!==sessionId)throw new WebError(404,'不存在'); return {id,owner}; },
    logout:async token=>{revoked.add(token);},
  };
  const agents = {close(){},get:async owner=>{calls.get++;return {call:async(operation,input)=>{
    assert.equal(operation,'web.files');
    const index=paths.indexOf(input.path);
    if(index<0||owner!=='alice')throw Error('Private file not found');
    const file={path:input.path,size,mime:'image/png'};
    if(nativeFile){const result=await nativeFile.reader.call({...input,path:nativeFile.path});return input.action==='describe'?{...result,path:input.path}:result;}
    if(input.action==='describe'){calls.describes++;return file;}
    calls.reads++;calls.active++;calls.peak=Math.max(calls.peak,calls.active);
    try {
      await pause(latency);
      const bytes=Buffer.alloc(Math.min(chunkSize,Math.max(0,size-input.offset)),index);
      return {name:'成品.png',size,mime:file.mime,offset:input.offset,content:bytes.toString('base64'),done:input.offset+bytes.length===size,...(badChunk&&input.offset>0?{size:size+1}:{})};
    } finally {calls.active--;}
  }};}};
  const listener=await serveWeb({origin:'http://test',host:'127.0.0.1',port:0,staticRoot:resolve('dist-web'),modelSecret:'x'.repeat(64),models:[{id:'test'}],defaultModelId:'test'},store,agents);
  t.after(()=>listener.close());
  const base=`http://127.0.0.1:${listener.port}/api/web/v1`;
  const headers=(account='alice')=>({Cookie:'cardbush_web='+tokens[account],Origin:'http://test','X-CSRF-Token':csrfToken(tokens[account]),'Content-Type':'application/json'});
  const request=(path,method='GET',data,account='alice')=>fetch(base+path,{method,headers:headers(account),...(data?{body:JSON.stringify(data)}:{})});
  const prepare=async(selected=paths)=>{const r=await request('/files/archives','POST',{sessionId,paths:selected});assert.equal(r.status,201,await r.clone().text());return await r.json();};
  const status=async ticket=>(await request(`/files/archives/${ticket.id}/status`)).json();
  return {base,headers,request,prepare,status,calls,agents,revoked};
}

async function verifyZip(file, size, count) {
  const zip=await new Promise((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(e,z)=>e?reject(e):resolve(z)));
  const names=[];let index=0;
  await new Promise((resolve,reject)=>{
    zip.on('error',reject);zip.on('end',resolve);zip.on('entry',entry=>{
      void (async()=>{
        names.push(entry.fileName); assert.equal(entry.uncompressedSize,size);assert.equal(entry.compressionMethod,0);
        const stream=await new Promise((r,j)=>zip.openReadStream(entry,(e,s)=>e?j(e):r(s)));
        const hash=createHash('sha256');for await(const chunk of stream)hash.update(chunk);
        assert.equal(hash.digest('hex'),createHash('sha256').update(Buffer.alloc(size,index++)).digest('hex'));zip.readEntry();
      })().catch(reject);
    });zip.readEntry();
  });
  assert.equal(index,count);assert.equal(new Set(names.map(n=>n.toLowerCase())).size,count);assert.ok(names.every(n=>!n.includes('/')));
  const buffer=await readFile(file,{encoding:null});
  assert.notEqual(buffer.indexOf(Buffer.from('504b0606','hex')),-1,'ZIP64 directory present');
}

test('32 images / 160 MiB stream to disk with intact contents and unique Unicode names',async t=>{
  const f=await fixture(t),dir=await mkdtemp(join(tmpdir(),'cb-archive-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const ticket=await f.prepare([...paths,paths[0]]);assert.equal(ticket.total,32);assert.equal(f.calls.reads,0);
  const response=await f.request(`/files/archives/${ticket.id}`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment;/);
  const file=join(dir,'images.zip');await pipeline(Readable.fromWeb(response.body),createWriteStream(file));
  assert.ok((await stat(file)).size>128*1024*1024);await verifyZip(file,5*1024*1024,32);
  await until(async()=>(await f.status(ticket)).state==='completed');assert.equal(f.calls.peak,1);assert.equal(f.calls.reads,320);
  assert.equal((await f.status(ticket)).completed,32);assert.equal((await f.request(`/files/archives/${ticket.id}`)).status,409);
});

test('the native AgentWebFiles read contract streams a real multi-chunk file unchanged',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cb-archive-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'workspaces','generated','one');await mkdir(directory,{recursive:true});
  const path=join(directory,'成品.png'),bytes=Buffer.alloc(chunkSize*3+71,0);await writeFile(path,bytes);
  const f=await fixture(t,{nativeFile:{reader:new AgentWebFiles(root),path}}),ticket=await f.prepare([paths[0]]);
  const response=await f.request(`/files/archives/${ticket.id}`),output=join(root,'native.zip');
  await pipeline(Readable.fromWeb(response.body),createWriteStream(output));await verifyZip(output,bytes.length,1);
  assert.equal((await f.status(ticket)).state,'completed');
});

test('CSRF, account/session ownership, login-bound tickets and path traversal fail before tenant reads',async t=>{
  const f=await fixture(t,{size:10});
  assert.equal((await fetch(f.base+'/files/archives',{method:'POST',headers:{Cookie:'cardbush_web='+tokens.alice,Origin:'http://test','Content-Type':'application/json'},body:JSON.stringify({sessionId,paths})})).status,403);
  for(const path of ['/etc/passwd','/data/workspaces/generated/../private.png','/data/workspaces/generated/a/../b.png','https://example.com/a.png','/data/workspaces/uploads/a.png','/data/workspaces/generated/a\\b.png'])assert.equal((await f.request('/files/archives','POST',{sessionId,paths:[path]})).status,400);
  assert.equal((await f.request('/files/archives','POST',{sessionId:'web-'+'f'.repeat(40),paths})).status,404);assert.equal(f.calls.get,0);
  const ticket=await f.prepare([paths[0]]);
  for(const owner of ['bob','renewed'])for(const suffix of ['','/status'])assert.equal((await f.request(`/files/archives/${ticket.id}${suffix}`,'GET',undefined,owner)).status,404);
  assert.equal(f.calls.reads,0);
});

test('missing files fail during preparation without sending a partial ZIP',async t=>{
  const f=await fixture(t);const response=await f.request('/files/archives','POST',{sessionId,paths:[paths[0],'/data/workspaces/generated/missing.png']});
  assert.equal(response.status,503);assert.match((await response.json()).error,/产物暂时无法读取/);assert.equal(f.calls.reads,0);
  assert.equal((await f.prepare([paths[0]])).total,1);
});

test('slow receivers apply backpressure; cancel stops chunk reads and releases the slot',async t=>{
  const f=await fixture(t),ticket=await f.prepare();
  const response=await new Promise((resolve,reject)=>{const req=get(f.base+`/files/archives/${ticket.id}`,{headers:f.headers()},resolve);req.on('error',reject);});
  response.on('error',()=>{});response.pause();await pause(800);const count=f.calls.reads;
  await pause(300);assert.ok(f.calls.reads-count<=1,`read-ahead did not stop: ${count} -> ${f.calls.reads}`);assert.ok(f.calls.reads<64);
  response.destroy();await until(async()=>(await f.status(ticket)).state==='failed');await until(()=>f.calls.active===0);
  const stopped=f.calls.reads;await pause(100);assert.equal(f.calls.reads,stopped);
  assert.equal((await f.prepare([paths[0]])).total,1);
});

test('midstream file change marks the archive failed instead of returning a truncated success',async t=>{
  const f=await fixture(t,{badChunk:true}),ticket=await f.prepare([paths[0]]);
  const response=await f.request(`/files/archives/${ticket.id}`);
  await assert.rejects(response.arrayBuffer());await until(async()=>(await f.status(ticket)).state==='failed');assert.equal((await f.status(ticket)).completed,0);
});

test('logout aborts an active download and prevents subsequent reads',async t=>{
  const f=await fixture(t,{latency:15}),ticket=await f.prepare();
  const response=await f.request(`/files/archives/${ticket.id}`);const draining=response.arrayBuffer();void draining.catch(()=>{});
  await until(()=>f.calls.reads>=2);assert.equal((await f.request('/auth/logout','POST',{})).status,200);
  await assert.rejects(draining);await until(()=>f.calls.active===0);const stopped=f.calls.reads;await pause(100);assert.equal(f.calls.reads,stopped);
  assert.equal((await f.request(`/files/archives/${ticket.id}/status`)).status,401);
});

test('metadata and archive reads share a two-user bound; queued cancellation and expiry release state',async()=>{
  let active=0,peak=0,now=0;const waits=[];
  const agents={get:async()=>({call:async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>waits.push(resolve));active--;return {path:paths[0],size:1,mime:'image/png'};}})};
  const archives=new WebArtifactArchives(agents,()=>now),abort=new AbortController(),input={sessionId,paths:[paths[0]]};
  const a=archives.prepare('alice','a',input,abort.signal),b=archives.prepare('bob','b',input,abort.signal);
  await until(()=>active===2);
  await assert.rejects(archives.prepare('alice','a',input,abort.signal),error=>error.status===429);
  const cancel=new AbortController(),c=archives.prepare('carol','c',input,cancel.signal);void c.catch(()=>{});cancel.abort();await assert.rejects(c);
  waits.splice(0).forEach(resolve=>resolve());const [first]=await Promise.all([a,b]);assert.equal(peak,2);
  now=300001;assert.throws(()=>archives.get(first.id,'alice','a'),error=>error.status===404);
});
