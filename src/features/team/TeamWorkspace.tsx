import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { EmployeeIcon } from './employeePresentation';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, registeredAgentSchema, type RegisteredAgent, type DefinitionReceipt, type TeamWorkflow } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';
import { refreshTeamWorkspace, teamCommand, useTeamWorkspace } from './teamWorkspaceStore';
import { TeamGraphWorkspace } from './TeamGraphWorkspace';
import './team-workspace.css';

export function TeamWorkspace({ language, onPractice }: { language: AppLanguage; onPractice?: (team: TeamWorkflow) => void }) {
  const state = useTeamWorkspace();
  const zh = language === 'zh', t = (cn: string, en: string) => zh ? cn : en;
  const [tab, setTab] = useState<'agents' | 'teams' | 'runs'>('teams');
  const [agent, setAgent] = useState<DefinitionReceipt<RegisteredAgent> | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const explainError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('acyclic')) return t('节点依赖存在循环或无效引用，请检查各节点的等待条件。', 'Dependencies form a cycle or reference a missing node. Check each node’s prerequisites.');
    if (message.includes('Definition changed')) return t('配置已在别处修改。请刷新并重新选择该记录后再保存。', 'This definition changed elsewhere. Refresh and reselect it before saving.');
    if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) return error.issues.map(issue => String(issue.message)).join(' · ');
    return message;
  };
  const statusLabel = (status: string) => ({ pending: t('等待依赖', 'Pending'), running: t('运行中', 'Running'), completed: t('已完成', 'Completed'),
    failed: t('失败', 'Failed'), stopped: t('已停止', 'Stopped'), interrupted: t('运行已中断', 'Interrupted') }[status] ?? status);
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshTeamWorkspace(); }, 4000); return () => window.clearInterval(timer); }, []);
  const perform = async (operation: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await operation(); await refreshTeamWorkspace(); } catch (error) { setError(explainError(error)); }
    finally { setBusy(false); }
  };
  const changeAgent = (patch: Partial<RegisteredAgent>) => { setError(''); setAgent(current => current && ({ ...current, definition: { ...current.definition, ...patch } })); };
  const newAgent = () => setAgent({ revision: 0, updatedAt: '', definition: registeredAgentSchema.parse({ id: `agent-${crypto.randomUUID()}`, name: t('新员工', 'New agent'), system_prompt: t('明确岗位职责、原则及交付要求。', 'Define responsibilities, principles and deliverables.') }) });
  const names = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  return <div className="native-team-workspace">
    <nav aria-label={t('团队管理', 'Team management')}>
      {(['agents', 'teams', 'runs'] as const).map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => { setError(''); setTab(key); }}>{key === 'agents' ? t('员工', 'Agents') : key === 'teams' ? t('团队文档', 'Team documents') : t('运行记录', 'Runs')}</button>)}
      <button type="button" aria-label={t('刷新', 'Refresh')} onClick={() => void refreshTeamWorkspace()}><RefreshCw size={16} /></button>
    </nav>
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
    {tab === 'agents' && <div className="native-team-columns">
      <div className="native-team-list"><button type="button" onClick={newAgent}><Plus size={16} />{t('注册员工', 'Register agent')}</button>
        {state.agents.map(record => <button type="button" key={record.definition.id} aria-pressed={agent?.definition.id === record.definition.id} onClick={() => setAgent(structuredClone(record))}><strong className="native-team-identity"><EmployeeIcon size={17} />{record.definition.name}</strong><small>{record.definition.description || record.definition.id}</small></button>)}
        {!state.agents.length && <p>{t('可以在对话中让 Agent 注册员工，也可以在这里创建。', 'Ask an agent to register an employee, or create one here.')}</p>}
      </div>
      {agent && <form className="native-team-editor" onSubmit={event => { event.preventDefault(); void perform(async () => {
        const receipt = await teamCommand<DefinitionReceipt<RegisteredAgent>>(AGENT_REGISTRY_COMMAND, { action: 'save', definition: registeredAgentSchema.parse(agent.definition), expected_revision: agent.revision });
        setAgent(current => current?.definition.id === receipt.definition.id ? { ...receipt, definition: current.definition } : current);
      }); }}>
        <label>{t('名称', 'Name')}<input required value={agent.definition.name} onChange={event => changeAgent({ name: event.target.value })} /></label>
        <label>ID<input required disabled={agent.revision > 0} value={agent.definition.id} onChange={event => changeAgent({ id: event.target.value })} /></label>
        <label>{t('职责说明', 'Description')}<textarea value={agent.definition.description} onChange={event => changeAgent({ description: event.target.value })} /></label>
        <label>{t('岗位指令', 'System prompt')}<textarea required rows={8} value={agent.definition.system_prompt} onChange={event => changeAgent({ system_prompt: event.target.value })} /></label>
        <label>{t('记忆范围', 'Memory scope')}<select value={agent.definition.memory} onChange={event => changeAgent({ memory: event.target.value as RegisteredAgent['memory'] })}>
          <option value="user">{t('此员工 · 当前主机', 'This agent · current host')}</option><option value="project">{t('此员工 · 项目', 'This agent · project')}</option><option value="local">{t('此员工 · 本地项目', 'This agent · local project')}</option><option value="none">{t('关闭长期记忆', 'No long-term memory')}</option>
        </select></label>
        <label className="native-team-check"><input type="checkbox" checked={agent.definition.enabled} onChange={event => changeAgent({ enabled: event.target.checked })} />{t('启用员工', 'Enabled')}</label>
        <label className="native-team-check"><input type="checkbox" checked={agent.definition.guards.includes('read_only')} onChange={event => changeAgent({ guards: event.target.checked ? ['read_only'] : [] })} />{t('只读约束', 'Read-only guard')}</label>
        <details><summary>{t('工具与 Hooks', 'Tools and hooks')}</summary>
          <label className="native-team-check"><input type="checkbox" checked={agent.definition.allowed_tools !== undefined} onChange={event => changeAgent({ allowed_tools: event.target.checked ? [] : undefined })} />{t('限定可用工具', 'Restrict available tools')}</label>
          {agent.definition.allowed_tools && <label>{t('工具名称（每行一个）', 'Tool names (one per line)')}<textarea value={agent.definition.allowed_tools.join('\n')} onChange={event => changeAgent({ allowed_tools: names(event.target.value) })} /></label>}
          <label>{t('已安装且受信任的 Hook ID（每行一个）', 'Installed trusted hook IDs (one per line)')}<textarea value={agent.definition.hooks.join('\n')} onChange={event => changeAgent({ hooks: names(event.target.value) })} /></label>
        </details>
        <div className="native-team-actions"><button type="submit" disabled={busy}><Save size={16} />{t('保存员工', 'Save agent')}</button>
          {agent.revision > 0 && <button type="button" disabled={busy} onClick={() => void perform(async () => { await teamCommand(AGENT_REGISTRY_COMMAND, { action: 'delete', agent_id: agent.definition.id, expected_revision: agent.revision }); setAgent(null); })}><Trash2 size={16} />{t('删除注册', 'Delete definition')}</button>}
        </div>
      </form>}
    </div>}
    <div className="team-graph-tab" hidden={tab !== 'teams'}><TeamGraphWorkspace language={language} onPractice={onPractice}/></div>
    {tab === 'runs' && <div className="native-team-runs">{!state.runs.length && <p>{t('还没有运行记录。', 'No runs yet.')}</p>}
      {[...state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => <article key={run.id}><strong>{run.workflow.name}</strong><span>{statusLabel(run.status)}</span><p>{run.input}</p>
        {run.nodes.map((node, index) => <details key={node.id}><summary title={node.id}>{t('节点', 'Node')} {index + 1} · {statusLabel(node.status)}</summary><pre>{node.output || node.error}</pre></details>)}
        {run.error && <p role="alert">{run.error}</p>}<small>{run.id}</small>
        {run.status === 'running' && <button type="button" disabled={busy} onClick={() => void perform(() => teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'stop', run_id: run.id }))}>{t('停止团队', 'Stop run')}</button>}
        {['failed', 'stopped', 'interrupted'].includes(run.status) && <p>{t('可在原对话中要求继续此运行；已完成节点会保留。', 'Ask to resume this run in its original chat; completed nodes are retained.')}</p>}
      </article>)}
    </div>}
  </div>;
}
