import type { DefinitionReceipt, RegisteredAgent } from '@cardbush/bush-protocol';
import { MdPresentation, type MdPresentationProps } from '../mdPresentation/MdPresentation';
import { documentTeam } from './teamMarkdown';
import { EmployeeIcon } from './employeePresentation';

/** Team supplies execution controls; bush-it continues to own the article and graph. */
export function TeamDocumentEditor({ agents, lockedId, teamEnabled = true, ...props }: MdPresentationProps & {
  agents: DefinitionReceipt<RegisteredAgent>[]; lockedId?: boolean; teamEnabled?: boolean;
}) {
  const t = (cn: string, en: string) => props.language === 'zh' ? cn : en;
  return <MdPresentation {...props} flow={teamEnabled} newNodeAttributes={teamEnabled ? { agent_id: '', depends_on: [] } : undefined}
    icon={teamEnabled ? node => 'agent_id' in node.attributes ? <EmployeeIcon size={16}/> : undefined : undefined}
    subtitle={teamEnabled ? node => agents.find(record => record.definition.id === node.attributes.agent_id)?.definition.name || String(node.attributes.agent_id || t('待选择员工', 'Choose an agent')) : undefined}
    nodeFields={teamEnabled ? (node, change) => <>
      <label className="md-link-choice"><input type="checkbox" checked={'agent_id' in node.attributes} onChange={event => {
        const attributes = { ...node.attributes };
        if (event.target.checked) { attributes.agent_id = ''; attributes.depends_on = []; }
        else { delete attributes.agent_id; delete attributes.depends_on; }
        change({ attributes });
      }}/><span>{t('这一节作为 Team 任务执行', 'Execute this section as a Team task')}</span></label>
      {'agent_id' in node.attributes && <label className="md-field">{t('员工', 'Agent')}<select value={String(node.attributes.agent_id || '')} onChange={event => change({ attributes: { ...node.attributes, agent_id: event.target.value } })}>
        <option value="">{t('选择员工', 'Select agent')}</option>
        {agents.filter(record => record.definition.enabled).map(record => <option key={record.definition.id} value={record.definition.id}>{record.definition.name}</option>)}
      </select></label>}
    </> : undefined}
    documentFields={teamEnabled ? (document, change) => {
      const config = documentTeam(document) ?? {};
      const update = (patch: Record<string, unknown>) => {
        const attributes = { ...document.attributes };
        const team = { id: config.id, max_parallel: config.max_parallel ?? 3, description: config.description ?? '', ...patch };
        if (!attributes.team) { delete attributes.id; delete attributes.max_parallel; }
        change({ ...attributes, team });
      };
      return <fieldset className="md-team-fields"><legend>{t('Team 执行配置', 'Team execution configuration')}</legend>
        <label className="md-field">Team ID<input disabled={lockedId} value={String(config.id || '')} onChange={event => update({ id: event.target.value })}/></label>
        <label className="md-field">{t('最大并行数', 'Maximum parallel tasks')}<input type="number" min={1} max={8} value={Number(config.max_parallel ?? 3)} onChange={event => update({ max_parallel: Number(event.target.value) })}/></label>
        <label className="md-field">{t('团队简介', 'Team summary')}<textarea rows={2} value={String(config.description || '')} onChange={event => update({ description: event.target.value })}/></label>
      </fieldset>;
    } : undefined}/>;
}
