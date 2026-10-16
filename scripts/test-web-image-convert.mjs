import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webToolAllowed, webToolDenial } from '../packages/bush-runtime/dist/webToolPolicy.js';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { imageToken } from '../dist-electron/webCommon.mjs';

test('image conversion admission is limited to the personal root, excluding plugin skill files', async t => {
  const root=await mkdtemp(join(tmpdir(),'convert-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const personal=join(root,'alice/workspaces'),plugins=join(root,'alice/plugins'),other=join(root,'bob/workspaces');
  await Promise.all([personal,plugins,other].map(p=>mkdir(p,{recursive:true})));
  for(const p of [personal,plugins,other])await writeFile(join(p,'image.png'),'image fixture');
  const name='mcp__plugin_volcengine_images_images__image_convert';
  const request={metadata:{toolExecutionPolicy:'web_restricted',webReadRoots:[personal,plugins],workspaceDir:personal}};
  const input=path=>({request:{source_path:path,width:800,height:800}});
  assert.equal(webToolAllowed(name),true);assert.equal(webToolAllowed('image_convert'),false);
  assert.equal(await webToolDenial(request,name,input(join(personal,'image.png'))),undefined);
  for(const path of [join(other,'image.png'),join(plugins,'image.png'),'image.png','https://example.test/x.png','/etc/passwd'])assert.ok(await webToolDenial(request,name,input(path)),path);
  const link=join(personal,'redirect');await symlink(other,link,'junction');
  assert.ok(await webToolDenial(request,name,input(join(link,'image.png'))));
  assert.ok(await webToolDenial(request,name,{request:null}));
});

test('local conversion authorization checks current account grants without calling a generation provider', async t => {
  let allowed=true,checks=0;
  const store={imageAllowed:async id=>{checks++;return allowed && id==='alice';}};
  const agents={get(){assert.fail('Authorization should not create an agent');},close(){}};
  const config={origin:'http://test',modelSecret:'m'.repeat(64),host:'127.0.0.1',port:0,staticRoot:resolve('dist-web'),models:[{id:'test'}],defaultModelId:'test'};
  const server=await serveWeb(config,store,agents);t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.port}/internal/image/alice/authorize`;
  const headers={Authorization:'Bearer '+imageToken(config.modelSecret,'alice')};
  const first=await fetch(url,{headers});assert.equal(first.status,200);assert.deepEqual(await first.json(),{allowed:true});
  allowed=false;assert.equal((await fetch(url,{headers})).status,403);allowed=true;
  assert.equal((await fetch(url.replace('/alice/','/bob/'),{headers})).status,401);
  assert.equal((await fetch(url,{headers:{...headers,Origin:'http://test'}})).status,404);
  assert.equal((await fetch(url,{method:'POST',headers})).status,404);
  assert.equal((await fetch(url)).status,401);assert.equal(checks,2);
});

test('stitching validates every input against the personal folder and rejects oversized batches', async t => {
  const root=await mkdtemp(join(tmpdir(),'stitch-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const personal=join(root,'alice/workspaces'),plugins=join(root,'alice/plugins'),other=join(root,'bob/workspaces');
  await Promise.all([personal,plugins,other].map(p=>mkdir(p,{recursive:true})));
  for(const p of [personal,plugins,other])await writeFile(join(p,'image.png'),'fixture');
  const name='mcp__plugin_volcengine_images_images__image_stitch';
  const request={metadata:{toolExecutionPolicy:'web_restricted',webReadRoots:[personal,plugins],workspaceDir:personal}};
  const own=join(personal,'image.png'),input=paths=>({request:{source_paths:paths}});
  assert.equal(webToolAllowed(name),true);assert.equal(webToolAllowed('image_stitch'),false);
  assert.equal(await webToolDenial(request,name,input([own,own])),undefined);
  assert.equal(await webToolDenial(request,name,input(Array(64).fill(own))),undefined);
  for(const paths of [[own,join(other,'image.png')],[own,join(plugins,'image.png')],[own,'image.png'],[own,'https://example.test/x.png'],[own,null],[],[own],Array(65).fill(own)])assert.ok(await webToolDenial(request,name,input(paths)));
  const link=join(personal,'redirect');await symlink(other,link,'junction');
  assert.ok(await webToolDenial(request,name,input([own,join(link,'image.png')])));
  assert.ok(await webToolDenial(request,name,{request:null}));
});
