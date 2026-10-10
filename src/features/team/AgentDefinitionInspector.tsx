import { useContext, useEffect, useState } from 'react';
import { ChevronRight, RefreshCw, UsersRound } from 'lucide-react';
import { z } from 'zod';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, registeredAgentSchema, teamWorkflowSchema,
  type RegisteredAgent, type TeamWorkflow, type DefinitionReceipt } from '@cardbush/bush-protocol';
import { conversationRuntime } from '../../backend/conversationRuntime';
import type { AppLanguage } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { openWorkSummaryInspector, type WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import { EmployeeIcon } from './employeePresentation';
import { MdPresentation } from '../mdPresentation/MdPresentation';
import { teamToMarkdown } from './teamMarkdown';
import '../mdPresentation/md-presentation.css';
import './agent-definition-inspector.css';

type Detail = Extract<WorkSummaryInspectorDetail, { kind: 'agent-definition' }>;
type Definition = { kind: 'employee'; record: DefinitionReceipt<RegisteredAgent> } | { kind: 'team'; record: DefinitionReceipt<TeamWorkflow> };
const receipt = { revision: z.number().int().positive(), updatedAt: z.string() };
const employeeReceipt = z.object({ ...receipt, definition: registeredAgentSchema });
const teamReceipt = z.object({ ...receipt, definition: teamWorkflowSchema });

export function AgentDefinitionInspector({ detail, language, active = true }: { detail: Detail; language: AppLanguage; active?: boolean }) {
  const host = useContext(ConversationHostContext);
  const [loaded, setLoaded] = useState<{ key: string; value?: Definition; error?: string }>();
  const [revision, refresh] = useState(0);
  const key = `${host?.id ?? 'local'}:${detail.entity}:${detail.entityId}:${revision}`;
  const current = loaded?.key === key ? loaded : undefined;
  const zh = language === 'zh', t = (cn: string, en: string) => zh ? cn : en;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const runtime = conversationRuntime(host?.runtime);
    const read = detail.entity === 'employee'
      ? runtime.client.command({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'get', agent_id: detail.entityId } }, value =>
        ({ kind: 'employee' as const, record: employeeReceipt.parse(value) }), controller.signal)
      : runtime.client.command({ kind: TEAM_WORKFLOW_COMMAND, payload: { action: 'get', team_id: detail.entityId } }, value =>
        ({ kind: 'team' as const, record: teamReceipt.parse(value) }), controller.signal);
    void read.then(value => { if (!controller.signal.aborted) setLoaded({ key, value }); })
      .catch(error => { if (!controller.signal.aborted) setLoaded({ key, error: String(error) }); })
      .finally(() => { if (!host?.runtime) runtime.dispose(); });
    return () => controller.abort();
  }, [key, detail.entity, detail.entityId, host?.runtime, active]);
  const value = current?.value;
  const employee = value?.kind === 'employee' ? value.record.definition : undefined;
  const team = value?.kind === 'team' ? value.record.definition : undefined;
  const Icon = detail.entity === 'employee' ? EmployeeIcon : UsersRound;
  return <section className="agent-definition-inspector" aria-label={detail.entity === 'employee' ? t('员工详情', 'Employee details') : t('Team 详情', 'Team details')}>
    <header><Icon size={21} aria-hidden="true" /><div><strong>{value?.record.definition.name || detail.title || detail.entityId}</strong>
      <small>{detail.entity === 'employee' ? t('独立员工 · 注册信息', 'Independent employee · Registration') : t('Team · 注册流程', 'Team · Registered workflow')}</small></div>
      <button type="button" title={t('刷新', 'Refresh')} aria-label={t('刷新', 'Refresh')} onClick={() => refresh(value => value + 1)}><RefreshCw size={16} /></button>
    </header>
    {!current && <p role="status">{t('正在读取注册信息…', 'Loading registration…')}</p>}
    {current?.error && <div role="alert"><p>{t('暂时无法读取当前定义；它可能已被删除，或所在环境不可用。', 'Cannot read the current definition. It may have been deleted or its environment is unavailable.')}</p><details><summary>{t('错误详情', 'Error details')}</summary><pre>{current.error}</pre></details></div>}
    {value && <>
      <p>{value.record.definition.description || t('未填写职责说明', 'No description provided')}</p>
      <dl><dt>ID</dt><dd>{value.record.definition.id}</dd><dt>{t('当前版本', 'Current revision')}</dt><dd>{value.record.revision}</dd>
        {employee && <><dt>{t('状态', 'Status')}</dt><dd>{employee.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}</dd>
          <dt>{t('长期记忆', 'Long-term memory')}</dt><dd>{{ user: t('此员工 · 当前主机', 'Employee · current host'), project: t('此员工 · 项目', 'Employee · project'), local: t('此员工 · 本地项目', 'Employee · local project'), none: t('关闭', 'Off') }[employee.memory]}</dd></>}
        {team && <><dt>{t('最大并行数', 'Maximum parallel nodes')}</dt><dd>{team.max_parallel}</dd></>}
      </dl>
      {employee && <>
        <details><summary>{t('岗位指令', 'System prompt')}</summary><pre>{employee.system_prompt}</pre></details>
        <details><summary>{t('工具、Hooks 与 Guard', 'Tools, hooks and guards')}</summary>
          <h4>{t('可用工具', 'Allowed tools')}</h4><pre>{employee.allowed_tools?.join('\n') || (employee.allowed_tools ? t('无', 'None') : t('继承当前允许的工具', 'Inherit available tools'))}</pre>
          <h4>Hooks</h4><pre>{employee.hooks.join('\n') || t('无', 'None')}</pre>
          <h4>Guard</h4><pre>{employee.guards.includes('read_only') ? t('只读', 'Read only') : t('无额外约束', 'No additional guards')}</pre>
        </details>
        {!!employee.settings && <details><summary>{t('执行配置', 'Execution settings')}</summary><pre>{JSON.stringify(employee.settings, null, 2)}</pre></details>}
      </>}
      {team && <div className="agent-definition-nodes"><h3>{t('协作文档', 'Collaboration document')}</h3>
        <div className="team-inspector-document"><MdPresentation source={teamToMarkdown(team)} onChange={() => {}} language={language} flow readOnly
          icon={() => <EmployeeIcon size={16}/>} subtitle={node => String(node.attributes.agent_id || '')}/></div>
        <details><summary>{t('员工详情', 'Agent details')}</summary>{[...new Set(team.nodes.map(node => node.agent_id))].map(id => <button type="button" key={id}
          onClick={() => (host?.openWorkSummary ?? openWorkSummaryInspector)({ kind: 'agent-definition', sessionId: detail.sessionId, entity: 'employee', entityId: id, title: id })}>
          <EmployeeIcon size={17}/><span>{id}</span><ChevronRight size={14}/></button>)}</details>
      </div>}
    </>}
  </section>;
}
