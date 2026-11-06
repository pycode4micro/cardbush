import { uiText } from '../../i18n';
import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, FolderOpen, Play, RefreshCw, Save, UsersRound } from 'lucide-react';
import { TEAM_WORKFLOW_COMMAND, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import { useMarkdownFile } from './useMarkdownFile';
import { parseMarkdownGraph } from './markdownGraph';
import { bushItPageName, createBushItPage, selectBushItPage, updateBushItPage, type BushItPage } from './bushItPageStore';
import { acceptCreationFile, refreshCreationFile, saveCreationFile } from './creationFiles';
import type { MarkdownAnchorRequest } from './MdPresentation';
import { useCreationLiveEdit } from './useCreationLiveEdit';
import type { MarkdownSelection } from './MarkdownSourceEditor';
import '../inspector/inspectorWorkspace.css';
import { TeamDocumentEditor } from '../team/TeamDocumentEditor';
import { documentTeam, enableDocumentTeam, teamFromMarkdown, teamToMarkdown } from '../team/teamMarkdown';
import { refreshTeamWorkspace, selectTeam, teamCommand, useTeamWorkspace } from '../team/teamWorkspaceStore';
export function BushItDocumentPage({ page, language, onPractice, onSourceSelection, sessionId, root, anchorRequest, embedded = false, initialTeam, onTeamSaved, onNewFile, onKeepDraft, onOpenTeam }: { language: string; onPractice?: (team: TeamWorkflow) => void;
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
