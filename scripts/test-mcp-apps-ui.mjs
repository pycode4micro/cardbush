import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'mcp-apps-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const html = `<style>body{margin:0;padding:24px;font:14px system-ui;background:#f8f7f4;color:#302e2a}h1{font-size:20px;margin:0 0 8px}.cards{display:flex;gap:12px;margin-top:24px}.cards span{flex:1;height:100px;background:#dedbd0;border-radius:10px}body.dark{background:#22211f;color:#eee9df}body.dark .cards span{background:#383731}</style><h1>Interactive fixture</h1><div id="state">Starting</div><div class="cards"><span></span><span></span><span></span></div><script>
document.body.classList.toggle('dark',window.openai.theme==='dark');
const previousCache=sessionStorage.getItem('fixture');sessionStorage.setItem('fixture',42);sessionStorage.property='value';
const draft=document.createElement('input');draft.id='fixture-input';draft.placeholder='Keep selection';document.body.append(draft);
let seq=0;const pending=new Map();
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*')});
const report=(key,value)=>parent.postMessage({fixtureReport:key,value},'*');
addEventListener('message',async e=>{if(e.source!==parent)return;const d=e.data;const p=pending.get(d.id);if(p){pending.delete(d.id);d.error?p.reject(Error(d.error.message)):p.resolve(d.result)}
if(d.method==='ui/notifications/tool-result'){document.getElementById('state').textContent='Ready';report('result',d.params);}
if(d.method==='ui/notifications/host-context-changed'){document.body.classList.toggle('dark',d.params.theme==='dark');report('theme',d.params.theme);report('hostContext',d.params);}
if(d.fixture==='call'){try{const result=await rpc('tools/call',{name:'save',arguments:{value:42}});report('called',result)}catch(error){report('denied',error.message)}}
if(d.fixture==='legacy'){report('legacy',await window.openai.callTool('save',{value:43}));await window.openai.setWidgetState({page:2});}
if(d.fixture==='overlap'){[rpc('tools/call',{name:'save',arguments:{value:1}}),window.openai.callTool('save',{value:2}),rpc('resources/read',{uri:'ui://fixture/next'})].forEach((request,index)=>request.then(result=>report('overlap'+index,{result}),error=>report('overlap'+index,{error:error.message})));}
if(d.fixture==='message'){await window.openai.sendFollowUpMessage({prompt:'Continue fixture'});report('message',true)}
if(d.fixture==='navigate'){location.href='https://example.invalid/escape'}
if(d.fixture==='blank'){location.href='about:blank'}
if(d.fixture==='broken-image'){const image=new Image();image.src='https://example.invalid/image.png';document.body.append(image)}
if(d.fixture==='broken-resource'){const script=document.createElement('script');script.src='https://example.invalid/widget.js?private=omit#secret';document.body.append(script)}
if(d.fixture==='script-error'){setTimeout(()=>{throw Error('Fixture script could not initialize')},0)}
});
(async()=>{const init=await rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'fixture',version:'1'},appCapabilities:{}});report('initialTheme',init.hostContext.theme);report('sessionStorage',{previous:previousCache,value:sessionStorage.getItem('fixture'),property:sessionStorage.property,length:sessionStorage.length,keys:Object.keys(sessionStorage)});parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');
try{parent.document.body;report('escaped',true)}catch{report('isolated',true)}
try{await fetch('https://example.invalid/blocked');report('networkAllowed',true)}catch{report('networkBlocked',true)}
})();</script>`;
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{MessageBubble}from'${local('src/features/chatMessages/MessageBubble.tsx')}';import '${local('src/styles/theme.css')}';import '${local('src/styles/app.css')}';
window.fixtureReports={};window.operations=[];window.awaiting=null;window.saved=0;window.context=null;
addEventListener('message',e=>{if(e.data?.fixtureReport)fixtureReports[e.data.fixtureReport]=e.data.value});
addEventListener('cardbush:mcp-app-message',e=>{window.followup=e.detail.text;e.detail.resolve()});
window.cardbushDesktop={openExternal:async()=>{},preparePluginUiNetwork:async()=>{operations.push({action:'prepare-network'})}};
const view={token:'opaque-host-token',html:${JSON.stringify(html)},meta:{'openai/widgetPrefersBorder':false},tool:{name:'save',inputSchema:{type:'object'}},input:{original:true},result:{content:[],structuredContent:{value:1},_meta:{uiOnly:true}}};
window.staleOpens=0;window.deferOpen=false;window.extraOutput=false;window.failedResult=false;window.legacyOnly=false;window.mediaOnly=false;window.fixtureImage=null;window.fixtureContent=null;window.fixtureArtifacts=null;window.fixtureAttachments=[];window.memoStatus='available';
// A controllable transport: the worker decides when runtime replies arrive.
// The actual runtime queue and cancellation are tested in mcpAppsHost.test.mjs.
window.overlapMode=false;window.overlapCalls=[];window.overlapAnswers=[];window.overlapPermission=null;window.deferStatus=false;window.releaseStatus=null;
window.fixtureCommand=async input=>{
operations.push(input);
if(input.reference)return{status:memoStatus,memo:{protocol:'bush.file_memo.v1',id:'file_'+'a'.repeat(32),reference:input.reference,file:{path:fixtureImage.path,name:fixtureImage.name,size:10,mtimeMs:1},note:{purpose:'Generated file',points:[]}}};
if(input.action==='describe')return{interfaces:input.toolCallIds.map(id=>({sessionId:'s',turnId:'t',toolCallId:id,source:'mcp__demo__save',resourceUri:'ui://fixture',title:id==='old'?'较早结果':id==='new'?'新增结果':'交互预览',...(failedResult?{resultError:{text:'MCP error -32602: Invalid arguments. Expected doc, document or email; received instagram_post.',truncated:false}}:{})}))};
if(input.action==='observe')return{};
if(input.action==='open'){if(staleOpens>0){staleOpens--;throw Object.assign(Error('The plugin connection changed'),{fact:{code:'mcp_app_connection_changed'}})}const result={...view,token:'opaque-host-token-'+operations.length,...(legacyOnly?{html:'<meta name="color-scheme" content="light"><div style="height:420px">Legacy preview</div><script>window.openai.notifyIntrinsicHeight(420)</script>'}:{})};if(deferOpen)await new Promise(resolve=>window.releaseOpen=resolve);return result;}
if(input.action==='status'){const status={permission:overlapMode?overlapPermission:awaiting?{permissionId:awaiting.permissionId,reason:'Confirm fixture change',targets:[{value:'demo'}],capabilityIds:['write']}:null};if(deferStatus){deferStatus=false;await new Promise(resolve=>window.releaseStatus=resolve);}return status;}
if(overlapMode&&(input.action==='call'||input.action==='resource'))return new Promise((resolve,reject)=>overlapCalls.push({input,resolve,reject}));
if(overlapMode&&input.action==='answer'){overlapAnswers.push(input);overlapPermission=null;return{}};
if(input.action==='call')return new Promise((resolve,reject)=>{awaiting={resolve,reject,token:input.token,permissionId:'p-'+operations.length}});
if(input.action==='answer'){const p=awaiting;awaiting=null;if(input.decision==='deny')p.reject(Error('User denied'));else{saved++;p.resolve({content:[{type:'text',text:'Native saved result'}],structuredContent:null,isError:false,_meta:{saved}})}return{}};
if(input.action==='context'){window.context=input.context;return{}};
if(input.action==='close'){if(awaiting?.token===input.token){awaiting.reject(Error('Closed'));awaiting=null;}return{}};throw Error(input.action)};
const no=async()=>{};
const execution={id:'tool',name:'mcp_call',state:'completed',turnId:'t',summary:'Fixture',output:'Native result',createdAt:'2026-09-10T00:00:00Z',metadata:{}};
const image={id:'image',name:'result.png',path:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',type:'image',display:'inline'};
window.cardbushDesktop.readImageDataUrl=async()=>image.path;
window.cardbushDesktop.inspectPath=async path=>({path,name:'apple.png',kind:'file'});
const file={id:'doc',name:'report.pdf',path:'C:/fixture/report.pdf',type:'document',display:'attachment',size:1234};
// A historical execution: rendering must not require the removed tool to be registered.
const files={...execution,id:'files',name:'present_artifact',artifacts:[image,file]};
const edit={...execution,id:'edit',name:'workspace.write',metadata:{workspaceChanges:[{path:'C:/fixture/style.css',additions:12,deletions:2}]}};
const root=createRoot(document.getElementById('root'));
window.renderFixture=active=>{const executions=mediaOnly?[{...files,artifacts:fixtureArtifacts??[fixtureImage]}]:[{...execution,id:'old'},execution,files,edit,...(extraOutput?[{...execution,id:'new'}]:[])];root.render(<div className="app theme-dark" style={{overflow:'auto'}}><main style={{padding:24,maxWidth:800,margin:'auto'}}><div className={active ? "message-list-item streaming" : "message-list-item"}><MessageBubble message={{id:'message',conversationId:'s',turnId:'t',role:'assistant',content:fixtureContent??(mediaOnly?'图片已生成，预览在上方。点击可查看完整图片。':'界面与文件结果'),attachments:fixtureAttachments,status:active?'streaming':'completed',createdAt:'2026-09-10T00:00:00Z',toolExecutions:active?executions:[],loopHistory:active?[]:[{id:'earlier',role:'assistant',content:'Earlier tool output',createdAt:'2026-09-10T00:00:00Z',toolExecutions:executions}],metadata:{}}} language="zh" sending={active} activeTurnId={active?'t':''} activeAssistantMessageId={active?'message':''} onRegenerate={no} onEditUserMessage={no} onRetryGuidance={no} onRevertChangeReport={no} onOpenScene={no}/></div></main></div>)};
window.clearFixture=()=>root.render(null);window.renderFixture(true);`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'mcp-app-fixture', enforce: 'pre', resolveId(id, importer) { if (id.endsWith('__mcp_app_fixture__.tsx')) return '\0mcp-app-fixture.tsx'; if (id.includes('runtime-client/ElectronRuntimeSession') && /(?:McpAppPanel\.tsx|fileMemo\.ts)$/.test(importer??'')) return '\0runtime-fixture'; },
    load(id) { if (id === '\0mcp-app-fixture.tsx') return source; if (id === '\0runtime-fixture') return 'export function createDesktopRuntimeSession(){return{dispose(){},client:{command:async({payload},decode)=>decode(await window.fixtureCommand(payload))}}}'; },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__mcp_app_fixture__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output), entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item => item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-mcp-apps-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  assert.equal(run.status, 0, String(run.error ?? 'MCP App UI fixture failed'));
} finally { assert.ok(directory.startsWith(parent + sep + 'mcp-apps-ui-')); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
