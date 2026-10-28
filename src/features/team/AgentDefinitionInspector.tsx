import { uiText } from '../../i18n';
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
  return <section className="agent-definition-inspector" aria-label={detail.entity === 'employee' ? uiText(language)('agentDefinitionInspector.employeeDetails') : uiText(language)('agentDefinitionInspector.teamDetails')}>
    <header><Icon size={21} aria-hidden="true" /><div><strong>{value?.record.definition.name || detail.title || detail.entityId}</strong>
      <small>{detail.entity === 'employee' ? uiText(language)('agentDefinitionInspector.independentEmployeeRegistration') : uiText(language)('agentDefinitionInspector.teamRegisteredWorkflow')}</small></div>
      <button type="button" title={uiText(language)('automationPanel.refresh')} aria-label={uiText(language)('automationPanel.refresh')} onClick={() => refresh(value => value + 1)}><RefreshCw size={16} /></button>
    </header>
    {!current && <p role="status">{uiText(language)('agentDefinitionInspector.loadingRegistration')}</p>}
    {current?.error && <div role="alert"><p>{uiText(language)('agentDefinitionInspector.cannotReadTheCurrentDefinitionItMay')}</p><details><summary>{uiText(language)('messageBubble.errorDetails')}</summary><pre>{current.error}</pre></details></div>}
    {value && <>
      <p>{value.record.definition.description || uiText(language)('agentDefinitionInspector.noDescriptionProvided')}</p>
      <dl><dt>{uiText(language)('agentDefinitionInspector.id')}</dt><dd>{value.record.definition.id}</dd><dt>{uiText(language)('agentDefinitionInspector.currentRevision')}</dt><dd>{value.record.revision}</dd>
        {employee && <><dt>{uiText(language)('agentDefinitionInspector.status')}</dt><dd>{employee.enabled ? uiText(language)('featureContentPanel.enabled') : uiText(language)('pluginManagementPanel.disabled')}</dd></>}
        {team && <><dt>{uiText(language)('agentDefinitionInspector.maximumParallelNodes')}</dt><dd>{team.max_parallel}</dd></>}
      </dl>
      {employee && <>
        <details><summary>{uiText(language)('agentDefinitionInspector.systemPrompt')}</summary><pre>{employee.system_prompt}</pre></details>
        <details><summary>{uiText(language)('agentDefinitionInspector.toolsHooksAndGuards')}</summary>
          <h4>{uiText(language)('agentDefinitionInspector.allowedTools')}</h4><pre>{employee.allowed_tools?.join('\n') || (employee.allowed_tools ? uiText(language)('cardlingWindow.none') : uiText(language)('agentDefinitionInspector.inheritAvailableTools'))}</pre>
          <h4>{uiText(language)('agentDefinitionInspector.hooks')}</h4><pre>{employee.hooks.join('\n') || uiText(language)('cardlingWindow.none')}</pre>
          <h4>{uiText(language)('agentDefinitionInspector.guard')}</h4><pre>{employee.guards.includes('read_only') ? uiText(language)('messageBubble.readOnly') : uiText(language)('agentDefinitionInspector.noAdditionalGuards')}</pre>
        </details>
        {!!employee.settings && <details><summary>{uiText(language)('agentDefinitionInspector.executionSettings')}</summary><pre>{JSON.stringify(employee.settings, null, 2)}</pre></details>}
      </>}
      {team && <div className="agent-definition-nodes"><h3>{uiText(language)('agentDefinitionInspector.collaborationDocument')}</h3>
        <div className="team-inspector-document"><MdPresentation source={teamToMarkdown(team)} onChange={() => {}} language={language} flow readOnly
          icon={() => <EmployeeIcon size={16}/>} subtitle={node => String(node.attributes.agent_id || '')}/></div>
        <details><summary>{uiText(language)('agentDefinitionInspector.agentDetails')}</summary>{[...new Set(team.nodes.map(node => node.agent_id))].map(id => <button type="button" key={id}
          onClick={() => (host?.openWorkSummary ?? openWorkSummaryInspector)({ kind: 'agent-definition', sessionId: detail.sessionId, entity: 'employee', entityId: id, title: id })}>
          <EmployeeIcon size={17}/><span>{id}</span><ChevronRight size={14}/></button>)}</details>
      </div>}
    </>}
  </section>;
}
