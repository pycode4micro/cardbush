import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, RefreshCw, Save, UsersRound } from 'lucide-react';
import { TEAM_WORKFLOW_COMMAND, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import { MdPresentation } from '../mdPresentation/MdPresentation';
import { parseMarkdownGraph } from '../mdPresentation/markdownGraph';
import { useMarkdownFile } from '../mdPresentation/useMarkdownFile';
import { EmployeeIcon } from './employeePresentation';
import { refreshTeamWorkspace, selectTeam, teamCommand, useTeamWorkspace } from './teamWorkspaceStore';
import { teamFromMarkdown, teamToMarkdown } from './teamMarkdown';

type Draft = { id: string; revision: number; source: string; saved: string };
export function TeamGraphWorkspace({ language }: { language: 'zh' | 'en' }) {
  const state = useTeamWorkspace(), files = useMarkdownFile(), t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<() => void>(), [deletePending, setDeletePending] = useState(false);
  const load = (receipt: DefinitionReceipt<TeamWorkflow>) => {
    const source = teamToMarkdown(receipt.definition); files.clear(); setError(''); setDeletePending(false);
    setDraft({ id: receipt.definition.id, revision: receipt.revision, source, saved: source });
  };
  const replace = (operation: () => void) => { if (draft && draft.source !== draft.saved) setPending(() => operation); else operation(); };
  useEffect(() => { if (!draft && state.teams.length) load(state.teams.find(item => item.definition.id === state.selectedId) || state.teams[0]); }, [state.teams]);
  // Sidebar selection is an explicit navigation; background refresh never overwrites edits.
  const previousSelection = useRef(state.selectedId);
  useEffect(() => {
    if (previousSelection.current === state.selectedId) return;
    previousSelection.current = state.selectedId;
    const record = state.teams.find(item => item.definition.id === state.selectedId);
    if (record && record.definition.id !== draft?.id) replace(() => load(record));
  }, [state.selectedId]);
  const create = () => replace(() => {
    const team = { id: `team-${crypto.randomUUID().slice(0, 8)}`, name: t('新团队', 'New team'), description: '', max_parallel: 3, nodes: [] };
    files.clear(); setError(''); setDraft({ id: team.id, revision: 0, source: teamToMarkdown(team), saved: '' });
  });
  const explain = (caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (message.includes('acyclic')) return t('节点依赖存在循环或无效引用，请检查节点链接。', 'Dependencies form a cycle or reference a missing node.');
    if (message.includes('Definition changed')) return t('配置已在别处修改。请重新选择流程读取最新版本，当前编辑仍保留。', 'The workflow changed elsewhere. Reselect it to load the latest version; your edits are retained.');
    if (message.includes('enabled registered Agent')) return t('节点引用了已删除或未启用的员工，请重新选择。', 'Select an enabled registered agent for every node.');
    if (caught && typeof caught === 'object' && 'issues' in caught && Array.isArray(caught.issues)) return caught.issues.map(issue => `${issue.path?.join('.') || 'workflow'}: ${issue.message}`).join('\n');
    return message;
  };
  const save = async () => {
    if (!draft || busy) return; setBusy(true); setError('');
    try {
      const definition = teamFromMarkdown(draft.source);
      if (draft.revision > 0 && definition.id !== draft.id) throw Error(t('已保存流程的 ID 不能修改；请新建流程后导入。', 'A saved workflow ID cannot change. Import it as a new workflow.'));
      const source = draft.source;
      const receipt = await teamCommand<DefinitionReceipt<TeamWorkflow>>(TEAM_WORKFLOW_COMMAND, { action: 'save', definition, expected_revision: draft.revision });
      setDraft(current => current?.id === draft.id ? { ...current, id: definition.id, revision: receipt.revision, saved: source } : current);
      await refreshTeamWorkspace();
    } catch (caught) { setError(explain(caught)); } finally { setBusy(false); }
  };
  const importFile = async (reload: boolean) => {
    const result = await (reload ? files.reload() : files.open()); if (!result) return;
    try {
      const document = parseMarkdownGraph(result.text), id = document.attributes.id;
      if (typeof id !== 'string' || !id.trim()) throw Error(t('Team Markdown 须包含 id 和 name。', 'Team Markdown requires id and name.'));
      const existing = state.teams.find(item => item.definition.id === id);
      files.accept(result);
      setDraft({ id, revision: existing?.revision || 0, source: result.text, saved: existing ? teamToMarkdown(existing.definition) : '' }); setError('');
    } catch (caught) { setError(explain(caught)); }
  };
  return <div className="team-graph-workspace">
    <div className="team-graph-header"><div className="team-graph-select"><UsersRound size={17}/><select aria-label={t('选择团队流程', 'Select workflow')} value={draft && state.teams.some(item => item.definition.id === draft.id) ? draft.id : ''} disabled={busy || files.busy} onChange={event => { const record = state.teams.find(item => item.definition.id === event.target.value); if (record) replace(() => load(record)); }}><option value="">{t('选择团队流程', 'Select workflow')}</option>{state.teams.map(record => <option key={record.definition.id} value={record.definition.id}>{record.definition.name}</option>)}</select></div>
      <button type="button" disabled={busy || files.busy} onClick={create}><Plus size={15}/>{t('新建流程', 'New workflow')}</button>
      <button type="button" disabled={busy || files.busy} onClick={() => replace(() => void importFile(false))}><FolderOpen size={15}/>{t('打开 .md', 'Open .md')}</button>
      {files.file && <button type="button" disabled={busy || files.busy} onClick={() => replace(() => void importFile(true))}><RefreshCw size={15}/>{t('重新载入文件', 'Reload file')}</button>}
      {draft && <><button type="button" disabled={busy || files.busy} onClick={() => void files.save(draft.source, draft.id)}><Save size={15}/>{t('保存 .md', 'Save .md')}</button>{files.file && <button type="button" disabled={busy || files.busy} onClick={() => void files.save(draft.source, draft.id, true)}>{t('另存为', 'Save as')}</button>}
        <span className="team-graph-save-state">{draft.source !== draft.saved ? t('流程有未保存修改', 'Unsaved workflow') : t('流程已保存', 'Saved workflow')}</span></>}
    </div>
    {pending && <div className="team-draft-notice" role="alert"><span>{t('当前流程有未保存修改。继续切换会放弃这些修改。', 'This workflow has unsaved changes. Switching discards them.')}</span><button type="button" onClick={() => { const operation = pending; setPending(undefined); operation(); }}>{t('放弃并继续', 'Discard and continue')}</button><button type="button" onClick={() => setPending(undefined)}>{t('保留编辑', 'Keep editing')}</button></div>}
    {(error || files.error) && <p role="alert" className="md-error">{error || files.error}</p>}
    {draft ? <MdPresentation key={draft.id} source={draft.source} onChange={source => { setError(''); setDraft(current => current && ({ ...current, source })); }} language={language} flow
      maxNodes={64} newNodeAttributes={{ agent_id: '' }} icon={() => <EmployeeIcon size={18}/>}
      subtitle={node => state.agents.find(record => record.definition.id === node.attributes.agent_id)?.definition.name || t('待选择员工', 'Choose an agent')}
      nodeFields={(node, change) => <label className="md-field">{t('员工', 'Agent')}<select value={String(node.attributes.agent_id || '')} onChange={event => change({ attributes: { ...node.attributes, agent_id: event.target.value } })}><option value="">{t('选择员工', 'Select agent')}</option>{state.agents.filter(record => record.definition.enabled).map(record => <option key={record.definition.id} value={record.definition.id}>{record.definition.name}</option>)}</select></label>}
      documentFields={(document, change) => <><label className="md-field">{t('名称', 'Name')}<input value={String(document.attributes.name || '')} onChange={event => change({ ...document.attributes, name: event.target.value })}/></label><label className="md-field">ID<input disabled={draft.revision > 0} value={String(document.attributes.id || '')} onChange={event => change({ ...document.attributes, id: event.target.value })}/></label><label className="md-field">{t('最大并行数', 'Maximum parallel nodes')}<input type="number" min={1} max={8} value={Number(document.attributes.max_parallel ?? 3)} onChange={event => change({ ...document.attributes, max_parallel: Number(event.target.value) })}/></label></>}
      toolbar={<><button type="button" className="team-save-workflow" disabled={busy} onClick={() => void save()}><Save size={15}/>{t('保存流程', 'Save workflow')}</button>{draft.revision > 0 && <button type="button" disabled={busy || draft.source !== draft.saved} onClick={() => selectTeam(draft.id)}>{t('选为对话团队', 'Select for chats')}</button>}</>}/>
      : <div className="team-graph-welcome"><UsersRound size={36}/><h2>{t('让员工协作，从连接节点开始', 'Connect agents into a team')}</h2><p>{t('先注册可复用的员工，再把任务连接成可串行、可并行的流程。', 'Register reusable agents, then link tasks into sequential or parallel workflows.')}</p><button type="button" onClick={create}><Plus size={16}/>{t('新建流程', 'New workflow')}</button></div>}
    {draft && <footer className="team-graph-footer"><span title={files.file?.path}>{files.file?.path || t('md演示 · 图谱与 Markdown 共用编辑器', 'md presentation · shared graph and Markdown editor')}</span>{draft.revision > 0 && <button type="button" disabled={busy} onClick={() => setDeletePending(true)}>{t('删除流程', 'Delete workflow')}</button>}</footer>}
    {deletePending && <div className="team-draft-notice" role="alert"><span>{t('删除这份流程定义？已有运行记录会保留。', 'Delete this workflow definition? Existing runs remain available.')}</span><button type="button" disabled={busy} onClick={async () => { if (!draft) return; setBusy(true); try { await teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'delete', team_id: draft.id, expected_revision: draft.revision }); setDraft(null); setDeletePending(false); await refreshTeamWorkspace(); } catch (caught) { setError(explain(caught)); } finally { setBusy(false); } }}>{t('确认删除', 'Delete')}</button><button type="button" onClick={() => setDeletePending(false)}>{t('取消', 'Cancel')}</button></div>}
  </div>;
}
