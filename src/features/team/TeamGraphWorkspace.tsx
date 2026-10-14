import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePenLine, Plus, RefreshCw, Save, Trash2, UsersRound } from 'lucide-react';
import { TEAM_WORKFLOW_COMMAND, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import { TeamDocumentEditor } from './TeamDocumentEditor';
import { openBushItDocument } from '../mdPresentation/bushItDocuments';
import { parseMarkdownGraph } from '../mdPresentation/markdownGraph';
import { pageTitle } from '../mdPresentation/pageDocument';
import { useMarkdownFile } from '../mdPresentation/useMarkdownFile';
import { refreshTeamWorkspace, selectTeam, teamCommand, useTeamWorkspace } from './teamWorkspaceStore';
import { documentTeam, teamFromMarkdown, teamToMarkdown } from './teamMarkdown';
import { consumeTeamDocumentRequest, setTeamOpenDocument, useTeamWorkspaceNavigation } from './teamWorkspaceNavigation';

type Draft = { id: string; revision: number; source: string; saved: string };
let retainedDraft: Draft | null = null;
export function TeamGraphWorkspace({ language, onPractice }: { language: 'zh' | 'en'; onPractice?: (team: TeamWorkflow) => void }) {
  const state = useTeamWorkspace(), files = useMarkdownFile(), t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const [draft, setDraft] = useState<Draft | null>(() => retainedDraft), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const navigation = useTeamWorkspaceNavigation();
  useEffect(() => { retainedDraft = draft; }, [draft]);
  const documentName = useMemo(() => {
    try { const name = draft && pageTitle(parseMarkdownGraph(draft.source)).title; if (name?.trim()) return name; }
    catch { /* Keep the document reachable while its Markdown is being edited. */ }
    return t('未命名团队', 'Untitled team');
  }, [draft?.source, language]);
  useEffect(() => { setTeamOpenDocument(draft ? { id: draft.id, name: documentName, dirty: draft.source !== draft.saved } : null, busy || files.busy); }, [draft, documentName, busy, files.busy]);
  const [pending, setPending] = useState<() => void>(), [deletePending, setDeletePending] = useState(false);
  const load = (receipt: DefinitionReceipt<TeamWorkflow>) => {
    const source = teamToMarkdown(receipt.definition); files.clear(); setError(''); setPending(undefined); setDeletePending(false);
    setDraft({ id: receipt.definition.id, revision: receipt.revision, source, saved: source });
  };
  const replace = (operation: () => void) => { if (draft && draft.source !== draft.saved) setPending(() => operation); else operation(); };
  useEffect(() => {
    if (!draft && !navigation.request && state.teams.length) load(state.teams.find(item => item.definition.id === state.selectedId) || state.teams[0]);
    // A clean document follows saves from bush-it; an unfinished local edit stays intact.
    const latest = state.teams.find(item => item.definition.id === draft?.id);
    if (draft && draft.source === draft.saved && latest && latest.revision > draft.revision) load(latest);
  }, [state.teams, draft?.id, draft?.revision, draft?.source, draft?.saved]);
  // An explicit conversation-team selection also opens its document; refresh never overwrites edits.
  const previousSelection = useRef(state.selectedId);
  useEffect(() => {
    if (previousSelection.current === state.selectedId) return;
    previousSelection.current = state.selectedId;
    const record = state.teams.find(item => item.definition.id === state.selectedId);
    if (record && record.definition.id !== draft?.id) replace(() => load(record));
  }, [state.selectedId]);
  const create = () => replace(() => {
    const team = { id: `team-${crypto.randomUUID().slice(0, 8)}`, name: t('新团队', 'New team'), description: '', max_parallel: 3, nodes: [] };
    files.clear(); setError(''); setPending(undefined); setDeletePending(false); setDraft({ id: team.id, revision: 0, source: teamToMarkdown(team), saved: '' });
  });
  const explain = (caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message.includes('acyclic')) return t('节点依赖存在循环或无效引用，请检查节点链接。', 'Dependencies form a cycle or reference a missing node.');
    if (message.includes('Definition changed')) return t('文档已在别处修改。请重新选择文档读取最新版本，当前编辑仍保留。', 'The document changed elsewhere. Reselect it to load the latest version; your edits are retained.');
    if (message.includes('enabled registered Agent')) return t('节点引用了已删除或未启用的员工，请重新选择。', 'Select an enabled registered agent for every node.');
    if (caught && typeof caught === 'object' && 'issues' in caught && Array.isArray(caught.issues)) return caught.issues.map(issue => `${issue.path?.join('.') || 'workflow'}: ${issue.message}`).join('\n');
    return message;
  };
  const save = async () => {
    if (!draft || busy) return; setBusy(true); setError('');
    try {
      const definition = teamFromMarkdown(draft.source);
      if (draft.revision > 0 && definition.id !== draft.id) throw Error(t('已保存到 Team 的 ID 不能修改；请新建团队文档后导入。', 'A saved Team ID cannot change. Import it as a new Team document.'));
      const source = draft.source;
      const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition, expected_revision: draft.revision });
      setDraft(current => current?.id === draft.id ? { ...current, id: definition.id, revision: receipt.revision, saved: source } : current);
      await refreshTeamWorkspace();
    } catch (caught) { setError(explain(caught)); } finally { setBusy(false); }
  };
  const importFile = async (reload: boolean) => {
    const result = await (reload ? files.reload() : files.open()); if (!result) return;
    try {
      const document = parseMarkdownGraph(result.text), id = documentTeam(document)?.id;
      if (typeof id !== 'string' || !id.trim()) throw Error(t('Team Markdown 须包含 id 和 name。', 'Team Markdown requires id and name.'));
      const existing = state.teams.find(item => item.definition.id === id);
      files.accept(result); setPending(undefined); setDeletePending(false);
      setDraft({ id, revision: existing?.revision || 0, source: result.text, saved: existing ? teamToMarkdown(existing.definition) : '' }); setError('');
    } catch (caught) { setError(explain(caught)); }
  };
  // Requests stay available while this editor is lazy-loading or saving. All
  // sidebar document switches pass through the same unsaved-change guard.
  useEffect(() => {
    const request = navigation.request;
    if (!request || busy || files.busy || (request.kind === 'select' && state.loading)) return;
    if (!consumeTeamDocumentRequest(request)) return;
    if (request.kind === 'create') create();
    else if (request.kind === 'open') replace(() => void importFile(false));
    else {
      const record = state.teams.find(item => item.definition.id === request.id);
      if (record) replace(() => load(record));
      else setError(t('这份团队文档已不存在，请刷新列表。', 'This Team document no longer exists. Refresh the list.'));
    }
  }, [navigation.request, busy, files.busy, state.loading]);
  return <div className="team-graph-workspace">
    {pending && <div className="team-draft-notice" role="alert"><span>{t('当前文档有未保存修改。继续切换会放弃这些修改。', 'This document has unsaved changes. Switching discards them.')}</span><button type="button" onClick={() => { const operation = pending; setPending(undefined); operation(); }}>{t('放弃并继续', 'Discard and continue')}</button><button type="button" onClick={() => setPending(undefined)}>{t('保留编辑', 'Keep editing')}</button></div>}
    {(error || files.error) && <p role="alert" className="md-error">{error || files.error}</p>}
    {draft ? <TeamDocumentEditor source={draft.source} onChange={source => { setError(''); setDraft(current => current && ({ ...current, source })); }} language={language}
      agents={state.agents} lockedId={draft.revision > 0}
      headerActions={<button type="button" className="team-document-save" disabled={busy || files.busy} aria-label={t('保存到 Team', 'Save to Team')} title={draft.source !== draft.saved ? t('保存到 Team · 有未保存修改', 'Save to Team · Unsaved changes') : t('已保存到 Team', 'Saved to Team')} onClick={() => void save()}><Save size={16}/>{draft.source !== draft.saved && <i className="team-document-dirty"/>}</button>}
      toolbar={<>
        <button type="button" disabled={busy || files.busy} onClick={() => void save()}><Save size={15}/>{t('保存到 Team', 'Save to Team')}</button>
        {draft.revision > 0 && <button type="button" disabled={busy || draft.source !== draft.saved} onClick={() => { selectTeam(draft.id); if (onPractice) onPractice(teamFromMarkdown(draft.source)); }}><UsersRound size={15}/>{t('选为对话团队', 'Select for chats')}</button>}
        <button type="button" disabled={busy || files.busy} onClick={() => void files.save(draft.source, draft.id)}><Save size={15}/>{t('保存 .md', 'Save .md')}</button>
        {files.file && <><button type="button" disabled={busy || files.busy} onClick={() => void files.save(draft.source, draft.id, true)}><FilePenLine size={15}/>{t('另存为', 'Save as')}</button>
          <button type="button" disabled={busy || files.busy} onClick={() => replace(() => void importFile(true))}><RefreshCw size={15}/>{t('重新载入文件', 'Reload file')}</button></>}
        <button type="button" onClick={() => openBushItDocument(draft.source)}><FilePenLine size={15}/>{t('在创作中编辑', 'Edit in Create')}</button>
        {draft.revision > 0 && <button type="button" disabled={busy || files.busy} onClick={() => setDeletePending(true)}><Trash2 size={15}/>{t('删除 Team', 'Delete Team')}</button>}
        {files.file && <span className="team-document-path" title={files.file.path}>{files.file.path}</span>}
      </>}/>
      : <div className="team-graph-welcome"><h1>{t('团队文档', 'Team documents')}</h1><p>{t('写下目标，安排员工和任务，一起完成。', 'Write down a goal, assign agents and tasks, and work together.')}</p><button type="button" disabled={busy || files.busy} onClick={create}><Plus size={16}/>{t('新建团队文档', 'New Team document')}</button></div>}
    {deletePending && <div className="team-draft-notice" role="alert"><span>{t('删除这份 Team 文档？已有运行记录会保留。', 'Delete this Team document? Existing runs remain available.')}</span><button type="button" disabled={busy} onClick={async () => { if (!draft) return; setBusy(true); try { await teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'delete', team_id: draft.id, expected_revision: draft.revision }); await refreshTeamWorkspace(); files.clear(); setDraft(null); setPending(undefined); setDeletePending(false); } catch (caught) { setError(explain(caught)); } finally { setBusy(false); } }}>{t('确认删除', 'Delete')}</button><button type="button" onClick={() => setDeletePending(false)}>{t('取消', 'Cancel')}</button></div>}
  </div>;
}
