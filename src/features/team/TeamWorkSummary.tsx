import { useContext, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, UsersRound } from 'lucide-react';
import type { AppLanguage, ChatMessage, SubagentTaskSnapshot } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { subagentTaskPresentation } from '../subagents/subagentTaskPresentation';
import { EmployeeIcon, employeeTaskTitle } from './employeePresentation';
import { conversationRegistrations } from './toolAgentActivity';

export function TeamWorkSummary({ messages, tasks, sessionId, language }: {
  messages: ChatMessage[]; tasks: SubagentTaskSnapshot[]; sessionId: string; language: AppLanguage;
}) {
  const host = useContext(ConversationHostContext);
  const open = host?.openWorkSummary ?? openWorkSummaryInspector;
  const registrations = useMemo(() => conversationRegistrations(messages), [messages]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const zh = language === 'zh';
  const more = (kind: string, count: number) => count > 3 && <button type="button" className="work-summary-history-more"
    aria-expanded={expanded.includes(kind)} onClick={() => setExpanded(values => values.includes(kind) ? values.filter(value => value !== kind) : [...values, kind])}>
    {expanded.includes(kind) ? (zh ? '收起' : 'Show less') : zh ? `展开其余 ${count - 3} 项` : `Show ${count - 3} more`}<ChevronDown size={13} />
  </button>;
  return <>
    {(['employee', 'team'] as const).map(kind => {
      const rows = registrations.filter(activity => activity.kind === kind);
      if (!rows.length) return null;
      const Icon = kind === 'employee' ? EmployeeIcon : UsersRound;
      return <div key={kind} className={`work-summary-section work-summary-${kind}-registrations`}>
        <div className="work-summary-section-title"><strong>{kind === 'employee' ? (zh ? '员工注册' : 'Employee registrations') : (zh ? 'Team 注册' : 'Team registrations')}</strong><span>{rows.length}</span></div>
        <div className="work-summary-file-list">{(expanded.includes(kind) ? rows : rows.slice(0, 3)).map(row => <button type="button" key={row.id}
          title={row.name || row.id} onClick={() => open({ kind: 'agent-definition', sessionId, entity: kind, entityId: row.id, title: row.name || row.id })}>
          <Icon size={17} /><span className="work-summary-file-name">{row.name || row.id}</span><ChevronRight size={14} />
        </button>)}</div>{more(kind, rows.length)}
      </div>;
    })}
    {tasks.length > 0 && <div className="work-summary-section work-summary-employee-runs">
      <div className="work-summary-section-title"><strong>{zh ? '员工执行' : 'Employee runs'}</strong><span>{tasks.length}</span></div>
      <div className="work-summary-subagent-list">{(expanded.includes('runs') ? tasks : tasks.slice(0, 3)).map(task => {
        const status = subagentTaskPresentation(task, language);
        const title = employeeTaskTitle(task, language);
        return <button type="button" className="work-summary-subagent-task" key={task.taskId || task.childSessionId}
          onClick={() => open({ kind: 'subagent-task', sessionId, task, title })}>
          <EmployeeIcon size={17} /><span className="work-summary-subagent-main"><strong>{title}</strong>
            <small title={task.requestPrompt || task.errorMessage}>{task.requestPrompt || task.errorMessage || status.label}</small></span>
          <span className={`work-summary-subagent-status ${status.tone}`}>{status.label}</span><ChevronRight size={14} />
        </button>;
      })}</div>{more('runs', tasks.length)}
    </div>}
  </>;
}
