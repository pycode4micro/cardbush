import { build } from 'vite';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pdfPreviewAssetsPlugin } from './pdf-preview-assets-plugin.mjs';
const require = createRequire(import.meta.url);
await mkdir('tmp', { recursive: true });
const directory = await mkdtemp(resolve('tmp/inspector-regions-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {InspectorWebview} from '${local('src/features/inspector/InspectorWebview.tsx')}';
import {resolveFilePreview} from '${local('src/features/inspector/filePreviewRegistry.ts')}';
import {queryPreviewRegion} from '${local('src/features/inspector/regionSelection.ts')}';
import {resolvePromptReferenceContext} from '${local('src/backend/promptReferenceContext.ts')}';
import {projectRuntimeSessionMessage} from '${local('src/backend/runtimeSessionMessageProjection.ts')}';
import {splitStreamAttachmentMentions} from '${local('src/shared/chatAttachments.ts')}';
import {RegionConversationContext,usePublishRegionConversation} from '${local('src/features/inspector/RegionConversationContext.tsx')}';
import '${local('src/styles/theme.css')}';import '${local('src/styles/inspector.css')}';
window.queryRegion=queryPreviewRegion;window.prompts=[];window.saved=[];
window.cardbushDesktop={...window.testBridge,saveImageDataUrl:async (...args)=>{window.saved.push(args);return {path:'C:/test/region.png'};}};
const noOp=()=>{};
function Publisher({active,scope}){usePublishRegionConversation({scope,busy:false,messages:[{id:'msg',role:'assistant',content:'hello'}],send:async()=>{window.publisherSentTo=scope;return true;}},active);return null;}
function PublisherTest(){const [value,publish]=React.useState(null),[active,setActive]=React.useState(true),[scope,setScope]=React.useState('agent-a');window.published=value;window.publisherRenderCount=(window.publisherRenderCount||0)+1;window.setPublisherActive=setActive;window.setPublisherScope=setScope;return <RegionConversationContext.Provider value={publish}><Publisher active={active} scope={scope}/></RegionConversationContext.Provider>;}
function Fixture(){const [path,setPath]=React.useState('');window.openPreview=setPath;
 const [enabled,setEnabled]=React.useState(true);window.setEnabled=setEnabled;
 const [scope,setScope]=React.useState('session-a');window.setScope=setScope;
 const [messages,setMessages]=React.useState([]);window.setMessages=setMessages;
 return <div className="app theme-dark" style={{height:'100vh',display:'flex',background:'#202020',color:'#ddd'}}>{path&&<InspectorWebview key={path} identity="fixture" target={path} source={resolveFilePreview(path).source(path)} language="zh" active regionEnabled={enabled}
 onRegionSelectionClose={()=>setEnabled(false)} regionConversation={{scope,messages,busy:false,send:async prompt=>{if(window.rejectSend)return false;const outbound=splitStreamAttachmentMentions(prompt.text);const resolved=await resolvePromptReferenceContext(outbound.userInput,scope,null,'zh',undefined,undefined,undefined,undefined,prompt.context);window.prompts.push({scope,...resolved});const user=projectRuntimeSessionMessage({messageId:'region-user-'+window.prompts.length,turnId:'region-turn-'+window.prompts.length,message:{role:'user',content:resolved.content},metadata:resolved.metadata},scope);window.projectedUser=user;setMessages(current=>[...current,user]);return true;}}} onNavigationStateChange={noOp} onOpenTarget={noOp}/>}</div>;
}createRoot(document.getElementById('root')).render(<><PublisherTest/><Fixture/></>);
`;
try {
  await writeFile(join(directory,'entry.tsx'),source);
  await writeFile(join(directory,'index.html'),'<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
  await writeFile(join(directory,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testBridge',{captureInspectorRegion:input=>ipcRenderer.invoke('region:capture',input),readTextPreview:path=>ipcRenderer.invoke('region:text',path)});`);
  const docs = require('docx');
  await writeFile(join(directory,'sample.docx'), await docs.Packer.toBuffer(new docs.Document({ sections: [{children:[new docs.Paragraph('Quarterly revenue review'),new docs.Paragraph('Change only this paragraph.')]}] })));
  const workbook = require('styled-exceljs').utils.book_new();
  const xlsx = require('styled-exceljs');
  const rows = Array.from({length:150},(_,i)=>['Row '+(i+1),i+100,i+200]);
  xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet(rows),'Revenue');
  xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([['Other sheet',42]]),'Expenses');
  xlsx.writeFile(workbook,join(directory,'sample.xlsx'));
  const ppt = new (require('pptxgenjs'))();
  ppt.addSlide().addText('Quarterly presentation',{x:1,y:1,w:6,h:1});
  ppt.addSlide().addText('Second slide',{x:1,y:1,w:6,h:1});
  await ppt.writeFile({fileName:join(directory,'sample.pptx')});
  const {PDFDocument,StandardFonts}=require('pdf-lib');
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600,800]).drawText('Quarterly PDF review',{x:40,y:700,size:24,font});
  pdf.addPage([800,600]).drawText('Second landscape page',{x:40,y:500,size:24,font});
  await writeFile(join(directory,'sample.pdf'),await pdf.save());
  await writeFile(join(directory,'sample.md'),'# Quarterly Markdown\n\nSelected paragraph to revise.\n\n|Product|Revenue|\n|--|--|\n|Alpha|100|');
  await writeFile(join(directory,'sample.html'),'<html><body style="margin:40px;font:20px sans-serif;background:white"><h1>Quarterly report</h1><p id="target" style="padding:20px;background:#eee">Selected paragraph to revise.</p><p>Keep this content.</p><button id="action" onclick="window.clicked=true">Do not activate</button><div style="height:1000px"></div><p id="bottom">Bottom paragraph</p></body></html>');
  await build({configFile:false,root:directory,base:'./',logLevel:'silent',plugins:[pdfPreviewAssetsPlugin()],define:{'process.env.NODE_ENV':'"production"'},build:{outDir:join(directory,'app'),emptyOutDir:true,rolldownOptions:{input:join(directory,'index.html')}}});
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run=spawnSync(require('electron'),[resolve('scripts/test-inspector-regions-worker.cjs'),directory],{encoding:'utf8',windowsHide:true,timeout:150000,env});
  process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');
  if(run.status!==0) throw Error(`Region UI test failed (${run.status}): ${run.error||''}; fixtures: ${directory}`);
  if (!resolve(directory).startsWith(resolve('tmp') + sep + 'inspector-regions-')) throw Error('Unexpected fixture directory.');
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
} catch(error) { console.error(error);process.exitCode=1; }
