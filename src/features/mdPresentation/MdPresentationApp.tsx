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

type BushItAppProps = CreationChatOptions & { language: 'zh' | 'en'; onPractice?: (team: TeamWorkflow) => void; inspectorOpen?: boolean; onToggleInspector?: () => void };
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
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
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
      if (!directory) throw Error(t('无法准备工作区，请重试。', 'Could not prepare the workspace. Please retry.'));
      const file = await markdownFile({ action: 'create', rootPath: directory, path: `document-${captured.id.slice(0, 8)}.md`, text: getBushItPages().pages.find(item => item.id === captured.id)?.source || '' });
      if (!file) throw Error(t('无法准备创作文档，请重试。', 'Could not prepare the document. Please retry.'));
      updateBushItPage(captured.id, { file, temporary: true, ...(!captured.projectDir ? { conversationRoot: directory } : {}) });
    }
    if (captured?.file) await saveCreationFile(captured.id);
    const saved = getBushItPages().pages.find(item => item.id === captured?.id);
    return creationRequest(text, saved, selected, language);
  };
  return <div className="creation-app" aria-label={t('创作', 'Create')} data-chat-open={chatOpen && !!sessionId}>
    <TopBar title={page ? bushItPageName(page, language) : t('创作', 'Create')} language={language} inspectorOpen={!!inspectorOpen} onToggleInspector={onToggleInspector}
      workspaceControl={<div className="creation-top-actions"><button type="button" className="icon-only" aria-label={t('新建临时文档', 'New untitled document')} onClick={() => createBushItPage()}><Plus size={16}/></button></div>}/>
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
      : <div className="creation-empty"><FolderOpen size={28}/><h2>{t('开始创作', 'Start writing')}</h2><p>{t('从左侧选择 Markdown 文件，或新建文档。也可以通过下方输入让 AI 帮你创作。', 'Select or create a Markdown file on the left, or use Input below to write with AI.')}</p></div>}
    </div>
    {localControls && <InspectorCoverControls language={language} inputOpen={chatOpen} onTargetChange={setInputTarget}
      onToggleInput={() => { if (chatOpen) dismissInput(); else void startChat(); }}/>}
    </div>
    {sessionId && <Suspense fallback={null}><CreationConversation key={sessionId} {...chatOptions} sessionId={sessionId} root={root} language={language}
      preparation={state.sessionDrafts[scope] === sessionId ? { title: `${t('创作', 'Create')} · ${page ? bushItPageName(page, language) : fileName(state.projectDir)}`,
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

function BushItDocumentPage({ page, language, onPractice, onSourceSelection, sessionId, root, anchorRequest }: BushItAppProps & { page: BushItPage; onSourceSelection: (selection: MarkdownSelection) => void; sessionId?: string; root: string; anchorRequest?: MarkdownAnchorRequest }) {
  const source = page.source, setSource = (value: string) => updateBushItPage(page.id, { source: value });
  const live = useCreationLiveEdit(page, sessionId, root);
  const [teamError, setTeamError] = useState(''), [teamBusy, setTeamBusy] = useState(false);
  const [registered, setRegistered] = useState<{ id: string; revision: number; source: string }>();
  const [fileError, setFileError] = useState(''), [readError, setReadError] = useState(''), [saving, setSaving] = useState(false);
  const document = useMemo(() => { try { return parseMarkdownGraph(source); } catch { return undefined; } }, [source]);
  const config = document && documentTeam(document), teamId = String(config?.id || '');
  const state = useTeamWorkspace(Boolean(config)), files = useMarkdownFile(), t = (cn: string, en: string) => language === 'zh' ? cn : en;
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
    if (record && registered?.id !== teamId) setRegistered({ id: teamId, revision: record.revision, source: teamToMarkdown(record.definition) });
  }, [teamId, state.teams, registered?.id]);
  const open = async () => { const result = await files.open(); if (result) acceptCreationFile(result); };
  const reload = async () => { try { await refreshCreationFile(page.id); setFileError(''); } catch (error) { setFileError(String((error as Error).message)); } };
  const saveFile = async (asNew = false) => {
    if (live.preview) return;
    if (page.file && !page.temporary && !asNew) { setSaving(true); try { await saveCreationFile(page.id); setFileError(''); } catch (error) { setFileError(String((error as Error).message)); } finally { setSaving(false); } return; }
    const result = await files.save(source, bushItPageName(page, language), true);
    if (result) { if (asNew) createBushItPage(result.text, result); else updateBushItPage(page.id, { file: result, temporary: false, externalFile: undefined }); }
  };
  useEffect(() => { const save = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveFile(); } }; window.addEventListener('keydown', save); return () => window.removeEventListener('keydown', save); });
  const saveTeam = async (practice: boolean) => {
    if (teamBusy || state.loading) return; setTeamBusy(true); setTeamError('');
    try {
      const definition = teamFromMarkdown(source);
      const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition, expected_revision: registered?.id === definition.id ? registered.revision : 0 });
      setRegistered({ id: definition.id, revision: receipt.revision, source }); await refreshTeamWorkspace();
      if (practice) { selectTeam(definition.id); onPractice?.(definition); }
    } catch (caught) { setTeamError(String((caught as Error).message)); } finally { setTeamBusy(false); }
  };
  if (page.unloaded) return <div className="creation-empty" role="status">{readError || t('正在加载 Markdown…', 'Loading Markdown…')}</div>;
  return <>{(fileError || readError || files.error || teamError) && <p role="alert" className="md-error">{fileError || readError || files.error || teamError}</p>}
    {page.externalFile && <div className="creation-conflict" role="alert"><span>{t('文件已有新版本，当前编辑内容已保留。', 'The file has a new version. Your draft is preserved.')}</span>
      <button type="button" onClick={() => { createBushItPage(page.source); updateBushItPage(page.id, { source: page.externalFile!.text, file: page.externalFile, externalFile: undefined }); selectBushItPage(page.id); setFileError(''); }}>{t('保留草稿并载入新版本', 'Keep draft and load new version')}</button>
      <button type="button" onClick={() => void saveFile(true)}>{t('草稿另存为', 'Save draft as')}</button></div>}
    <TeamDocumentEditor source={live.preview?.source ?? source} liveEdit={live.preview} onBeforeEdit={live.beforeEdit} onCompositionChange={live.compositionChange}
      anchorRequest={anchorRequest}
      onChange={value => { live.beforeEdit(); setSource(value); setTeamError(''); }} language={language} teamEnabled={Boolean(config)} agents={state.agents} lockedId={registered?.id === teamId && registered.revision > 0}
      onSourceSelection={onSourceSelection}
      headerActions={<button type="button" disabled={saving || files.busy || !!live.preview} onClick={() => void saveFile()} aria-label={t('保存 Markdown', 'Save Markdown')} title="Ctrl+S"><Save size={16}/></button>}
      toolbar={<>
        {config ? <><span className="md-team-save-state">{registered?.source === source ? t('已保存到 Team', 'Saved to Team') : 'Team'}</span>
          <button type="button" disabled={teamBusy || state.loading || !!live.preview} onClick={() => void saveTeam(false)}><Save size={14}/>{t('保存到 Team', 'Save to Team')}</button>
          {onPractice && <button type="button" disabled={teamBusy || state.loading || !!live.preview} onClick={() => void saveTeam(true)}><Play size={14}/>{t('实践', 'Practice')}</button>}</>
          : <button type="button" disabled={!document} onClick={() => setSource(enableDocumentTeam(source))}><UsersRound size={15}/>{t('用 Team 实践', 'Practice with Team')}</button>}
        <div className="bush-page-menu-group">
          <button type="button" onClick={() => createBushItPage()}><FilePlus2 size={15}/>{t('新建页面', 'New page')}</button>
          <button type="button" disabled={files.busy} onClick={() => void open()}><FolderOpen size={15}/>{t('打开 .md', 'Open .md')}</button>
          <button type="button" disabled={files.busy || !!live.preview} onClick={() => void saveFile()}><Save size={15}/>{t('保存 .md', 'Save .md')}</button>
          {files.file && <><button type="button" disabled={files.busy || !!live.preview} onClick={() => void saveFile(true)}>{t('另存为', 'Save as')}</button>
            <button type="button" disabled={files.busy} onClick={() => void reload()}><RefreshCw size={15}/>{t('检查文件更新', 'Check file changes')}</button></>}
          <small>{files.file?.path || t('页面自动保存在本机', 'Pages are stored on this device')}</small>
        </div>
      </>}/>
  </>;
}
function documentHidden() { return window.document.hidden; }
