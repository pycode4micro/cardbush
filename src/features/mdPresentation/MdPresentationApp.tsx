import { uiText } from '../../i18n';
import type { UserPromptInput } from '@cardbush/bush-protocol';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Plus, Play, RefreshCw, Save, UsersRound } from 'lucide-react';
import { TopBar } from '../../components/TopBar';
import { TEAM_WORKFLOW_COMMAND, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import { useMarkdownFile } from './useMarkdownFile';
import { parseMarkdownGraph } from './markdownGraph';
import { takeBushItDocument, watchBushItDocument } from './bushItDocuments';
import { bushItPageName, createBushItPage, creationSessionScope, getBushItPages, prepareCreationSession, selectBushItPage, setCreationSession, updateBushItPage, useBushItPages, type BushItPage } from './bushItPageStore';
import { conversationWorkspaceRoot } from '../conversationWorkspace';
import { acceptCreationFile, creationFileRoot, fileName, linkedMarkdownTarget, markdownFile, refreshCreationFile, sameFile, saveCreationFile } from './creationFiles';
import type { MarkdownAnchorRequest } from './MdPresentation';
import type { CreationChatOptions } from './CreationConversation';
import { creationRequest } from './creationConversationContext';
import { useCreationLiveEdit } from './useCreationLiveEdit';
import type { MarkdownSelection } from './MarkdownSourceEditor';
import { InspectorCoverControls } from '../inspector/InspectorCoverControls';
import { useQuickInputDismiss } from '../inspector/useQuickInputDismiss';
import '../inspector/inspectorWorkspace.css';
import { TeamDocumentEditor } from '../team/TeamDocumentEditor';
import { documentTeam, enableDocumentTeam, teamFromMarkdown, teamToMarkdown } from '../team/teamMarkdown';
import { refreshTeamWorkspace, selectTeam, teamCommand, useTeamWorkspace } from '../team/teamWorkspaceStore';
const CreationConversation = lazy(() => import('./CreationConversation').then(module => ({ default: module.CreationConversation })));

type BushItAppProps = CreationChatOptions & { language: string; onPractice?: (team: TeamWorkflow) => void; inspectorOpen?: boolean; onToggleInspector?: () => void };
export function MdPresentationApp({ language, onPractice, inspectorOpen, onToggleInspector, composerPortalTarget, externalComposerControls = false, onOpenComposer, ...chatOptions }: BushItAppProps) {
  const state = useBushItPages(), current = useRef(state); current.current = state;
  const [chatOpen, setChatOpen] = useState(false), [error, setError] = useState('');
  const [selection, setSelection] = useState<{ id: string; value: MarkdownSelection }>();
  const [anchorRequest, setAnchorRequest] = useState<MarkdownAnchorRequest & { pageId: string }>();
  const linkSequence = useRef(0);
  const [inputTarget, setInputTarget] = useState<HTMLDivElement | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const dismissInput = useCallback(() => setChatOpen(false), []);
  const localControls = !externalComposerControls && !composerPortalTarget;
  useQuickInputDismiss(chatOpen && localControls, dismissInput, true);
  useEffect(() => {
    const create = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault(); event.stopImmediatePropagation(); createBushItPage();
      }
    };
    window.addEventListener('keydown', create, true);
    return () => window.removeEventListener('keydown', create, true);
  }, []);
  useEffect(() => {
    const receive = () => { const source = takeBushItDocument(); if (source === undefined) return;
      const existing = current.current.pages.find(page => !page.archived && page.source === source);
      if (existing) selectBushItPage(existing.id); else createBushItPage(source);
    };
    receive(); return watchBushItDocument(receive);
  }, []);
  const page = state.pages.find(item => item.id === state.selectedId && !item.archived && (item.projectDir || '') === state.projectDir);
  useEffect(() => setSelection(undefined), [page?.id]);
  const root = state.projectDir || page?.conversationRoot || (page ? creationFileRoot(page) : '');
  const scope = creationSessionScope(state.projectDir, page), sessionId = state.sessions[state.projectDir || page?.conversationRoot || ''] || state.sessionDrafts[scope];
  const chatScope = state.projectDir || page?.id;
  useEffect(dismissInput, [chatScope, dismissInput]);

  const startChat = () => {
    setChatOpen(true);
    if (sessionId) return;
    const writingPage = page ?? (!state.projectDir ? (() => { const id = createBushItPage(); return getBushItPages().pages.find(item => item.id === id); })() : undefined);
    prepareCreationSession(creationSessionScope(state.projectDir, writingPage));
  };
  const startChatRef = useRef(startChat); startChatRef.current = startChat;
  useEffect(() => {
    if (composerPortalTarget && !sessionId) void startChatRef.current();
  }, [composerPortalTarget, sessionId]);
  const beforeSend = async (text: UserPromptInput) => {
    const captured = page, selected = selection && selection.id === page?.id ? selection.value : undefined;
    if (captured?.unloaded) await refreshCreationFile(captured.id);
    if (captured && !captured.file) {
      const directory = state.projectDir || captured.conversationRoot || await window.cardbushDesktop?.ensureTaskWorkspace(sessionId);
      if (!directory) throw Error(uiText(language)('mdPresentationApp.couldNotPrepareTheWorkspacePleaseRetry'));
      const file = await markdownFile({ action: 'create', rootPath: directory, path: `document-${captured.id.slice(0, 8)}.md`, text: getBushItPages().pages.find(item => item.id === captured.id)?.source || '' });
      if (!file) throw Error(uiText(language)('mdPresentationApp.couldNotPrepareTheDocumentPleaseRetry'));
      updateBushItPage(captured.id, { file, temporary: true, ...(!captured.projectDir ? { conversationRoot: directory } : {}) });
    }
    if (captured?.file) await saveCreationFile(captured.id);
    const saved = getBushItPages().pages.find(item => item.id === captured?.id);
    return creationRequest(text, saved, selected, language);
  };
  return <div className="creation-app" aria-label={uiText(language)('appCenterModel.create')} data-chat-open={chatOpen && !!sessionId}>
    <TopBar title={page ? bushItPageName(page, language) : uiText(language)('appCenterModel.create')} language={language} inspectorOpen={!!inspectorOpen} onToggleInspector={onToggleInspector}
      workspaceControl={<div className="creation-top-actions"><button type="button" className="icon-only" aria-label={uiText(language)('mdPresentationApp.newUntitledDocument')} onClick={() => createBushItPage()}><Plus size={16}/></button></div>}/>
    <div className="creation-workspace">
    <div className="md-app bush-pages-app creation-editor" ref={editor} tabIndex={-1} onClickCapture={event => {
      const anchor = (event.target as Element).closest('a[href]'), href = anchor?.getAttribute('href');
      const target = page?.file && href ? linkedMarkdownTarget(page.file.path, href) : undefined;
      if (!target || !page || !editor.current?.contains(anchor) || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const ticket = ++linkSequence.current;
      if (sameFile(page.file!.path, target.path)) {
        setAnchorRequest({ pageId: page.id, id: crypto.randomUUID(), fragment: target.fragment ?? '#' }); setError(''); return;
      }
      void markdownFile({ action: 'open', rootPath: creationFileRoot(page), path: target.path }).then(file => {
        if (!file || ticket !== linkSequence.current || current.current.selectedId !== page.id) return;
        const pageId = acceptCreationFile(file, state.projectDir);
        setAnchorRequest(target.fragment === undefined ? undefined : { pageId, id: crypto.randomUUID(), fragment: target.fragment }); setError('');
      }).catch(error => { if (ticket === linkSequence.current && current.current.selectedId === page.id) setError(String(error.message)); });
    }}>
    {(state.error || error) && <p role="alert" className="md-error">{state.error || error}</p>}
    {page ? <BushItDocumentPage key={page.id} page={page} language={language} onPractice={onPractice} sessionId={sessionId} root={root}
      anchorRequest={anchorRequest?.pageId === page.id ? anchorRequest : undefined}
      onSourceSelection={value => setSelection(current => current?.id === page.id && current.value.source === value.source && current.value.startLine === value.startLine && current.value.endLine === value.endLine ? current : { id: page.id, value })}/>
      : <div className="creation-empty"><FolderOpen size={28}/><h2>{uiText(language)('mdPresentationApp.startWriting')}</h2><p>{uiText(language)('mdPresentationApp.selectOrCreateAMarkdownFileOn')}</p></div>}
    </div>
    {localControls && <InspectorCoverControls language={language} inputOpen={chatOpen} onTargetChange={setInputTarget}
      onToggleInput={() => { if (chatOpen) dismissInput(); else void startChat(); }}/>}
    </div>
    {sessionId && <Suspense fallback={null}><CreationConversation key={sessionId} {...chatOptions} sessionId={sessionId} root={root} language={language}
      preparation={state.sessionDrafts[scope] === sessionId ? { title: `${uiText(language)('appCenterModel.create')} · ${page ? bushItPageName(page, language) : fileName(state.projectDir)}`,
        projectDir: state.projectDir || undefined, metadata: { creation_workspace: true }, onCreated: conversation => {
          const directory = conversationWorkspaceRoot(conversation);
          if (page && !page.projectDir) updateBushItPage(page.id, { conversationRoot: directory });
          setCreationSession(state.projectDir || directory, conversation.id);
        } } : undefined}
      visible={chatOpen && localControls} composerPortalTarget={composerPortalTarget ?? (localControls && chatOpen ? inputTarget : null)}
      onOpen={() => { if (externalComposerControls) onOpenComposer?.(); else setChatOpen(true); }} beforeSend={beforeSend}
      contextLabel={page?.file ? `${page.temporary ? bushItPageName(page, language) : fileName(page.file.path)}${selection?.id === page.id && selection.value.source === page.source ? ` · Ln ${selection.value.startLine}–${selection.value.endLine}` : ''}` : ''}/></Suspense>}
  </div>;
}

export function BushItDocumentPage({ page, language, onPractice, onSourceSelection, sessionId, root, anchorRequest, embedded = false, initialTeam, onTeamSaved, onNewFile, onKeepDraft, onOpenTeam }: BushItAppProps & {
  page: BushItPage; onSourceSelection: (selection: MarkdownSelection) => void; sessionId?: string; root: string; anchorRequest?: MarkdownAnchorRequest;
  embedded?: boolean; initialTeam?: { id: string; revision: number }; onTeamSaved?: (team: { id: string; revision: number }) => void; onNewFile?: (path: string) => void;
  onKeepDraft?: (source: string) => Promise<void>;
  onOpenTeam?: (id: string) => void;
}) {
  const source = page.source, setSource = (value: string) => updateBushItPage(page.id, { source: value });
  const live = useCreationLiveEdit(page, sessionId, root);
  const [teamError, setTeamError] = useState(''), [teamBusy, setTeamBusy] = useState(false);
  const [registered, setRegistered] = useState<{ id: string; revision: number; source: string } | undefined>(() => initialTeam ? { ...initialTeam, source: '' } : undefined);
  const [fileError, setFileError] = useState(''), [readError, setReadError] = useState(''), [saving, setSaving] = useState(false);
  const document = useMemo(() => { try { return parseMarkdownGraph(source); } catch { return undefined; } }, [source]);
  const config = document && documentTeam(document), teamId = String(config?.id || '');
  const state = useTeamWorkspace(Boolean(config)), files = useMarkdownFile();
  useEffect(() => { if (page.file) files.accept(page.file); }, [page.file]);
  useEffect(() => {
    if (!page.file) return;
    let active = true, reading = false;
    const refresh = async () => { if (reading || documentHidden()) return; reading = true; try { await refreshCreationFile(page.id); if (active) setReadError(''); } catch (error) { if (active) setReadError(String((error as Error).message)); } finally { reading = false; } };
    void refresh(); const timer = setInterval(() => void refresh(), 1200); window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [page.id, page.file?.path]);
  useEffect(() => {
    if (!page.file || page.source === page.file.text || page.externalFile) return;
    const timer = setTimeout(() => { setSaving(true); void saveCreationFile(page.id).then(() => setFileError(''), error => setFileError(String(error.message))).finally(() => setSaving(false)); }, 700);
    return () => clearTimeout(timer);
  }, [page.id, page.source, page.file?.revision, page.externalFile]);
  useEffect(() => { const record = state.teams.find(item => item.definition.id === teamId);
    if (record && (registered?.id !== teamId || !registered.source && registered.revision === record.revision)) setRegistered({ id: teamId, revision: record.revision, source: teamToMarkdown(record.definition) });
  }, [teamId, state.teams, registered?.id, registered?.revision, registered?.source]);
  const open = async () => { const result = await files.open(); if (result) acceptCreationFile(result); };
  const reload = async () => { try { await refreshCreationFile(page.id); setFileError(''); } catch (error) { setFileError(String((error as Error).message)); } };
  const saveFile = async (asNew = false) => {
    if (live.preview) return;
    if (page.file && !page.temporary && !asNew) { setSaving(true); try { await saveCreationFile(page.id); setFileError(''); } catch (error) { setFileError(String((error as Error).message)); } finally { setSaving(false); } return; }
    const result = await files.save(source, bushItPageName(page, language), true);
    if (result) { if (asNew) { createBushItPage(result.text, result); onNewFile?.(result.path); } else updateBushItPage(page.id, { file: result, temporary: false, externalFile: undefined }); }
  };
  useEffect(() => { const save = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(); } }; window.addEventListener('keydown', save); return () => window.removeEventListener('keydown', save); });
  const saveTeam = async (practice: boolean) => {
    if (teamBusy || state.loading) return; setTeamBusy(true); setTeamError('');
    try {
      const definition = teamFromMarkdown(source);
      if (page.file) await saveCreationFile(page.id);
      const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition, expected_revision: registered?.id === definition.id ? registered.revision : 0 });
      setRegistered({ id: definition.id, revision: receipt.revision, source }); onTeamSaved?.({ id: definition.id, revision: receipt.revision }); await refreshTeamWorkspace(true);
      if (practice) { selectTeam(definition.id); onPractice?.(definition); }
    } catch (caught) { setTeamError(String((caught as Error).message)); } finally { setTeamBusy(false); }
  };
  if (page.unloaded) return <div className="creation-empty" role="status">{readError || uiText(language)('mdPresentationApp.loadingMarkdown')}</div>;
  return <>{(fileError || readError || files.error || teamError) && <p role="alert" className="md-error">{fileError || readError || files.error || teamError}</p>}
    {page.externalFile && <div className="creation-conflict" role="alert"><span>{uiText(language)('mdPresentationApp.theFileHasANewVersionYour')}</span>
      <button type="button" disabled={saving} onClick={async () => { setSaving(true); try { if (onKeepDraft) await onKeepDraft(page.source); else createBushItPage(page.source); updateBushItPage(page.id, { source: page.externalFile!.text, file: page.externalFile, externalFile: undefined }); selectBushItPage(page.id); setFileError(''); } catch (error) { setFileError(String((error as Error).message)); } finally { setSaving(false); } }}>{uiText(language)('mdPresentationApp.keepDraftAndLoadNewVersion')}</button>
      <button type="button" onClick={() => void saveFile(true)}>{uiText(language)('mdPresentationApp.saveDraftAs')}</button></div>}
    <TeamDocumentEditor source={live.preview?.source ?? source} liveEdit={live.preview} onBeforeEdit={live.beforeEdit} onCompositionChange={live.compositionChange}
      anchorRequest={anchorRequest}
      onChange={value => { live.beforeEdit(); setSource(value); setTeamError(''); }} language={language} teamEnabled={Boolean(config)} agents={state.agents} lockedId={registered?.id === teamId && registered.revision > 0}
      onSourceSelection={onSourceSelection}
      headerActions={<>{embedded && <span className="canvas-document-save-state" role="status">{page.externalFile ? uiText(language)('mdPresentationApp.versionConflict') : saving ? uiText(language)('networkProxySettings.saving') : page.file && page.source !== page.file.text ? uiText(language)('canvasMarkdownWorkspace.unsaved') : uiText(language)('modelsSettingsPanel.saved')}</span>}
        {onOpenTeam && registered?.id === teamId && <button type="button" disabled={teamBusy} onClick={() => onOpenTeam(teamId)}>{uiText(language)('mdPresentationApp.viewWorkflow')}</button>}
        {embedded && config && <button type="button" disabled={teamBusy || state.loading || !!live.preview} onClick={() => void saveTeam(false)}><Save size={14}/>{registered?.source === source ? uiText(language)('mdPresentationApp.savedToWorkflow') : uiText(language)('mdPresentationApp.saveToWorkflow')}</button>}
        <button type="button" disabled={saving || files.busy || !!live.preview} onClick={() => void saveFile()} aria-label={uiText(language)('mdPresentationApp.saveMarkdown')} title={uiText(language)('mdPresentationApp.ctrl_s')}><Save size={16}/></button></>}
      toolbar={<>
        {config ? <><span className="md-team-save-state">{registered?.source === source ? uiText(language)('mdPresentationApp.savedToTeam') : uiText(language)('mdPresentationApp.team')}</span>
          <button type="button" disabled={teamBusy || state.loading || !!live.preview} onClick={() => void saveTeam(false)}><Save size={14}/>{uiText(language)('mdPresentationApp.saveToTeam')}</button>
          {onPractice && <button type="button" disabled={teamBusy || state.loading || !!live.preview} onClick={() => void saveTeam(true)}><Play size={14}/>{uiText(language)('mdPresentationApp.practice')}</button>}</>
          : <button type="button" disabled={!document} onClick={() => setSource(enableDocumentTeam(source))}><UsersRound size={15}/>{uiText(language)('mdPresentationApp.practiceWithTeam')}</button>}
        <div className="bush-page-menu-group">
          {!embedded && <><button type="button" onClick={() => createBushItPage()}><FilePlus2 size={15}/>{uiText(language)('bushItSidebar.newPage')}</button>
          <button type="button" disabled={files.busy} onClick={() => void open()}><FolderOpen size={15}/>{uiText(language)('mdPresentationApp.openMd')}</button></>}
          <button type="button" disabled={files.busy || !!live.preview} onClick={() => void saveFile()}><Save size={15}/>{uiText(language)('mdPresentationApp.saveMd')}</button>
          {files.file && <><button type="button" disabled={files.busy || !!live.preview} onClick={() => void saveFile(true)}>{uiText(language)('mdPresentationApp.saveAs')}</button>
            <button type="button" disabled={files.busy} onClick={() => void reload()}><RefreshCw size={15}/>{uiText(language)('mdPresentationApp.checkFileChanges')}</button></>}
          <small>{files.file?.path || uiText(language)('mdPresentationApp.pagesAreStoredOnThisDevice')}</small>
        </div>
      </>}/>
  </>;
}
function documentHidden() { return window.document.hidden; }
