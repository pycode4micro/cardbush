import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { EmployeeIcon } from './employeePresentation';
import { AGENT_REGISTRY_COMMAND, TEAM_WORKFLOW_COMMAND, registeredAgentSchema, type RegisteredAgent, type DefinitionReceipt } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';
import { refreshTeamWorkspace, teamCommand, useTeamWorkspace } from './teamWorkspaceStore';
import { TeamGraphWorkspace } from './TeamGraphWorkspace';
import { TeamWorkflowLibrary } from './TeamWorkflowLibrary';
import { MarkdownContent } from '../chatMessages';
import { teamNodeTitle } from './teamFlowGraph';
import { requestTeamDocument, useTeamWorkspaceNavigation } from './teamWorkspaceNavigation';
import type { CreationChatOptions } from '../mdPresentation/CreationConversation';
import './team-workspace.css';
import { canRegisterWorker, RemoteWorkers, useWorkerConnections } from './RemoteWorkers';

export function TeamWorkspace({ language, chatOptions, onOpenConversation }: { language: AppLanguage; chatOptions?: CreationChatOptions; onOpenConversation?: (id: string) => void }) {
  const state = useTeamWorkspace();
  const workers = useWorkerConnections();

  const { tab } = useTeamWorkspaceNavigation();
  const [agent, setAgent] = useState<DefinitionReceipt<RegisteredAgent> | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { setError(''); }, [tab]);
  const explainError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('acyclic')) return uiText(language)('teamWorkspace.dependenciesFormACycleOrReferenceA');
    if (message.includes('Definition changed')) return uiText(language)('teamWorkspace.thisDefinitionChangedElsewhereRefreshAndReselect');
    if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) return error.issues.map(issue => String(issue.message)).join(' · ');
    return message;
  };
  const statusLabel = (status: string) => ({ pending: uiText(language)('teamWorkspace.pending'), running: uiText(language)('cardlingWindow.running'), completed: uiText(language)('automationPanel.completed'),
    failed: uiText(language)('automationPanel.failed'), stopped: uiText(language)('automationPanel.stopped'), interrupted: uiText(language)('teamWorkspace.interrupted') }[status] ?? status);
  useEffect(() => { const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshTeamWorkspace(false, true); }, 4000); return () => window.clearInterval(timer); }, []);
  const perform = async (operation: () => Promise<unknown>) => {
    setError(''); setBusy(true);
    try { await operation(); await refreshTeamWorkspace(); } catch (error) { setError(explainError(error)); }
    finally { setBusy(false); }
  };
  const changeAgent = (patch: Partial<RegisteredAgent>) => { setError(''); setAgent(current => current && ({ ...current, definition: { ...current.definition, ...patch } })); };
  const newAgent = () => setAgent({ revision: 0, updatedAt: '', definition: registeredAgentSchema.parse({ id: `agent-${crypto.randomUUID()}`, name: uiText(language)('teamWorkspace.newAgent'), system_prompt: uiText(language)('teamWorkspace.defineResponsibilitiesPrinciplesAndDeliverables') }) });
  const names = (value: string) => value.split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  return <div className="native-team-workspace">
    {(error || state.error || workers.error) && <p role="alert">{error || state.error || workers.error}</p>}
    {tab === 'library' && <TeamWorkflowLibrary teams={state.teams} runs={state.runs} language={language}/>}
    {tab === 'agents' && <section className="native-team-management"><h1>{uiText(language)('teamWorkspace.agents')}</h1><div className="native-team-columns">
      <div className="native-team-list"><button type="button" onClick={newAgent}><Plus size={16} />{uiText(language)('teamWorkspace.registerAgent')}</button>
        {state.agents.map(record => <button type="button" key={record.definition.id} aria-pressed={agent?.definition.id === record.definition.id} onClick={() => setAgent(structuredClone(record))}><strong className="native-team-identity"><EmployeeIcon size={17} />{record.definition.name}</strong><small>{record.definition.description || record.definition.id}</small></button>)}
        {!state.agents.length && <p>{uiText(language)('teamWorkspace.askAnAgentToRegisterAnEmployee')}</p>}
      </div>
      {agent && <form className="native-team-editor" onSubmit={event => { event.preventDefault(); void perform(async () => {
        const receipt = await teamCommand<DefinitionReceipt<RegisteredAgent>>(AGENT_REGISTRY_COMMAND, { action: 'save', definition: registeredAgentSchema.parse(agent.definition), expected_revision: agent.revision });
        setAgent(current => current?.definition.id === receipt.definition.id ? { ...receipt, definition: current.definition } : current);
      }); }}>
        <label>{uiText(language)('agentConnectionForm.name')}<input required value={agent.definition.name} onChange={event => changeAgent({ name: event.target.value })} /></label>
        <label>{uiText(language)('agentDefinitionInspector.id')}<input required disabled={agent.revision > 0} value={agent.definition.id} onChange={event => changeAgent({ id: event.target.value })} /></label>
        <label>{uiText(language)('teamWorkspace.description')}<textarea value={agent.definition.description} onChange={event => changeAgent({ description: event.target.value })} /></label>
        <label>{uiText(language)('remoteWorkers.execution')}<select value={agent.definition.remote?.connection_id ?? ''} onChange={event => {
          const target = workers.connections.find(item => item.id === event.target.value);
          changeAgent({ remote: target?.agentId ? { connection_id: target.id, agent_id: target.agentId } : undefined,
            ...(target ? { allowed_tools: undefined, settings: undefined, hooks: [], guards: [] } : {}) });
        }}><option value="">{uiText(language)('remoteWorkers.local')}</option>
          {agent.definition.remote && !workers.connections.some(item => item.id === agent.definition.remote?.connection_id) && <option value={agent.definition.remote.connection_id} disabled>{uiText(language)('remoteWorkers.unavailable')}</option>}
          {workers.connections.map(item => <option key={item.id} value={item.id} disabled={!canRegisterWorker(item)}>{item.name}</option>)}
        </select></label>
        <label>{uiText(language)('agentDefinitionInspector.systemPrompt')}<textarea required rows={8} value={agent.definition.system_prompt} onChange={event => changeAgent({ system_prompt: event.target.value })} /></label>
        <label className="native-team-check"><input type="checkbox" checked={agent.definition.enabled} onChange={event => changeAgent({ enabled: event.target.checked })} />{uiText(language)('teamWorkspace.enabled')}</label>
        {!agent.definition.remote && <><label className="native-team-check"><input type="checkbox" checked={agent.definition.guards.includes('read_only')} onChange={event => changeAgent({ guards: event.target.checked ? ['read_only'] : [] })} />{uiText(language)('teamWorkspace.readOnlyGuard')}</label>
        <details><summary>{uiText(language)('teamWorkspace.toolsAndHooks')}</summary>
          <label className="native-team-check"><input type="checkbox" checked={agent.definition.allowed_tools !== undefined} onChange={event => changeAgent({ allowed_tools: event.target.checked ? [] : undefined })} />{uiText(language)('teamWorkspace.restrictAvailableTools')}</label>
          {agent.definition.allowed_tools && <label>{uiText(language)('teamWorkspace.toolNamesOnePerLine')}<textarea value={agent.definition.allowed_tools.join('\n')} onChange={event => changeAgent({ allowed_tools: names(event.target.value) })} /></label>}
          <label>{uiText(language)('teamWorkspace.installedTrustedHookIdsOnePerLine')}<textarea value={agent.definition.hooks.join('\n')} onChange={event => changeAgent({ hooks: names(event.target.value) })} /></label>
        </details></>}
        {agent.definition.remote && <p>{uiText(language)('remoteWorkers.description')}</p>}
        <div className="native-team-actions"><button type="submit" disabled={busy}><Save size={16} />{uiText(language)('teamWorkspace.saveAgent')}</button>
          {agent.revision > 0 && <button type="button" disabled={busy} onClick={() => void perform(async () => { await teamCommand(AGENT_REGISTRY_COMMAND, { action: 'delete', agent_id: agent.definition.id, expected_revision: agent.revision }); setAgent(null); })}><Trash2 size={16} />{uiText(language)('teamWorkspace.deleteDefinition')}</button>}
        </div>
      </form>}
    </div><RemoteWorkers language={language} connections={workers.connections} refresh={workers.refresh} onRegister={connection => {
      setAgent({ revision: 0, updatedAt: '', definition: registeredAgentSchema.parse({ id: `worker-${crypto.randomUUID()}`, name: connection.name,
        system_prompt: uiText(language)('teamWorkspace.defineResponsibilitiesPrinciplesAndDeliverables'), remote: { connection_id: connection.id, agent_id: connection.agentId } }) });
    }}/></section>}
    <div className="team-graph-tab" hidden={tab !== 'teams'}><TeamGraphWorkspace language={language} chatOptions={chatOptions} onOpenConversation={onOpenConversation} visible={tab === 'teams'}/></div>
    {tab === 'runs' && <section className="native-team-management"><h1>{uiText(language)('teamSidebar.runs')}</h1><div className="native-team-runs">{!state.runs.length && <p>{uiText(language)('teamWorkspace.noRunsYet')}</p>}
      {[...state.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(run => <article key={run.id}><strong>{run.workflow.name}</strong><span>{statusLabel(run.status)}</span><p>{run.input}</p>
        <button type="button" onClick={() => requestTeamDocument({ kind: 'select', id: run.teamId, runId: run.id })}>{uiText(language)('teamWorkspace.viewWorkflowAndResults')}</button>
        {run.nodes.map(node => <details key={node.id}><summary>{teamNodeTitle(run.workflow.nodes.find(item => item.id === node.id)!, run.agents.map(item => item.definition))} · {statusLabel(node.status)}</summary><MarkdownContent content={node.output || node.error} language={language}/></details>)}
        {run.error && <p role="alert">{run.error}</p>}<time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString(language)}</time>
        {run.status === 'running' && <button type="button" disabled={busy} onClick={() => void perform(() => teamCommand(TEAM_WORKFLOW_COMMAND, { action: 'stop', run_id: run.id }))}>{uiText(language)('teamWorkspace.stopRun')}</button>}
        {['failed', 'stopped', 'interrupted'].includes(run.status) && <p>{uiText(language)('teamWorkspace.askToResumeThisRunInIts')}</p>}
      </article>)}
    </div></section>}
  </div>;
}
