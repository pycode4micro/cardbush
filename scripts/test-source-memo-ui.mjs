import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const directory = resolve('tmp/source-memo-ui');
await mkdir(directory, { recursive: true });
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {MarkdownContent} from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import {SourceMemoReference} from '${local('src/features/chatMessages/SourceMemoReference.tsx')}';
import {FileMemoScope} from '${local('src/features/chatMessages/FileMemoScope.tsx')}';
import {ImagePreviewDialog} from '${local('src/features/chatMessages/ImagePreviewDialog.tsx')}';
import {InlineAudio,InlineVideo} from '${local('src/features/chatMessages/InlineMedia.tsx')}';
import {LocalFileReferenceLink} from '${local('src/features/chatMessages/LocalFileReferenceLink.tsx')}';
import {MessageToolOutputs} from '${local('src/features/tools/MessageToolOutputs.tsx')}';
import {useConversationFileSource} from '${local('src/features/conversationFileSource.ts')}';
import {ConversationHostContext} from '${local('src/features/conversationHost.ts')}';
import {resolveConversationSource,setConversationSource,adoptDraftConversationSource} from '${local('src/features/settings/conversationSource.ts')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
window.lookups=[]; window.opens=[];
window.sourceSettings={resolveConversationSource,setConversationSource,adoptDraftConversationSource};
window.addEventListener('cardbush:open-inspector',event=>window.opens.push(event.detail.target));
const memo={protocol:'bush.source_memo.v1',reference:'cardbush-source:1-0123456789abcdef',markdown:'[1](cardbush-source:1-0123456789abcdef)',createdAt:new Date().toISOString(),
  explanation:'保留已完成的读取结果，并提供有次数上限的恢复，避免把仅有思考的截断直接判为失败。',
  sources:[{kind:'file',target:'C:/workspace/runtime.ts',label:'runtime.ts',locator:{line:2375},version:{size:42,mtimeMs:1},excerpt:'if (outputTruncated) {\\n  return resumeWithBudget();\\n}'},
    {kind:'url',target:'https://example.org/spec',label:'协议说明'},
    {kind:'file',target:'C:/workspace/archived/removed.ts',label:'removed.ts',excerpt:Array.from({length:60},(_,i)=>'// recorded line '+(i+1)).join('\\n')}]};
const runtime={client:{command:async(command,decode)=>{window.lookups.push(command.kind); if(command.kind==='runtime.resolve_source_memo')return decode({status:'resolved',memo,evidenceStatus:['changed','link','unavailable']});
  if(command.kind==='runtime.resolve_file_memo')return decode({status:'available',memo:{protocol:'bush.file_memo.v1',id:'file_1',reference:'cardbush-memo:2',file:{path:'C:/workspace/report.md',name:'report.md',size:1,mtimeMs:1},note:{purpose:'审查报告',points:[]}}});
  throw Error('Unexpected request '+command.kind);}},dispose(){}};
const host={id:'fixture',environmentId:'test',runtime,plugins:[],pluginCommands:[],openFile:path=>window.opens.push(path),uploadFiles:async()=>[],toolDetails:async()=>[]};
const content='现在会保留读取结果，并在输出截断时有限恢复。[1](cardbush-source:1-0123456789abcdef)\\n\\n[报告](cardbush-memo:2) · [普通网页](https://example.org/ordinary) · [普通文件](C:/workspace/plain.cs)';
const root=createRoot(document.getElementById('root'));
window.show=(theme='dark',language='zh')=>root.render(<div className={'app theme-'+theme} style={{height:'100vh',padding:32}}><ConversationHostContext.Provider value={host}><div className="message-row assistant" style={{marginTop:240,maxWidth:740}}><MarkdownContent content={content} language={language}/></div></ConversationHostContext.Provider></div>);
window.menuRequests=[];window.localLoads=0;
const loadLocal=async()=>{window.localLoads++;return {status:'resolved',memo,evidenceStatus:['changed','link','unavailable']};};
window.showLocal=(theme='dark',language='zh')=>{
  window.cardbushDesktop={showFileContextMenu:async(path,options)=>{window.menuRequests.push({path,options});return '';}};
  root.render(<div className={'app theme-'+theme} style={{height:'100vh',padding:32}}><div style={{marginTop:240,marginLeft:310}}><SourceMemoReference reference={memo.reference} language={language} load={loadLocal}/></div></div>);
};
const regressionReference='cardbush-source:13-74679519b39c20e4';
const regressionMemo={...memo,reference:regressionReference,markdown:'[13]('+regressionReference+')'};
window.resourceReads=[];window.referenceLookups=[];
const resolveRegression=command=>{
  window.referenceLookups.push(command.kind);
  if(command.kind==='runtime.resolve_source_memo')return {status:'resolved',memo:regressionMemo,evidenceStatus:['changed','link','unavailable']};
  if(command.kind==='runtime.resolve_file_memo')return {status:'available',memo:{protocol:'bush.file_memo.v1',id:'file_9',reference:'cardbush-memo:9',file:{path:regressionReference+'.png',name:'bad.png',size:1,mtimeMs:1},note:{purpose:'Invalid stored path',points:[]}}};
  throw Error('Unexpected request '+command.kind);
};
const rejectRead=async(path)=>{window.resourceReads.push(path);throw Error('Unexpected file read '+path);};
const regressionHost={...host,id:'resource-regression',runtime:{client:{command:async(command,decode)=>decode(resolveRegression(command))},dispose(){}},readFile:rejectRead,previewFile:rejectRead};
function ResourceProbe({path}){const file=useConversationFileSource(path);return <output data-probe={path} data-source={file.source} data-error={Boolean(file.error)}/>;}
const invalidTargets=[regressionReference,'unknown:photo.png','unknown:voice.mp3','unknown:clip.mp4','unknown:report.pdf'];
window.showResourceRegression=(remote=false)=>{
  window.cardbushDesktop={readImageDataUrl:rejectRead,inspectLocalReference:rejectRead,runtime:{
    command:async request=>({protocol:request.protocol,type:'command_response',operationId:request.operationId,ok:true,result:resolveRegression(request.command)}),
    onStreamFrame:()=>()=>{},cancelOperation:async()=>{},stopStream:async()=>{},
  }};
  root.render(<div key={String(remote)} className="app theme-dark" style={{padding:24}}><ConversationHostContext.Provider value={remote?regressionHost:null}>
    <MarkdownContent language="zh" content={'[13]('+regressionReference+')\\n\\n![鹈鹕骑车]('+regressionReference+')\\n\\n![无效来源](cardbush-source:invalid)\\n\\n![无效媒体](unknown:voice.mp3)\\n\\n![错误文件](cardbush-memo:9)'}/>
    <MessageToolOutputs language="zh" artifacts={['image','audio','video','file'].map(type=>({id:type,name:type,path:regressionReference,type}))}/>
    <InlineAudio src="unknown:voice.mp3"/><InlineVideo src="unknown:clip.mp4"/>
    <LocalFileReferenceLink path={regressionReference}>Invalid file</LocalFileReferenceLink>
    {invalidTargets.map(path=><ResourceProbe key={path} path={path}/>)}
  </ConversationHostContext.Provider></div>);
};
window.showInvalidImageDialog=()=>root.render(<div className="app theme-dark"><ImagePreviewDialog image={{src:regressionReference,path:regressionReference,name:'Invalid image'}} language="en" onClose={()=>{}}/></div>);
const shorthandReference='cardbush-source:21-57a1734f57d1ab1a';
const shorthandMemo={...memo,reference:shorthandReference,markdown:'[21]('+shorthandReference+')'};
window.shorthandLookups=[];
const shorthandRuntime={client:{command:async(command,decode)=>{
  window.shorthandLookups.push(command);
  if(command.kind==='runtime.resolve_source_references')return decode(command.payload.sessionId==='short-session'&&command.payload.turnId==='short-turn'
    ? command.payload.numbers.filter(number=>number===21).map(number=>({number,reference:shorthandReference})):[]);
  if(command.kind==='runtime.resolve_source_memo')return decode({status:'resolved',memo:shorthandMemo,evidenceStatus:['changed','link','unavailable']});
  throw Error('Unexpected shorthand request '+command.kind);
}},dispose(){}};
const shorthandHost={...host,id:'shorthand-host',runtime:shorthandRuntime};
const shorthandContent='**插件到位了。**\\n\\n- 已确认工具契约。[21]\\n- 服务等待激活。[21]\\n- 未知编号。[99]\\n\\n查看 https://example.org/path，再看说明。\\n\\n代码：'+String.fromCharCode(96)+'[21]'+String.fromCharCode(96)+'；数组 arr[21]。\\n\\n转义：'+String.fromCharCode(92)+'[21]\\n\\n[网页标签 [21]](https://example.org/keep)\\n\\n'+String.fromCharCode(96).repeat(3)+'text\\n[21]\\n'+String.fromCharCode(96).repeat(3);
window.showShorthand=(remote=false,sessionId='short-session',turnId='short-turn',allowed=true)=>{
  window.cardbushDesktop={runtime:{command:async request=>({protocol:request.protocol,type:'command_response',operationId:request.operationId,ok:true,
    result:await shorthandRuntime.client.command(request.command,value=>value)}),onStreamFrame:()=>()=>{},cancelOperation:async()=>{},stopStream:async()=>{}}};
  root.render(<div className="app theme-dark" style={{padding:30}}><ConversationHostContext.Provider value={remote?shorthandHost:null}>
    <FileMemoScope sessionId={sessionId} turnId={turnId} sourceReferences={allowed}><MarkdownContent content={shorthandContent} language="zh"/></FileMemoScope>
  </ConversationHostContext.Provider></div>);
};
const scopedReferences={a:'cardbush-source:v2:1:401-1111111111111111',b:'cardbush-source:v2:1:402-2222222222222222'};
const scopedMemos=Object.fromEntries(Object.entries(scopedReferences).map(([session,reference])=>[reference,{...memo,reference,markdown:'[1]('+reference+')',explanation:'会话 '+session+' 的独立备注',sources:[]}]));
window.scopedLookups=[];
const scopedRuntime={client:{command:async(command,decode)=>{
  window.scopedLookups.push(command);
  if(command.kind==='runtime.resolve_source_references'){
    const reference=scopedReferences[command.payload.sessionId];
    return decode(reference&&command.payload.numbers.includes(1)?[{number:1,reference}]:[]);
  }
  if(command.kind==='runtime.resolve_source_memo')return decode({status:'resolved',memo:scopedMemos[command.payload.reference],evidenceStatus:[]});
  throw Error('Unexpected scoped reference request '+command.kind);
}},dispose(){}};
const scopedHost={...host,id:'scoped-reference-host',runtime:scopedRuntime};
window.showScoped=session=>root.render(<div className="app theme-dark" style={{padding:30}}><ConversationHostContext.Provider value={scopedHost}>
  <FileMemoScope sessionId={session} turnId="same-turn" sourceReferences={true}><MarkdownContent language="zh"
    content={'当前会话：[1]'+String.fromCharCode(10,10)+'复制来的引用：[1]('+scopedReferences[session==='a'?'b':'a']+')'}/></FileMemoScope>
</ConversationHostContext.Provider></div>);
window.show();
`;
const result = await build({ configFile:false,logLevel:'warn',esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'source-fixture',resolveId(id){if(id.endsWith('__source_fixture__.tsx'))return '\0source-fixture.tsx';},load(id){if(id==='\0source-fixture.tsx')return source;}}],build:{outDir:directory,emptyOutDir:false,minify:false,lib:{entry:resolve('__source_fixture__.tsx'),formats:['es'],fileName:()=> 'fixture.js'}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`);
const require=createRequire(import.meta.url),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const run=spawnSync(require('electron'),['scripts/test-source-memo-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:60000});
assert.equal(run.status,0,String(run.error??'Source UI failed'));
