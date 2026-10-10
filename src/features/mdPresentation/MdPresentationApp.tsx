import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, PanelRightOpen, Play, RefreshCw, Save, UsersRound } from 'lucide-react';
import { TEAM_WORKFLOW_COMMAND, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import { useMarkdownFile } from './useMarkdownFile';
import { parseMarkdownGraph } from './markdownGraph';
import { takeBushItDocument, watchBushItDocument } from './bushItDocuments';
import { bushItPageName, createBushItPage, selectBushItPage, updateBushItPage, useBushItPages, type BushItPage } from './bushItPageStore';
import { TeamDocumentEditor } from '../team/TeamDocumentEditor';
import { documentTeam, enableDocumentTeam, teamFromMarkdown, teamToMarkdown } from '../team/teamMarkdown';
import { refreshTeamWorkspace, selectTeam, teamCommand, useTeamWorkspace } from '../team/teamWorkspaceStore';

type BushItAppProps = { language: 'zh' | 'en'; onPractice?: (team: TeamWorkflow) => void; inspectorOpen?: boolean; onToggleInspector?: () => void };
export function MdPresentationApp({ language, onPractice, inspectorOpen, onToggleInspector }: BushItAppProps) {
  const state = useBushItPages(), current = useRef(state); current.current = state;
  useEffect(() => {
    const receive = () => { const source = takeBushItDocument(); if (source === undefined) return;
      const existing = current.current.pages.find(page => !page.archived && page.source === source);
      if (existing) selectBushItPage(existing.id); else createBushItPage(source);
    };
    receive(); return watchBushItDocument(receive);
  }, []);
  const page = state.pages.find(item => item.id === state.selectedId && !item.archived);
  return <div className="md-app bush-pages-app" aria-label="bush-it">{state.error && <p role="alert" className="md-error">{state.error}</p>}
    {page && <BushItDocumentPage key={page.id} page={page} language={language} onPractice={onPractice} inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector}/>}
  </div>;
}

function BushItDocumentPage({ page, language, onPractice, inspectorOpen, onToggleInspector }: BushItAppProps & { page: BushItPage }) {
  const source = page.source, setSource = (value: string) => updateBushItPage(page.id, { source: value });
  const [teamError, setTeamError] = useState(''), [teamBusy, setTeamBusy] = useState(false);
  const [registered, setRegistered] = useState<{ id: string; revision: number; source: string }>();
  const document = useMemo(() => { try { return parseMarkdownGraph(source); } catch { return undefined; } }, [source]);
  const config = document && documentTeam(document), teamId = String(config?.id || '');
  const state = useTeamWorkspace(Boolean(config)), files = useMarkdownFile(), t = (cn: string, en: string) => language === 'zh' ? cn : en;
  useEffect(() => { if (page.file) files.accept(page.file); }, []);
  useEffect(() => { const record = state.teams.find(item => item.definition.id === teamId);
    if (record && registered?.id !== teamId) setRegistered({ id: teamId, revision: record.revision, source: teamToMarkdown(record.definition) });
  }, [teamId, state.teams, registered?.id]);
  const open = async () => { const result = await files.open(); if (result) createBushItPage(result.text, result); };
  const reload = async () => { const result = await files.reload(); if (result) createBushItPage(result.text, result); };
  const saveFile = async (asNew = false) => {
    const result = await files.save(source, bushItPageName(page, language), asNew);
    if (result) updateBushItPage(page.id, { file: result });
  };
  const saveTeam = async (practice: boolean) => {
    if (teamBusy || state.loading) return; setTeamBusy(true); setTeamError('');
    try {
      const definition = teamFromMarkdown(source);
      const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition, expected_revision: registered?.id === definition.id ? registered.revision : 0 });
      setRegistered({ id: definition.id, revision: receipt.revision, source }); await refreshTeamWorkspace();
      if (practice) { selectTeam(definition.id); onPractice?.(definition); }
    } catch (caught) { setTeamError(String((caught as Error).message)); } finally { setTeamBusy(false); }
  };
  return <>{(files.error || teamError) && <p role="alert" className="md-error">{files.error || teamError}</p>}
    <TeamDocumentEditor source={source} onChange={value => { setSource(value); setTeamError(''); }} language={language} teamEnabled={Boolean(config)} agents={state.agents} lockedId={registered?.id === teamId && registered.revision > 0}
      headerActions={!inspectorOpen && onToggleInspector && <button type="button" data-inspector-toggle data-shortcut="toggleInspector" aria-label={t('展开右侧栏', 'Expand sidebar')} aria-expanded={false} aria-controls="right-inspector" onClick={onToggleInspector}><PanelRightOpen size={17}/></button>}
      toolbar={<>
        {config ? <><span className="md-team-save-state">{registered?.source === source ? t('已保存到 Team', 'Saved to Team') : 'Team'}</span>
          <button type="button" disabled={teamBusy || state.loading} onClick={() => void saveTeam(false)}><Save size={14}/>{t('保存到 Team', 'Save to Team')}</button>
          {onPractice && <button type="button" disabled={teamBusy || state.loading} onClick={() => void saveTeam(true)}><Play size={14}/>{t('实践', 'Practice')}</button>}</>
          : <button type="button" disabled={!document} onClick={() => setSource(enableDocumentTeam(source))}><UsersRound size={15}/>{t('用 Team 实践', 'Practice with Team')}</button>}
        <div className="bush-page-menu-group">
          <button type="button" onClick={() => createBushItPage()}><FilePlus2 size={15}/>{t('新建页面', 'New page')}</button>
          <button type="button" disabled={files.busy} onClick={() => void open()}><FolderOpen size={15}/>{t('打开 .md', 'Open .md')}</button>
          <button type="button" disabled={files.busy} onClick={() => void saveFile()}><Save size={15}/>{t('保存 .md', 'Save .md')}</button>
          {files.file && <><button type="button" disabled={files.busy} onClick={() => void saveFile(true)}>{t('另存为', 'Save as')}</button>
            <button type="button" disabled={files.busy} onClick={() => void reload()}><RefreshCw size={15}/>{t('重新载入为新页面', 'Reload into a new page')}</button></>}
          <small>{files.file?.path || t('页面自动保存在本机', 'Pages are stored on this device')}</small>
        </div>
      </>}/>
  </>;
}
