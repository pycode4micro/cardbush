import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const compiled = ts.transpileModule(await readFile('src/features/shortcuts/conversationNavigation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} }; new Function('exports', compiled)(module.exports);
const { emptyConversationNavigation, visitConversation, pruneConversationNavigation } = module.exports;
let navigation = ['a', 'b', 'c'].reduce(visitConversation, emptyConversationNavigation);
navigation = visitConversation({ ...navigation, index: 1 }, 'b');
assert.deepEqual(navigation.entries, ['a', 'b', 'c'], 'back navigation retains forward history');
assert.equal(navigation.index, 1);
assert.deepEqual(navigation.recent, ['b', 'c', 'a']);
assert.deepEqual(visitConversation(navigation, 'd').entries, ['a', 'b', 'd'], 'new navigation replaces only the forward branch');
navigation = pruneConversationNavigation(navigation, new Set(['b', 'c']));
assert.equal(navigation.index, 0, 'deleting an older chat preserves the current history position');
assert.deepEqual(navigation.entries, ['b', 'c']);
assert.deepEqual(pruneConversationNavigation(navigation, new Set()), emptyConversationNavigation);

const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'window-menu-'));
const local = file => resolve(file).replaceAll('\\', '/');
try {
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {WindowFrame} from '${local('src/components/WindowFrame.tsx')}';
import {applicationMenus} from '${local('src/features/windowMenu/applicationMenus.ts')}';
import {usePreviousConversationShortcut} from '${local('src/features/shortcuts/usePreviousConversationShortcut.ts')}';
import {saveKeyboardShortcuts} from '${local('src/features/shortcuts/useKeyboardShortcuts.ts')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
const ipc=window.require('electron').ipcRenderer;
window.calls=[];window.errors=[];window.saveKeyboardShortcuts=saveKeyboardShortcuts;
window.cardbushDesktop={isMaximized:async()=>false, windowMenuContext:()=>ipc.invoke('window:menu-context'),
  executeWindowMenuAction:(...args)=>ipc.invoke('window:menu-action',...args),openExternal:url=>window.calls.push(url),
  onWindowMenuKeyDown:fn=>{window.nativeKey=fn;return()=>{};},minimize:async()=>{},toggleMaximize:async()=>{},closeToTray:async()=>{}};
function Fixture(){
  const [active,setActive]=React.useState('a'),[conversations,setConversations]=React.useState(['a','b','c'].map(id=>({id}))),
    [theme,setTheme]=React.useState('dark'),[language,setLanguage]=React.useState('zh'),[sidebar,setSidebar]=React.useState(true),
    [preview,setPreview]=React.useState(false),[modal,setModal]=React.useState(false);
  const prepared=React.useMemo(()=>[],[]);
  window.fixture={setTheme,setLanguage,setActive,setConversations,setPreview,setModal};
  const nav=usePreviousConversationShortcut({activeConversationId:active,conversations,preparedConversations:prepared,enabled:!modal,onOpenConversation:setActive});
  const action=id=>()=>window.calls.push(id);
  const toggleSidebar=()=>setSidebar(value=>!value);
  const menus=applicationMenus(language,{newConversation:action('new'),openProject:action('folder'),openFiles:action('files'),
    openSettings:action('settings'),showShortcuts:action('shortcuts'),openDiagnostics:action('diagnostics'),
    openAppCenter:action('app-center'),openPlugins:action('plugins'),openAutomations:action('automations'),
    toggleSidebar,toggleInspector:()=>setPreview(value=>!value),search:action('search'),openBrowser:action('browser'),
    focusBrowserAddress:preview?action('address'):undefined,reloadBrowser:preview?action('reload'):undefined,
    openReview:action('review'),openHistory:action('history'),previousConversation:nav.canGoPrevious?nav.previous:undefined,
    back:nav.canGoBack?nav.goBack:undefined,forward:nav.canGoForward?nav.goForward:undefined},
    {sidebarVisible:sidebar,inspectorVisible:preview,native:true,externalLinks:true});
  return <div className={'app theme-'+theme} style={{height:'100vh'}}><WindowFrame language={language} sidebarCollapsed={!sidebar}
    onToggleSidebar={toggleSidebar} menus={menus} onBack={nav.canGoBack?nav.goBack:undefined} onForward={nav.canGoForward?nav.goForward:undefined}
    onError={error=>window.errors.push(String(error))}/>
    <main style={{padding:40}}><h2>CardBush</h2><div id="active">{active}</div><div id="sidebar">{String(sidebar)}</div>
    {conversations.map(chat=><button key={chat.id} data-chat={chat.id} onClick={()=>setActive(chat.id)}>{chat.id}</button>)}
    <textarea id="editor" defaultValue="keep selected text"/><div id="rich-editor" contentEditable suppressContentEditableWarning>alpha beta gamma</div>
    {modal&&<div role="dialog" aria-modal="true"><input id="modal-input"/></div>}</main></div>;
}createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'window-menu-fixture', resolveId: id => id.endsWith('__window_menu__.tsx') ? '\0window-menu.tsx' : undefined,
    load: id => id === '\0window-menu.tsx' ? source : undefined,
  }], build: { outDir: join(directory, 'ui'), emptyOutDir: true, minify: false, lib: { entry: resolve('__window_menu__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output), entry = outputs.find(value => value.type === 'chunk' && value.isEntry);
  await writeFile(join(directory, 'ui', 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(value => value.type === 'asset' && value.fileName.endsWith('.css')).map(value => `<link rel="stylesheet" href="${value.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-window-menu-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(run.status, 0, String(run.error ?? 'Window menu fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'window-menu-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
