import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import { PluginMarketplaceService, githubSource, extractPluginArchive } from '../dist-electron/pluginMarketplaces.js';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginSkillRoots } from '../dist-electron/productPlugins.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-market-test-'));
const sha = 'a'.repeat(40), newerSha = 'b'.repeat(40);
const native = {name:'native-example',version:'1.0.0',description:'Native fixture',skills:'./skills',mcpServers:{echo:{command:process.execPath,args:['${CODEX_PLUGIN_ROOT}/server.js']}}};
const claude = {name:'claude-example',version:'2.0.0',description:'Claude fixture',author:{name:'Fixture'},skills:['./skill-pack'],mcpServers:'.mcp.json'};
const nativeMarket={name:'native-market',interface:{displayName:'Native market'},plugins:[
 {name:native.name,source:{source:'local',path:'./plugins/native-example'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Tests'},
 {name:'unavailable',source:{source:'local',path:'./plugins/no'},policy:{installation:'NOT_AVAILABLE',authentication:'ON_INSTALL'},category:'Tests'},
 {name:'unsupported-npm',source:{source:'npm',package:'example'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Tests'},
]};
const claudeMarket={name:'claude-market',owner:{name:'Fixture'},plugins:[
 {name:claude.name,source:'./plugins/claude-example',category:'Tests'},
 {name:'hook-example',source:{source:'git-subdir',url:'https://github.com/fixture/claude.git',path:'./plugins/hook-example',sha}},
]};
const archive = new JSZip();
archive.file('fixture/plugins/native-example/.codex-plugin/plugin.json',JSON.stringify(native));
archive.file('fixture/plugins/native-example/skills/greet/SKILL.md','---\nname: greet\ndescription: Say hello\n---\nGreet the user.');
archive.file('fixture/plugins/native-example/server.js','console.log("fixture only");');
archive.file('fixture/plugins/claude-example/.claude-plugin/plugin.json',JSON.stringify(claude));
archive.file('fixture/plugins/claude-example/skill-pack/task/SKILL.md','---\nname: task\ndescription: Perform task\n---\nUse the task reference.');
archive.file('fixture/plugins/claude-example/skills/default-task/SKILL.md','---\nname: default-task\ndescription: Default task\n---\nKeep the default skills alongside custom roots.');
archive.file('fixture/plugins/claude-example/.mcp.json',JSON.stringify({mcpServers:{echo:{command:'node',args:['${CLAUDE_PLUGIN_ROOT}/server.js']}}}));
archive.file('fixture/plugins/claude-example/server.js','console.log("fixture only");');
archive.file('fixture/plugins/hook-example/.claude-plugin/plugin.json',JSON.stringify({name:'hook-example',version:'1.0.0',hooks:{hooks:{Stop:[{hooks:[{type:'prompt',prompt:'Check task'}]}]}}}));
const archiveBytes=await archive.generateAsync({type:'nodebuffer'});
let offline=false, currentSha=sha;
const requests=[];
const fetcher=async input=>{
 const url=String(input);requests.push(url);
 if(offline)throw Error('offline fixture');
 if(url.startsWith('https://api.github.com/'))return Response.json({sha:currentSha});
 if(url.startsWith('https://codeload.github.com/'))return new Response(archiveBytes);
 if(url.includes('/fixture/native/')&&url.endsWith('/.agents/plugins/marketplace.json'))return Response.json(nativeMarket);
 if(url.includes('/fixture/claude/')&&url.endsWith('/.claude-plugin/marketplace.json'))return Response.json(claudeMarket);
 return new Response('',{status:404});
};
const options={dataRoot:join(root,'markets'),userPluginRoot:join(root,'installed'),bundledPluginRoot:resolve('assets/plugins'),fetch:fetcher};
const service=new PluginMarketplaceService(options);
try{
 assert.deepEqual(githubSource('owner/repo@release/test'),{repo:'owner/repo',ref:'release/test'});
 assert.deepEqual(githubSource('https://github.com/owner/repo.git#v1'),{repo:'owner/repo',ref:'v1'});
 assert.throws(()=>githubSource('https://github.com.evil.test/owner/repo'));
 assert.throws(()=>githubSource('https://user:pass@github.com/owner/repo'));
 assert.equal((await service.sources())[0].builtin,true);
 assert.equal(requests.length,0,'listing sources never fetches or installs remote packages');
 const source=await service.addGitHub('fixture/native');
 const catalog=await service.catalog(source.id);
 assert.equal(catalog.displayName,'Native market');
 assert.equal(catalog.entries[0].available,true);
 assert.equal(catalog.entries[1].available,false);
 assert.equal(catalog.entries[2].available,false,'unsupported entry does not break the whole catalog');
 // Transient resets are retried once; persistent raw-host failures use the pinned GitHub Contents API.
 let rawAttempts=0;
 const fallback=new PluginMarketplaceService({...options,dataRoot:join(root,'fallback'),fetch:async input=>{
  const url=String(input);
  if(url.includes('/commits/'))return Response.json({sha});
  if(url.includes('raw.githubusercontent.com')){rawAttempts++;throw Error('net::ERR_CONNECTION_RESET');}
  if(url.includes('/contents/.agents/plugins/marketplace.json?ref='+sha))return Response.json({encoding:'base64',content:Buffer.from(JSON.stringify(nativeMarket)).toString('base64')});
  throw Error('Unexpected fallback request: '+url);
 }});
 const fallbackSource=await fallback.addGitHub('fixture/native');
 assert.equal((await fallback.catalog(fallbackSource.id)).entries.length,3);
 assert.equal(rawAttempts,2,'network retries are bounded');
 assert.deepEqual(await loadProductPluginCatalog([{path:options.userPluginRoot,source:'user'}]),[]);
 const preview=await service.preview(source.id,native.name);
 assert.equal(preview.format,'openai');assert.equal(preview.revision,sha);assert.equal(preview.issues.length,0);
 assert.equal(preview.components.filter(item=>item.kind==='skill').length,1);
 assert.equal(preview.components.filter(item=>item.kind==='mcp').length,1);
 assert.deepEqual(await loadProductPluginCatalog([{path:options.userPluginRoot,source:'user'}]),[],'preview stays outside installed catalog');
 currentSha=newerSha;
 const readsBeforeInstall=requests.length;
 const installed=await service.install(preview.token);
 assert.equal(installed.id,native.name);
 assert.equal(requests.length,readsBeforeInstall,'install uses reviewed snapshot without refetching a moved branch');
 assert.equal(JSON.parse(await readFile(join(options.userPluginRoot,native.name,'.cardbush-marketplace.json'),'utf8')).revision,sha);
 await assert.rejects(service.install(preview.token),/expired/);
 const roots=[{path:options.userPluginRoot,source:'user'}],configPath=join(root,'missing-apps.json');
 assert.equal((await loadEnabledProductPluginSkillRoots(roots,configPath)).length,1);
 const servers=await loadEnabledProductPluginMcpServers(roots,configPath);
 assert.equal(servers[0].transport.args[0],join(options.userPluginRoot,native.name)+'/server.js');
 assert.ok(!servers[0].transport.args[0].includes('preview-'),'MCP path expands to installed root');
 currentSha=sha;
 const other=await service.addGitHub('fixture/claude');
 const claudeCatalog=await service.catalog(other.id);
 assert.equal(claudeCatalog.entries[0].available,true,'Claude catalogs need not declare OpenAI installation policies');
 const adapted=await service.preview(other.id,claude.name);
 assert.equal(adapted.format,'claude');assert.equal(adapted.issues.length,0);
 assert.equal(adapted.components.filter(item=>item.kind==='skill').length,2,'Claude custom skill paths add to the default skills directory');
 await service.install(adapted.token);
 const adaptedManifest=JSON.parse(await readFile(join(options.userPluginRoot,claude.name,'.codex-plugin/plugin.json'),'utf8'));
 assert.equal(adaptedManifest.name,claude.name);
 assert.equal(adaptedManifest.mcpServers.echo.args[0],'${CARDBUSH_PLUGIN_ROOT}/server.js');
 assert.ok(await readFile(join(options.userPluginRoot,claude.name,'.cardbush-imported-skills/task/SKILL.md'),'utf8'));
 assert.equal((await loadEnabledProductPluginSkillRoots(roots,configPath)).length,2);
 const blocked=await service.preview(other.id,'hook-example');
 assert.ok(blocked.issues.some(issue=>issue.code==='extension'&&issue.detail.includes('hooks')));
 await assert.rejects(service.install(blocked.token),/not compatible/);
 assert.ok(!(await readdir(options.userPluginRoot)).includes('hook-example'));
 // Same name from a second source is reviewable but cannot replace the first plugin.
 const conflictSource=await service.addGitHub('fixture/native@v1');
 const conflict=await service.preview(conflictSource.id,native.name);
 assert.ok(conflict.issues.some(issue=>issue.code==='collision'));
 await assert.rejects(service.install(conflict.token),/not compatible/);
 // Persisted catalog remains available offline, clearly marked stale.
 offline=true;
 const restarted=new PluginMarketplaceService(options);
 const cached=await restarted.catalog(source.id,true);
 assert.equal(cached.cached,true);assert.match(cached.error,/offline/);
 assert.equal((await restarted.catalog(source.id)).cached,true,'cached status survives subsequent reads');
 await restarted.remove(source.id);
 assert.ok((await readdir(options.userPluginRoot)).includes(native.name),'removing a market never uninstalls its plugins');
 await assert.rejects(restarted.preview(source.id,native.name),/removed/);
 offline=false;
 // Local marketplaces use the repository root, not .agents/plugins, for relative paths.
 const local=join(root,'local');await mkdir(join(local,'.agents/plugins'),{recursive:true});
 await mkdir(join(local,'plugins/local-example/.codex-plugin'),{recursive:true});
 await writeFile(join(local,'.agents/plugins/marketplace.json'),JSON.stringify({name:'local',plugins:[{name:'local-example',source:'./plugins/local-example',policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}]}));
 await writeFile(join(local,'plugins/local-example/.codex-plugin/plugin.json'),JSON.stringify({name:'local-example',version:'1.0.0',mcpServers:{example:{type:'http',url:'https://example.test/mcp'}}}));
 const localSource=await service.addLocal(local),localPreview=await service.preview(localSource.id,'local-example');
 await service.install(localPreview.token);
 assert.ok((await readdir(options.userPluginRoot)).includes('local-example'));
 // Archive extraction rejects traversal, Windows aliases, symlinks and decompression overflow.
 for(const [name,unixPermissions] of [['../escape.txt',undefined],['CON.txt',undefined],['link',0o120777]]){
  const zip=new JSZip();zip.file('repo/plugin/'+name,'payload',{unixPermissions});
  await assert.rejects(extractPluginArchive(await zip.generateAsync({type:'nodebuffer',platform:'UNIX'}),'plugin',join(root,'unsafe-'+Math.random())));
 }
 const big=new JSZip();big.file('repo/plugin/large',Buffer.alloc(17*1024*1024));
 await assert.rejects(extractPluginArchive(await big.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'plugin',join(root,'oversize')),/size limit/);
 console.log('Plugin marketplaces passed: native and Claude catalogs, pinned acquisition, staged install, Skills/MCP discovery, incompatible components, collisions, offline cache, local paths and archive bounds.');
}finally{
 assert.ok(root.startsWith(parent+sep+'cardbush-market-test-'));
 await rm(root,{recursive:true,force:true,maxRetries:3});
}
