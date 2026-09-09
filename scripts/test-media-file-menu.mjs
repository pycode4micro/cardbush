import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'media-file-menu-'));
const local = file => resolve(file).replaceAll('\\', '/');
const files = { image: join(directory, '海报 #1.png'), video: join(directory, 'turntable.webm'), audio: join(directory, 'audio.wav'), document: join(directory, '交付.txt') };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
try {
  await writeFile(files.image, Buffer.from(png, 'base64'));
  await copyFile('scripts/fixtures/inspector-media.webm', files.video);
  await writeFile(files.audio, Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex'));
  await writeFile(files.document, 'delivery');
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {MessageBubble} from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import {ImagePreviewDialog} from '${local('src/features/chatMessages/ImagePreviewDialog.tsx')}';
import {MediaInspectorPreview} from '${local('src/features/inspector/MediaInspectorPreview.tsx')}';
import {fileUrl} from '${local('src/shared/localPaths.ts')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
window.files=${JSON.stringify(files)}; const ipc=window.require('electron').ipcRenderer;
window.cardbushDesktop={showFileContextMenu:(...args)=>ipc.invoke('shell:file-context-menu',...args),showErrorDialog:args=>ipc.invoke('test:error',args),inspectLocalReference:async path=>({path,name:'海报 #1.png',kind:'file'})};
const no=async()=>{}; const props={language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:'',onRegenerate:no,onEditUserMessage:no,onRetryGuidance:no,onRevertChangeReport:no,onOpenScene:no};
function Fixture(){const [mode,setMode]=React.useState('chat');window.setMode=setMode;return <div className="app theme-dark" style={{padding:24,height:'100vh',overflow:'auto'}}>
{mode==='chat'?<><MessageBubble {...props} message={{id:'answer',role:'assistant',content:['视频说明',files.video,'海报说明',files.image,'音频说明',files.audio,'结束说明'].join('\\n')}}/><MessageBubble {...props} message={{id:'user',role:'user',content:'文档',attachments:[{id:'doc',type:'document',path:files.document,name:'交付.txt',size:8}]}}/></>
:mode==='remote'?<ImagePreviewDialog image={{src:'data:image/png;base64,${png}',name:'embedded.png'}} language="zh" onClose={()=>setMode('chat')}/>
:<MediaInspectorPreview kind="image" source={fileUrl(files.image)} path={files.image} language="zh" onLoadingChange={no}/>}</div>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'media-file-menu-fixture', resolveId: id => id.endsWith('__media_file_menu__.tsx') ? '\0media-menu.tsx' : undefined,
    load: id => id === '\0media-menu.tsx' ? source : undefined,
  }], build: { outDir: join(directory, 'ui'), emptyOutDir: true, minify: false, lib: { entry: resolve('__media_file_menu__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output), entry = outputs.find(value => value.type === 'chunk' && value.isEntry);
  await writeFile(join(directory, 'ui', 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(value => value.type === 'asset' && value.fileName.endsWith('.css')).map(value => `<link rel="stylesheet" href="${value.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const resultRun = spawnSync(require('electron'), ['scripts/test-media-file-menu-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  assert.equal(resultRun.status, 0, String(resultRun.error ?? 'Media menu fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'media-file-menu-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
