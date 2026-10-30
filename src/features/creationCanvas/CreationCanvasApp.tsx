import { uiText } from '../../i18n';
import { developmentDesktop, emptyCanvas, replaceCanvasContent, type CanvasItem, type CanvasSnapshot, type CreationCanvas, type UserPromptInput } from '@cardbush/bush-protocol';
import { Copy, FilePlus2, FolderDown, LayoutTemplate, MoreHorizontal, Play, Plus, RefreshCw, Scan, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '../../components/TopBar';
import type { CreationChatOptions, CreationInspectorContext } from '../mdPresentation/CreationConversation';
import { takeBushItDocumentRequest, watchBushItDocument } from '../mdPresentation/bushItDocuments';
import { acceptCreationFile, markdownFile, parentDirectory, saveCreationFile } from '../mdPresentation/creationFiles';
import { getBushItPages } from '../mdPresentation/bushItPageStore';
import { creationRequest } from '../mdPresentation/creationConversationContext';
import type { MarkdownSelection } from '../mdPresentation/MarkdownSourceEditor';
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
import { CanvasPresentation } from './CanvasPresentation';
import { canvasErrorMessage } from './canvasErrors';
import { CanvasMarkdownWorkspace } from './CanvasMarkdownWorkspace';
import { useTeamChoices } from '../team/teamWorkspaceStore';
import '../inspector/inspectorWorkspace.css';
import './creationCanvas.css';

const CreationConversation = lazy(() => import('../mdPresentation/CreationConversation').then(module => ({ default: module.CreationConversation })));
const ignoreNavigation = () => {};
type Props = CreationChatOptions & { language: string; inspectorOpen?: boolean; onToggleInspector?: () => void };
export function CreationCanvasApp(props: Props) {
  const library = useCanvases(), entry = library.canvases.find(item => item.id === library.selectedId && !item.archived);
  useEffect(() => {
    const receive = () => { const request = takeBushItDocumentRequest(); if (!request) return; const { source, team } = request; const seed = emptyCanvas(source.match(/^# (.+)$/m)?.[1] || ''); seed.items = [{ id: 'document', title: seed.title, kind: 'markdown', markdown: source, frame: { x: 60, y: 60, width: 1000, height: 800 } }]; const id = createCanvas(seed); updateCanvasEntry(id, { editingId: 'document', team }); };
    receive(); return watchBushItDocument(receive);
  }, []);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); event.stopImmediatePropagation(); if (!document.querySelector('.canvas-presentation[open]')) createCanvas(); } }; window.addEventListener('keydown', listener, true); return () => window.removeEventListener('keydown', listener, true); }, []);
  if (!entry) return <div className="creation-canvas-app"><TopBar title={uiText(props.language)('appCenterModel.create')} language={props.language} inspectorOpen={!!props.inspectorOpen} onToggleInspector={props.onToggleInspector}/><div className="canvas-empty"><button onClick={() => createCanvas()}>{uiText(props.language)('creationCanvasApp.newCanvas')}</button></div></div>;
  return <CanvasSpace key={entry.id} {...props} entry={entry}/>;
}
function CanvasSpace({ entry, language, inspectorOpen, onToggleInspector, composerPortalTarget, externalComposerControls = false, onOpenComposer, onInspectorContext, ...chatOptions }: Props & { entry: ReturnType<typeof useCanvases>['canvases'][number] }) {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot>(), current = useRef(snapshot); current.current = snapshot;
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState('');
  const [chatOpen, setChatOpen] = useState(false), [inputTarget, setInputTarget] = useState<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string>(), [fileView, setFileView] = useState<{ target: string; title: string; region: boolean }>();
  const [chatRegion, setChatRegion] = useState<string>();
  const [editor, setEditor] = useState<{ itemId: string; pageId: string }>();
  const [selection, setSelection] = useState<MarkdownSelection>();
  const [presenting, setPresenting] = useState(false);
  const autoOpened = useRef('');
  const [menu, setMenu] = useState(false), [busy, setBusy] = useState(false), [chat, setChat] = useState<CreationInspectorContext | null>(null);
  const teamChoices = useTeamChoices(menu);
  const alive = useRef(true), saving = useRef(false), operating = useRef(false), readSequence = useRef(0), viewport = useRef({ width: 0, height: 0, zoom: 1 });
  const inspectorCallback = useRef(onInspectorContext); inspectorCallback.current = onInspectorContext;
  const inspect = useCallback((value: CreationInspectorContext | null) => { setChat(value); inspectorCallback.current?.(value); }, []);
  const setViewport = useCallback((value: typeof viewport.current) => { viewport.current = value; }, []);
  const dismiss = useCallback(() => setChatOpen(false), []);
  const localControls = !externalComposerControls && !composerPortalTarget;
  useQuickInputDismiss(chatOpen && localControls, dismiss, true);

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
    if (!snapshot || !revision) throw Error(uiText(language)('creationCanvasApp.canvas_is_not_ready'));
    if (saving.current) throw Error(uiText(language)('creationCanvasApp.savingPleaseRetryShortly'));
    saving.current = true; readSequence.current++; setError('');
    try {
      const result = await window.cardbushDesktop!.creationCanvas({ action: 'save', path: snapshot.path, expectedRevision: revision, document });
      if (!result || !('document' in result)) throw Error(uiText(language)('creationCanvasApp.canvas_save_failed'));
      if (alive.current) { accept(result); updateCanvasEntry(entry.id, { title: result.document.title, updatedAt: Date.now() }); }
    } catch (cause) { if (alive.current) setError(String((cause as Error).message)); throw cause; }
    finally { saving.current = false; }
  };
  const action = async (run: () => Promise<void>) => { if (operating.current) return; operating.current = true; setBusy(true); setError(''); setNotice(''); setMenu(false); try { await run(); } catch (cause) { if (alive.current) setError(String((cause as Error).message)); } finally { operating.current = false; if (alive.current) setBusy(false); } };
  const addPaths = (paths: string[]) => action(async () => {
    if (!paths.length) return; const snapshot = current.current; if (!snapshot) throw Error(uiText(language)('creationCanvasApp.theCanvasIsNotReady'));
    const items = paths.map(source => ({ id: crypto.randomUUID(), title: source.split(/[\\/]/).pop() || source, kind: 'file' as const, source }));
    await commit(placeCanvasItems(snapshot.document, items), snapshot.revision); if (alive.current) setSelectedId(items[0].id);
  });
  const add = async () => { try { const paths = await window.cardbushDesktop?.pickAttachments(); if (alive.current && paths) await addPaths(paths); } catch (cause) { setError(String((cause as Error).message)); } };
  const openDocument = async (item: CanvasItem) => {
    if (item.fixed) throw Error(uiText(language)('creationCanvasApp.thisVersionIsFixedResumeUpdatesBefore'));
    if (editor) await saveCreationFile(editor.pageId);
    const snapshot = current.current; if (!snapshot) return;
    let file;
    if (item.kind === 'markdown') {
      file = await markdownFile({ action: 'create', rootPath: parentDirectory(snapshot.path), path: `document-${crypto.randomUUID().slice(0, 8)}.md`, text: item.markdown });
      if (!file || !alive.current) return;
      const replacement: CanvasItem = { ...replaceCanvasContent(item, { kind: 'file', source: file.path }), title: item.title || uiText(language)('canvasMarkdownWorkspace.untitledDocument') };
      await commit({ ...snapshot.document, items: snapshot.document.items.map(value => value.id === item.id ? replacement : value) }, snapshot.revision);
    } else if (item.kind === 'file') {
      const path = canvasFileTarget(item.source, snapshot.path);
      file = await markdownFile({ action: 'open', rootPath: parentDirectory(path), path });
    }
    if (!file || !alive.current) return;
    setEditor({ itemId: item.id, pageId: acceptCreationFile(file) }); setSelectedId(item.id); setSelection(undefined);
    updateCanvasEntry(entry.id, { editingId: item.id });
  };
  const editDocument = (item: CanvasItem) => action(() => openDocument(item));
  useEffect(() => {
    if (!snapshot || !entry.editingId || editor || autoOpened.current === entry.editingId) return;
    const item = snapshot.document.items.find(item => item.id === entry.editingId);
    autoOpened.current = entry.editingId;
    if (item) void editDocument(item);
  }, [snapshot?.path, entry.editingId]);
  const newDocument = () => action(async () => {
    const snapshot = current.current; if (!snapshot) return;
    const item = { id: crypto.randomUUID(), title: uiText(language)('canvasMarkdownWorkspace.untitledDocument'), kind: 'markdown' as const, markdown: '' };
    const next = placeCanvasItems(snapshot.document, [item]); await commit(next, snapshot.revision);
    await openDocument(next.items.find(value => value.id === item.id)!);
  });
  const startChat = () => { if (externalComposerControls) onOpenComposer?.(); else setChatOpen(true); };
  const discuss = (item: CanvasItem) => { setSelectedId(item.id); setChatRegion(item.id); startChat(); };
  const makeDesktop = () => action(async () => {
    const repository = await window.cardbushDesktop?.creationCanvas({ action: 'repository' });
    if (!repository || !alive.current) return;
    // A new desk never replaces an existing canvas or its conversation.
    createCanvas(developmentDesktop(repository.path, language));
  });
  const version = (item: CanvasItem) => action(async () => {
    const value = current.current; if (!value) return;
    if (saving.current) throw Error(uiText(language)('creationCanvasApp.savingPleaseRetryShortly'));
    saving.current = true; readSequence.current++;
    try {
      const result = await window.cardbushDesktop!.creationCanvas({ action: item.fixed ? 'unfreeze' : 'freeze', path: value.path, expectedRevision: value.revision, itemId: item.id });
      if (result && 'document' in result && alive.current) {
        accept(result); updateCanvasEntry(entry.id, { updatedAt: Date.now() });
        setNotice(item.fixed ? uiText(language)('creationCanvasApp.updatesResumedLayoutPreserved') : uiText(language)('creationCanvasApp.versionFixedAndPreservedDuringFutureUpdates'));
      }
    } finally { saving.current = false; }
  });
  const beforeSend = async (input: UserPromptInput) => {
    const targetId = chatRegion || selectedId;
    if (editor) await saveCreationFile(editor.pageId);
    const page = editor ? getBushItPages().pages.find(page => page.id === editor.pageId) : undefined;
    const prepared = await prepareCanvas(entry.id);
    if (!alive.current) throw Error(uiText(language)('creationCanvasApp.canvas_changed_before_sending'));
    accept(prepared); return canvasRequest(creationRequest(input, page, selection, language), prepared, targetId, viewport.current);
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
    setSelectedId(id); setFileView(undefined); setNotice(uiText(language)('creationCanvasApp.excerptSnapshotAddedWithItsSourceLocation'));
  };
  const extract = (welcome: boolean) => action(async () => {
    if (!current.current) return; const snapshots = await extractCanvasComponents(current.current, selectedId, welcome);
    setNotice((welcome ? uiText(language)('creationCanvasApp.appliedToTheNewChatLayout') : uiText(language)('creationCanvasApp.savedToComponents')) + (snapshots ? uiText(language)('creationCanvasApp.fileContentWasSavedAsAVisible') : ''));
  });
  return <div className="creation-canvas-app" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => {
    if (!event.dataTransfer.files.length) return; event.preventDefault(); const paths = Array.from(event.dataTransfer.files).map(file => window.cardbushDesktop?.getPathForFile(file) || '').filter(Boolean); void addPaths(paths);
  }}>
    <TopBar title={uiText(language)('appCenterModel.create')} language={language} inspectorOpen={!!inspectorOpen} onToggleInspector={onToggleInspector}/>
    <div className="canvas-toolbar"><input aria-label={uiText(language)('creationCanvasApp.canvasName')} key={snapshot?.document.title} defaultValue={snapshot?.document.title || ''} placeholder={uiText(language)('canvasSidebar.untitledCanvas')} maxLength={200} onBlur={event => { const value = event.target.value.trim(); const snapshot = current.current; if (snapshot && value !== snapshot.document.title) void commit({ ...snapshot.document, title: value }).catch(() => {}); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
      {snapshot?.document.desktop && <button disabled={busy || !chat || chat.busy} onClick={() => {
        setChatRegion(undefined); setSelectedId(undefined); startChat();
        // Keep the request editable; submitting later uses the whole desk context.
        chat?.appendDraft(uiText(language)('creationCanvasApp.updateThisDevelopmentDeskFromChangesSince'));
      }}><RefreshCw size={15}/>{uiText(language)('creationCanvasApp.updateDesk')}</button>}
      {!editor && <button className="canvas-present-button" disabled={busy || !snapshot?.document.items.length} onClick={() => { setMenu(false); setPresenting(true); }}><Play/>{uiText(language)('canvasPresentation.start')}</button>}
      <button disabled={busy || !snapshot} onClick={() => void newDocument()}><FilePlus2 size={16}/>{uiText(language)('creationCanvasApp.newDocument')}</button>
      <button disabled={busy || !snapshot} onClick={() => void add()}><Plus size={16}/>{uiText(language)('creationCanvasApp.addFiles')}</button>
      <div className="canvas-menu-wrap"><button aria-label={uiText(language)('creationCanvasApp.moreActions')} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={18}/></button>{menu && <><button className="canvas-menu-dismiss" aria-label={uiText(language)('creationCanvasApp.closeMenu')} onClick={() => setMenu(false)}/><div className="canvas-menu" role="menu">
        <button role="menuitem" disabled={busy} onClick={() => void makeDesktop()}><LayoutTemplate size={16}/>{uiText(language)('creationCanvasApp.cardbushDevelopmentDesk')}</button>
        <label className="canvas-team-choice">{uiText(language)('creationCanvasApp.team')}<select aria-label={uiText(language)('teamGraphWorkspace.workflow')} disabled={busy || !snapshot || teamChoices.loading} value={snapshot?.document.team?.id || ''} onChange={event => {
          const id = event.target.value; void action(async () => { const value = current.current; if (value) await commit({ ...value.document, team: id ? { id } : undefined }, value.revision); });
        }}><option value="">{uiText(language)('creationCanvasApp.letTheAgentArrange')}</option>
          {snapshot?.document.team && !teamChoices.choices.some(choice => choice.id === snapshot.document.team!.id) && <option value={snapshot.document.team.id}>{uiText(language)('creationCanvasApp.workflowUnavailable')}</option>}
          {teamChoices.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select></label>
        {teamChoices.error && <small role="alert">{teamChoices.error}</small>}
        <button role="menuitem" disabled={busy || !snapshot} onClick={() => void action(async () => { const value = current.current!; const result = await window.cardbushDesktop!.creationCanvas({ action: 'export', path: value.path, expectedRevision: value.revision }); if (result) setNotice(`${uiText(language)('creationCanvasApp.savedTo')} ${result.path}`); })}><FolderDown size={16}/>{uiText(language)('creationCanvasApp.saveToFolder')}</button>
        <button role="menuitem" disabled={busy || !selectedId} onClick={() => void extract(false)}><Copy size={16}/>{uiText(language)('creationCanvasApp.extractSelectionAsAComponent')}</button>
        <button role="menuitem" disabled={busy || !snapshot?.document.items.length} onClick={() => void extract(true)}><LayoutTemplate size={16}/>{uiText(language)('creationCanvasApp.useAsNewChatLayout')}</button>
      </div></>}</div>
    </div>
    <div className="canvas-workspace">
      {(error || readError || notice) && <div className={`canvas-notice${error || readError ? ' error' : ''}`} role={error || readError ? 'alert' : 'status'}><span>{error || readError ? canvasErrorMessage(error || readError, language) : notice}</span><button aria-label={uiText(language)('creationCanvasApp.dismiss')} onClick={() => { setError(''); setReadError(''); setNotice(''); }}><X size={13}/></button></div>}
      <div className="canvas-stage-view" hidden={!!editor}><HtmlComponentContext.Provider value={null}>{snapshot ? <CanvasStage snapshot={snapshot} language={language} selectedId={selectedId} onSelect={setSelectedId} onChange={commit} onAdd={() => void add()} onChat={startChat} onDiscuss={discuss} onVersion={item => void version(item)} onDesktop={() => void makeDesktop()} busy={busy} suspended={presenting || !!editor} onViewport={setViewport} onError={setError} onEditMarkdown={item => void editDocument(item)} onOpenFile={(item, region) => { if (item.kind === 'file') { setChatRegion(item.id); setFileView({ target: canvasFileTarget(item.source, snapshot.path), title: item.title, region }); } }}/>
        : <div className="canvas-loading" role="status">{uiText(language)('creationCanvasApp.openingCanvas')}</div>}</HtmlComponentContext.Provider>
      </div>
      {snapshot && editor && <CanvasMarkdownWorkspace snapshot={snapshot} {...editor} language={language} sessionId={entry.sessionId} root={entry.root || ''}
        team={editor.itemId === 'document' ? entry.team : undefined} onTeamSaved={team => updateCanvasEntry(entry.id, { team })} onSelection={setSelection}
        onSelect={id => { const item = current.current?.document.items.find(item => item.id === id); if (item) void editDocument(item); }}
        onBack={() => void action(async () => { await saveCreationFile(editor.pageId); setEditor(undefined); setSelection(undefined); updateCanvasEntry(entry.id, { editingId: undefined }); })}
        onNewFile={path => void addPaths([path])} onKeepDraft={async source => {
          const value = current.current; if (!value) throw Error(uiText(language)('canvasStore.canvas_is_unavailable'));
          await commit(placeCanvasItems(value.document, [{ id: crypto.randomUUID(), kind: 'markdown', title: uiText(language)('creationCanvasApp.retainedDraft'), markdown: source }]), value.revision);
        }}/>}
      {localControls && <InspectorCoverControls language={language} inputOpen={chatOpen} status={chat?.inputStatus} onTargetChange={setInputTarget} onToggleInput={() => setChatOpen(value => !value)}/>}
      {chatRegion && <div className="canvas-chat-region"><span>{uiText(language)('creationCanvasApp.discussing')} · {snapshot?.document.items.find(item => item.id === chatRegion)?.title || uiText(language)('creationCanvasApp.removedRegion')}</span><button aria-label={uiText(language)('creationCanvasApp.clearConversationRegion')} onClick={() => { setChatRegion(undefined); setSelectedId(undefined); }}><X size={13}/></button></div>}
    </div>
    {snapshot && presenting && <CanvasPresentation snapshot={snapshot} language={language} initialId={selectedId} onClose={() => setPresenting(false)}/>}
    {snapshot && <Suspense fallback={null}><CreationConversation key={entry.sessionId} {...chatOptions} sessionId={entry.sessionId} root={entry.root || ''} language={language}
      preparation={!entry.sessionCreated ? { title: `${uiText(language)('appCenterModel.create')} · ${entry.title || uiText(language)('canvasSidebar.untitledCanvas')}`, metadata: { creation_workspace: true, creation_canvas: snapshot.path }, onCreated: () => updateCanvasEntry(entry.id, { sessionCreated: true }) } : undefined}
      visible={chatOpen && localControls} composerPortalTarget={composerPortalTarget ?? (localControls && chatOpen ? inputTarget : null)} onOpen={startChat} beforeSend={beforeSend} contextLabel={entry.title || uiText(language)('canvasMarkdownWorkspace.canvas')} onInspectorContext={inspect}/></Suspense>}
    {fileView && <div className="canvas-file-backdrop" role="dialog" aria-modal="true" aria-label={fileView.title} onKeyDown={event => { if (event.key === 'Escape' && !fileView.region) { event.stopPropagation(); setFileView(undefined); } }}>
      <header><span>{fileView.title}</span><button autoFocus aria-pressed={fileView.region} onClick={() => setFileView({ ...fileView, region: !fileView.region })}><Scan size={16}/>{uiText(language)('creationCanvasApp.selectAnExcerpt')}</button><button aria-label={uiText(language)('creationCanvasApp.closeFile')} onClick={() => setFileView(undefined)}><X size={18}/></button></header>
      <InspectorWebview identity={`source-${fileView.target}`} target={fileView.target} source={inspectorSource(fileView.target)} language={language} onNavigationStateChange={ignoreNavigation} onOpenTarget={detail => openInspector(detail.target, detail.title)} regionEnabled={fileView.region} onRegionSelectionClose={() => setFileView({ ...fileView, region: false })} onRegionReference={reference}
        regionConversation={chat ? { scope: entry.sessionId, busy: chat.busy, error: chat.error, messages: chat.messages, send: chat.send, saveImage: async data => { const result = await window.cardbushDesktop!.creationCanvas({ action: 'image', path: snapshot!.path, data }); if (!result) throw Error(uiText(language)('creationCanvasApp.could_not_save_selection')); return result.path; } } : undefined}/>
    </div>}
  </div>;
}
