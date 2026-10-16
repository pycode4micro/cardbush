import { emptyCanvas, type CanvasSnapshot, type CreationCanvas, type UserPromptInput } from '@cardbush/bush-protocol';
import { Copy, FolderDown, LayoutTemplate, MoreHorizontal, Plus, Scan, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '../../components/TopBar';
import type { CreationChatOptions, CreationInspectorContext } from '../mdPresentation/CreationConversation';
import { takeBushItDocument, watchBushItDocument } from '../mdPresentation/bushItDocuments';
import { InspectorCoverControls } from '../inspector/InspectorCoverControls';
import { useQuickInputDismiss } from '../inspector/useQuickInputDismiss';
import { InspectorWebview } from '../inspector/InspectorWebview';
import { inspectorSource } from '../inspector/inspectorTargets';
import { openInspector } from '../inspector/inspectorEvents';
import type { PreviewRegion } from '../inspector/regionSelection';
import { HtmlComponentContext } from '../components/HtmlComponentContext';
import { createCanvas, prepareCanvas, updateCanvasEntry, useCanvases } from './canvasStore';
import { canvasFileTarget, canvasRequest, placeCanvasItems } from './canvasModel';
import { extractCanvasComponents } from './canvasComponents';
import { CanvasStage } from './CanvasStage';
import '../inspector/inspectorWorkspace.css';
import './creationCanvas.css';

const CreationConversation = lazy(() => import('../mdPresentation/CreationConversation').then(module => ({ default: module.CreationConversation })));
const ignoreNavigation = () => {};
type Props = CreationChatOptions & { language: 'zh' | 'en'; inspectorOpen?: boolean; onToggleInspector?: () => void };
export function CreationCanvasApp(props: Props) {
  const library = useCanvases(), entry = library.canvases.find(item => item.id === library.selectedId && !item.archived);
  useEffect(() => {
    const receive = () => { const source = takeBushItDocument(); if (source === undefined) return; const seed = emptyCanvas(source.match(/^# (.+)$/m)?.[1] || ''); seed.items = [{ id: 'document', title: seed.title, kind: 'markdown', markdown: source, frame: { x: 60, y: 60, width: 1000, height: 800 } }]; createCanvas(seed); };
    receive(); return watchBushItDocument(receive);
  }, []);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); event.stopImmediatePropagation(); createCanvas(); } }; window.addEventListener('keydown', listener, true); return () => window.removeEventListener('keydown', listener, true); }, []);
  if (!entry) return <div className="creation-canvas-app"><TopBar title={props.language === 'zh' ? '创作' : 'Create'} language={props.language} inspectorOpen={!!props.inspectorOpen} onToggleInspector={props.onToggleInspector}/><div className="canvas-empty"><button onClick={() => createCanvas()}>{props.language === 'zh' ? '新建画板' : 'New canvas'}</button></div></div>;
  return <CanvasSpace key={entry.id} {...props} entry={entry}/>;
}
function CanvasSpace({ entry, language, inspectorOpen, onToggleInspector, composerPortalTarget, externalComposerControls = false, onOpenComposer, onInspectorContext, ...chatOptions }: Props & { entry: ReturnType<typeof useCanvases>['canvases'][number] }) {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot>(), current = useRef(snapshot); current.current = snapshot;
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState('');
  const [chatOpen, setChatOpen] = useState(false), [inputTarget, setInputTarget] = useState<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string>(), [fileView, setFileView] = useState<{ target: string; title: string; region: boolean }>();
  const [menu, setMenu] = useState(false), [busy, setBusy] = useState(false), [chat, setChat] = useState<CreationInspectorContext | null>(null);
  const alive = useRef(true), saving = useRef(false), readSequence = useRef(0), viewport = useRef({ width: 0, height: 0, zoom: 1 });
  const inspectorCallback = useRef(onInspectorContext); inspectorCallback.current = onInspectorContext;
  const inspect = useCallback((value: CreationInspectorContext | null) => { setChat(value); inspectorCallback.current?.(value); }, []);
  const setViewport = useCallback((value: typeof viewport.current) => { viewport.current = value; }, []);
  const dismiss = useCallback(() => setChatOpen(false), []);
  const localControls = !externalComposerControls && !composerPortalTarget;
  useQuickInputDismiss(chatOpen && localControls, dismiss, true);
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const accept = (value: CanvasSnapshot) => {
    current.current = value; setSnapshot(value);
    if (value.document.title !== entry.title) updateCanvasEntry(entry.id, { title: value.document.title });
  };
  const acceptRef = useRef(accept); acceptRef.current = accept;
  useEffect(() => {
    alive.current = true; let reading = false;
    const refresh = async () => {
      if (reading || saving.current || document.hidden) return; reading = true; const ticket = ++readSequence.current;
      try {
        const path = current.current?.path;
        const result = path ? await window.cardbushDesktop!.creationCanvas({ action: 'read', path }) : await prepareCanvas(entry.id);
        if (alive.current && ticket === readSequence.current && !saving.current && result && 'document' in result) {
          if (result.revision !== current.current?.revision || JSON.stringify(result.resources) !== JSON.stringify(current.current?.resources)) acceptRef.current(result);
          setReadError('');
        }
      } catch (cause) { if (alive.current) setReadError(String((cause as Error).message)); }
      finally { reading = false; }
    };
    void refresh(); const interval = setInterval(() => void refresh(), 1200); window.addEventListener('focus', refresh);
    return () => { alive.current = false; clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [entry.id]);
  const commit = async (document: CreationCanvas, revision = current.current?.revision) => {
    const snapshot = current.current;
    if (!snapshot || !revision) throw Error('Canvas is not ready.');
    if (saving.current) throw Error(t('正在保存，请稍后重试。', 'Saving. Please retry shortly.'));
    saving.current = true; readSequence.current++; setError('');
    try {
      const result = await window.cardbushDesktop!.creationCanvas({ action: 'save', path: snapshot.path, expectedRevision: revision, document });
      if (!result || !('document' in result)) throw Error('Canvas save failed.');
      if (alive.current) { accept(result); updateCanvasEntry(entry.id, { title: result.document.title, updatedAt: Date.now() }); }
    } catch (cause) { if (alive.current) setError(String((cause as Error).message)); throw cause; }
    finally { saving.current = false; }
  };
  const action = async (run: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); setMenu(false); try { await run(); } catch (cause) { if (alive.current) setError(String((cause as Error).message)); } finally { if (alive.current) setBusy(false); } };
  const addPaths = (paths: string[]) => action(async () => {
    if (!paths.length) return; const snapshot = current.current; if (!snapshot) throw Error(t('画板尚未准备好。', 'The canvas is not ready.'));
    const items = paths.map(source => ({ id: crypto.randomUUID(), title: source.split(/[\\/]/).pop() || source, kind: 'file' as const, source }));
    await commit(placeCanvasItems(snapshot.document, items), snapshot.revision); if (alive.current) setSelectedId(items[0].id);
  });
  const add = async () => { try { const paths = await window.cardbushDesktop?.pickAttachments(); if (alive.current && paths) await addPaths(paths); } catch (cause) { setError(String((cause as Error).message)); } };
  const startChat = () => { if (externalComposerControls) onOpenComposer?.(); else setChatOpen(true); };
  const beforeSend = async (input: UserPromptInput) => {
    const prepared = await prepareCanvas(entry.id);
    if (!alive.current) throw Error('Canvas changed before sending.');
    accept(prepared); return canvasRequest(input, prepared, selectedId, viewport.current);
  };
  const reference = async (region: PreviewRegion, image: string) => {
    const snapshot = current.current, source = fileView?.target;
    if (!snapshot || !source) return;
    const result = await window.cardbushDesktop!.creationCanvas({ action: 'image', path: snapshot.path, data: image });
    if (!result || !alive.current) return;
    const id = crypto.randomUUID();
    const width = Math.min(640, Math.max(200, region.rect.width)), height = Math.max(60, Math.min(800, width * region.rect.height / region.rect.width));
    await commit(placeCanvasItems(snapshot.document, [{ id, kind: 'file', title: `${fileView.title}${region.page ? ` · ${region.page}` : ''}`, source: result.path,
      reference: { mode: 'snapshot', source, page: region.page, sheet: region.sheet, cells: region.cells?.join(',').slice(0, 200), locator: region.locator.slice(0, 8000), text: region.text.slice(0, 20000), rect: region.pageRect ?? region.documentRect } }], { width, height }), snapshot.revision);
    setSelectedId(id); setFileView(undefined); setNotice(t('已加入选区快照，并保留原文件位置。', 'Excerpt snapshot added with its source location.'));
  };
  const extract = (welcome: boolean) => action(async () => {
    if (!current.current) return; const snapshots = await extractCanvasComponents(current.current, selectedId, welcome);
    setNotice(t(welcome ? '已应用到新会话布局。' : '已保存到组件。', welcome ? 'Applied to the new-chat layout.' : 'Saved to Components.') + (snapshots ? t(' 文件内容以当前可见快照保存。', ' File content was saved as a visible snapshot.') : ''));
  });
  return <div className="creation-canvas-app" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => {
    if (!event.dataTransfer.files.length) return; event.preventDefault(); const paths = Array.from(event.dataTransfer.files).map(file => window.cardbushDesktop?.getPathForFile(file) || '').filter(Boolean); void addPaths(paths);
  }}>
    <TopBar title={t('创作', 'Create')} language={language} inspectorOpen={!!inspectorOpen} onToggleInspector={onToggleInspector}/>
    <div className="canvas-toolbar"><input aria-label={t('画板名称', 'Canvas name')} key={snapshot?.document.title} defaultValue={snapshot?.document.title || ''} placeholder={t('无标题画板', 'Untitled canvas')} maxLength={200} onBlur={event => { const value = event.target.value.trim(); const snapshot = current.current; if (snapshot && value !== snapshot.document.title) void commit({ ...snapshot.document, title: value }).catch(() => {}); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
      <button disabled={busy || !snapshot} onClick={() => void add()}><Plus size={16}/>{t('素材', 'Add files')}</button>
      <div className="canvas-menu-wrap"><button aria-label={t('更多操作', 'More actions')} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={18}/></button>{menu && <><button className="canvas-menu-dismiss" aria-label={t('关闭菜单', 'Close menu')} onClick={() => setMenu(false)}/><div className="canvas-menu" role="menu">
        <button role="menuitem" disabled={busy || !snapshot} onClick={() => void action(async () => { const value = current.current!; const result = await window.cardbushDesktop!.creationCanvas({ action: 'export', path: value.path, expectedRevision: value.revision }); if (result) setNotice(`${t('已保存到', 'Saved to')} ${result.path}`); })}><FolderDown size={16}/>{t('保存到文件夹', 'Save to folder')}</button>
        <button role="menuitem" disabled={busy || !selectedId} onClick={() => void extract(false)}><Copy size={16}/>{t('提取所选内容为组件', 'Extract selection as a component')}</button>
        <button role="menuitem" disabled={busy || !snapshot?.document.items.length} onClick={() => void extract(true)}><LayoutTemplate size={16}/>{t('用作新会话布局', 'Use as new-chat layout')}</button>
      </div></>}</div>
    </div>
    {(error || readError || notice) && <div className={`canvas-notice${error || readError ? ' error' : ''}`} role={error || readError ? 'alert' : 'status'}>{error || readError || notice}<button aria-label={t('关闭提示', 'Dismiss')} onClick={() => { setError(''); setReadError(''); setNotice(''); }}><X size={13}/></button></div>}
    <div className="canvas-workspace">
      <HtmlComponentContext.Provider value={null}>{snapshot ? <CanvasStage snapshot={snapshot} language={language} selectedId={selectedId} onSelect={setSelectedId} onChange={commit} onAdd={() => void add()} onChat={startChat} onViewport={setViewport} onError={setError} onOpenFile={(item, region) => { if (item.kind === 'file') setFileView({ target: canvasFileTarget(item.reference?.source || item.source, snapshot.path), title: item.title, region }); }}/>
        : <div className="canvas-loading" role="status">{t('正在打开画板…', 'Opening canvas…')}</div>}</HtmlComponentContext.Provider>
      {localControls && <InspectorCoverControls language={language} inputOpen={chatOpen} onTargetChange={setInputTarget} onToggleInput={() => setChatOpen(value => !value)}/>}
    </div>
    {snapshot && <Suspense fallback={null}><CreationConversation key={entry.sessionId} {...chatOptions} sessionId={entry.sessionId} root={entry.root || ''} language={language}
      preparation={!entry.sessionCreated ? { title: `${t('创作', 'Create')} · ${entry.title || t('无标题画板', 'Untitled canvas')}`, metadata: { creation_workspace: true, creation_canvas: snapshot.path }, onCreated: () => updateCanvasEntry(entry.id, { sessionCreated: true }) } : undefined}
      visible={chatOpen && localControls} composerPortalTarget={composerPortalTarget ?? (localControls && chatOpen ? inputTarget : null)} onOpen={startChat} beforeSend={beforeSend} contextLabel={entry.title || t('画板', 'Canvas')} onInspectorContext={inspect}/></Suspense>}
    {fileView && <div className="canvas-file-backdrop" role="dialog" aria-modal="true" aria-label={fileView.title} onKeyDown={event => { if (event.key === 'Escape' && !fileView.region) { event.stopPropagation(); setFileView(undefined); } }}>
      <header><span>{fileView.title}</span><button autoFocus aria-pressed={fileView.region} onClick={() => setFileView({ ...fileView, region: !fileView.region })}><Scan size={16}/>{t('引用局部', 'Select an excerpt')}</button><button aria-label={t('关闭文件', 'Close file')} onClick={() => setFileView(undefined)}><X size={18}/></button></header>
      <InspectorWebview identity={`source-${fileView.target}`} target={fileView.target} source={inspectorSource(fileView.target)} language={language} onNavigationStateChange={ignoreNavigation} onOpenTarget={detail => openInspector(detail.target, detail.title)} regionEnabled={fileView.region} onRegionSelectionClose={() => setFileView({ ...fileView, region: false })} onRegionReference={reference}
        regionConversation={chat ? { scope: entry.sessionId, busy: chat.busy, error: chat.error, messages: chat.messages, send: chat.send, saveImage: async data => { const result = await window.cardbushDesktop!.creationCanvas({ action: 'image', path: snapshot!.path, data }); if (!result) throw Error('Could not save selection.'); return result.path; } } : undefined}/>
    </div>}
  </div>;
}
