import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { ImageGalleryScanner } = require('../dist-electron/imageGallery.js');
const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'image-gallery-'));
const project = join(directory, 'project');
const sub = join(project, 'sub');
const external = join(directory, 'external');
const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${color}"/></svg>`;
const files = { first: join(project, '图片 #1.svg'), second: join(sub, '2.svg'), third: join(sub, '3.svg'),
  external: join(external, 'outside.svg'), late: join(project, 'later.svg') };
try {
  await Promise.all([mkdir(sub, { recursive: true }), mkdir(external, { recursive: true }), mkdir(join(project, 'node_modules'), { recursive: true })]);
  for (const [index, file] of Object.values(files).entries()) await writeFile(file, svg(['#438478', '#426689', '#9c722f', '#927190', '#345e79'][index]));
  await writeFile(join(project, 'node_modules', 'ignored.svg'), svg('#000'));
  await writeFile(join(project, 'not-image.txt'), 'text');
  await symlink(external, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const scan = new ImageGalleryScanner();
  const collect = async recursive => {
    let page = await scan.start(1, project, recursive), images = [...page.images];
    while (!page.done) { page = await scan.next(1, page.id); images.push(...page.images); }
    return images.map(image => image.path);
  };
  assert.deepEqual((await collect(false)).sort(), [files.first, files.late].sort(), 'directory scope does not recurse');
  assert.deepEqual((await collect(true)).sort(), [files.first, files.second, files.third, files.late].sort(), 'workspace excludes dependencies and linked directories');
  const large = join(directory, 'large'); await mkdir(large);
  for (let i = 0; i < 260; i++) await writeFile(join(large, `${i}.png`), 'metadata only');
  const first = await scan.start(2, large, true);
  assert.equal(first.done, false); assert.ok(first.images.length <= 128);
  await assert.rejects(scan.next(3, first.id), /closed/, 'scan IDs belong to their window');
  await scan.close(2, first.id);
  await assert.rejects(scan.next(2, first.id), /closed/);
  const competing = await Promise.allSettled([scan.start(5, large, true), scan.start(5, project, false)]);
  assert.equal(competing[0].status, 'rejected', 'late starts cannot replace the latest scope');
  assert.equal(competing[1].status, 'fulfilled');
  await scan.close(5);
  console.log('Image directory scan passed: paging, scope, cancellation, concurrent starts, owner isolation, directory links, dependency exclusion.');

  const local = file => resolve(file).replaceAll('\\', '/');
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ImagePreviewDialog} from '${local('src/features/chatMessages/ImagePreviewDialog.tsx')}';
import {ImageGalleryProvider} from '${local('src/features/chatMessages/ImageGalleryContext.tsx')}';
import {sessionGalleryImages, galleryImage} from '${local('src/features/chatMessages/imageGallery.ts')}';
import {MessageBubble} from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import {ToolImageArtifactViewer} from '${local('src/features/tools/ToolImageArtifactViewer.tsx')}';
import {MediaInspectorPreview} from '${local('src/features/inspector/MediaInspectorPreview.tsx')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
const files=${JSON.stringify(files)}, project=${JSON.stringify(project)};
const ipc=window.require('electron').ipcRenderer;
window.galleryIo={start:0,next:0,close:0,read:0};window.files=files;
window.cardbushDesktop={
  startImageGallery:(...args)=>{window.galleryIo.start++;return ipc.invoke('test:gallery-start',...args)},
  nextImageGallery:id=>{window.galleryIo.next++;return ipc.invoke('test:gallery-next',id)},
  closeImageGallery:id=>{window.galleryIo.close++;return ipc.invoke('test:gallery-close',id)},
  readImageDataUrl:path=>{window.galleryIo.read++;return ipc.invoke('test:read-image',path)},
  inspectLocalReference:async path=>({path,name:path.split(/[\\\\/]/).pop(),kind:'file'}),
};
const artifact={id:'tool-image',type:'image',path:files.third,name:'3.svg'};
const original=[{id:'old',role:'user',content:'',attachments:[{id:'a',type:'image',path:files.first,name:'图片 #1.svg'}]},
 {id:'new',role:'assistant',content:'![第二张](<'+files.second.replaceAll('\\\\','/')+'>)\\n[外部图片](<'+files.external.replaceAll('\\\\','/')+'>)',
 loopHistory:[{id:'loop',role:'assistant',content:'',toolExecutions:[{id:'tool',name:'inject_image_input',state:'completed',summary:'image',output:'',success:true,durationMs:0,createdAt:'2026-09-16T00:00:00Z',contentOffset:0,metadata:{},artifacts:[artifact]}]}]}];
const no=()=>{};
const messageProps={language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:'',onRegenerate:no,onEditUserMessage:no,onRetryGuidance:no,onRevertChangeReport:no,onOpenScene:no};
function Fixture(){const [messages,setMessages]=React.useState(original),[session,setSession]=React.useState('session-a'),[mode,setMode]=React.useState('chat'),[open,setOpen]=React.useState(false),[theme,setTheme]=React.useState('theme-dark');
window.galleryControls={setMessages,setSession,setMode,setOpen,setTheme,original,collect:sessionGalleryImages,galleryImage};
return <div className={'app '+theme}><ImageGalleryProvider sessionId={session} messages={messages} workspaceRoot={project} language="zh">
{mode==='chat'?<><ToolImageArtifactViewer artifacts={[artifact]} language="zh"/><MessageBubble {...messageProps} message={messages[1]}/></>
:mode==='inspector'?<MediaInspectorPreview kind="image" source={galleryImage(files.second).src} path={files.second} language="zh" onLoadingChange={no}/>
:<button id="open-attachments" onClick={()=>setOpen(true)}>附件</button>}
{open&&<ImagePreviewDialog language="zh" image={galleryImage(files.first)} images={[galleryImage(files.first),galleryImage(files.external)]} initialScope="attachments" onClose={()=>setOpen(false)}/>}
</ImageGalleryProvider></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'image-gallery-fixture', resolveId: id => id.endsWith('__image_gallery__.tsx') ? '\0gallery.tsx' : undefined,
    load: id => id === '\0gallery.tsx' ? source : undefined,
  }], build: { outDir: join(directory, 'ui'), minify: false, lib: { entry: resolve('__image_gallery__.tsx'), formats: ['es'] } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(value => value.output);
  const entry = output.find(value => value.type === 'chunk' && value.isEntry);
  await writeFile(join(directory, 'ui', 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${output.filter(value => value.type === 'asset' && value.fileName.endsWith('.css')).map(value => `<link rel="stylesheet" href="${value.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const resultRun = spawnSync(require('electron'), ['scripts/test-image-gallery-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(resultRun.status, 0, String(resultRun.error ?? 'Image gallery UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'image-gallery-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
