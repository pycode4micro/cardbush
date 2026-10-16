import { build } from 'vite';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pdfPreviewAssetsPlugin } from './pdf-preview-assets-plugin.mjs';
const require = createRequire(import.meta.url), local = file => resolve(file).replaceAll('\\', '/');
await mkdir('tmp', { recursive: true }); const directory = await mkdtemp(resolve('tmp/creation-canvas-'));
const fixture = `
import React from 'react';import{createRoot}from'react-dom/client';
import{CreationCanvasApp}from'${local('src/features/creationCanvas/CreationCanvasApp.tsx')}';
import{CanvasSidebar}from'${local('src/features/creationCanvas/CanvasSidebar.tsx')}';
import*as store from'${local('src/features/creationCanvas/canvasStore.ts')}';
import{canvasFileTarget}from'${local('src/features/creationCanvas/canvasModel.ts')}';
import'${local('src/styles/theme.css')}';import'${local('src/styles/app.css')}';
window.cardbushDesktop={...window.testBridge,getPathForFile:()=>''};window.canvasStore=store;window.canvasFileTarget=canvasFileTarget;
if(!localStorage.getItem('fixture-seeded')){localStorage.setItem('fixture-seeded','true');localStorage.setItem('cardbush.bush-it.pages.v1',JSON.stringify({pages:[{id:'legacy',source:'# Legacy note\\n\\nPreserve my writing',updatedAt:1}],selectedId:'legacy'}));}
function Fixture(){return <div className="app theme-dark" style={{height:'100vh',display:'flex'}}><CanvasSidebar language="zh" onBack={()=>{}}/><CreationCanvasApp language="zh"/></div>;}createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const chat = `import React,{useEffect,useRef}from'react';export function CreationConversation(props){const latest=useRef(props);latest.current=props;window.canvasSend=async input=>{const prompt=await latest.current.beforeSend(input);window.lastCanvasPrompt=prompt;latest.current.preparation?.onCreated?.({id:props.sessionId});return true;};useEffect(()=>{props.onInspectorContext?.({sessionId:props.sessionId,root:props.root,messages:[],busy:false,send:input=>window.canvasSend(input)});return()=>props.onInspectorContext?.(null);},[props.sessionId,props.onInspectorContext]);return null;}`;
try {
  await writeFile(join(directory, 'entry.tsx'), fixture);
  await writeFile(join(directory, 'chat.tsx'), chat);
  await writeFile(join(directory, 'index.html'), '<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module" src="./entry.tsx"></script></body></html>');
  await writeFile(join(directory, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testBridge',{creationCanvas:input=>ipcRenderer.invoke('canvas:command',input),ensureTaskWorkspace:id=>ipcRenderer.invoke('canvas:workspace',id),pickAttachments:()=>ipcRenderer.invoke('canvas:pick'),readTextPreview:path=>ipcRenderer.invoke('canvas:text',path),captureInspectorRegion:input=>ipcRenderer.invoke('canvas:capture',input),design:input=>ipcRenderer.invoke('canvas:design',input)});`);
  await writeFile(join(directory, 'sample.md'), '# A real Markdown file\n\nSelect this paragraph for the canvas.\n\nAnother paragraph to preserve.');
  await writeFile(join(directory, 'sample.html'), '<html><body style="background:#eee;color:#111;padding:30px"><h1>HTML file</h1><p id="region">Select a region from this file.</p></body></html>');
  const docx = require('docx'); await writeFile(join(directory, 'sample.docx'), await docx.Packer.toBuffer(new docx.Document({ sections: [{ children: [new docx.Paragraph('Real Word document')] }] })));
  const xlsx = require('styled-exceljs'), book = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['Name', 'Value'], ['Alpha', 42]]), 'Sheet 1'); xlsx.writeFile(book, join(directory, 'sample.xlsx'));
  const slides = new (require('pptxgenjs'))(); slides.addSlide().addText('Real slides', { x: 1, y: 1, w: 6, h: 1 }); await slides.writeFile({ fileName: join(directory, 'sample.pptx') });
  const { PDFDocument } = require('pdf-lib'), pdf = await PDFDocument.create(); pdf.addPage([400, 300]).drawText('Real PDF'); await writeFile(join(directory, 'sample.pdf'), await pdf.save());
  await build({ configFile: false, root: directory, base: './', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'fixture-chat', enforce: 'pre', resolveId(source, importer) { if (importer?.replaceAll('\\','/').endsWith('/creationCanvas/CreationCanvasApp.tsx') && source.endsWith('/CreationConversation')) return join(directory, 'chat.tsx'); } }, pdfPreviewAssetsPlugin()], build: { outDir: join(directory, 'app'), emptyOutDir: true, rolldownOptions: { input: join(directory, 'index.html') } } });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const status = await new Promise((resolveStatus, reject) => { const child = spawn(require('electron'), [resolve('scripts/test-creation-canvas-ui-worker.cjs'), directory], { env, windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', resolveStatus); });
  if (status !== 0) throw Error(`Canvas UI test failed (${status}); fixtures retained at ${directory}`);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} catch (error) { console.error(error); process.exitCode = 1; }
