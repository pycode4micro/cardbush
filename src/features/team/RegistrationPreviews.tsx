import { useContext } from 'react';
import { ChevronRight, UsersRound } from 'lucide-react';
import type { AppLanguage, ChatToolExecution } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { EmployeeIcon } from './employeePresentation';
import { isDefinitionActivity, toolAgentActivity } from './toolAgentActivity';
import { LoopPreviewGroup } from '../tools/LoopPreviewGroup';

export function RegistrationPreviews({ executions, sessionId, language }: {
  executions: ChatToolExecution[]; sessionId: string; language: AppLanguage;
}) {
  const host = useContext(ConversationHostContext);
  const open = host?.openWorkSummary ?? openWorkSummaryInspector;
  const zh = language === 'zh';
  return <>{(['employee', 'team'] as const).map(kind => {
    const rows = executions.flatMap(execution => {
      const activity = toolAgentActivity(execution);
      return isDefinitionActivity(activity) && activity.kind === kind ? [{ execution, activity }] : [];
    });
    if (!rows.length) return null;
    const Icon = kind === 'employee' ? EmployeeIcon : UsersRound;
    const label = kind === 'employee' ? (zh ? '员工注册' : 'Employee registrations') : (zh ? 'Team 注册' : 'Team registrations');
    return <LoopPreviewGroup key={kind} kind={`${kind}-registration`} icon={<Icon size={15} />} label={`${label} · ${rows.length}`}>
      {rows.map(({ execution, activity }) => {
        const saved = execution.state === 'completed' && execution.success;
        const status = saved ? (zh ? '已注册' : 'Registered') : execution.state === 'failed' ? (zh ? '注册失败' : 'Registration failed') :
          execution.state === 'cancelled' ? (zh ? '已停止' : 'Stopped') : (zh ? '注册中' : 'Registering');
        const title = activity.name || activity.id;
        return <button key={execution.id} type="button" className="tool-preview-card loop-registration-preview" data-execution-id={execution.id}
          title={`${title} · ${status}`} disabled={!saved} onClick={() => open({ kind: 'agent-definition', sessionId,
            entity: kind, entityId: activity.id, title })}>
          <span className="tool-preview-icon" aria-hidden="true"><Icon size={16} /></span>
          <span className="tool-preview-content"><strong>{title}</strong><small>{status}</small></span>
          {saved && <ChevronRight size={14} aria-hidden="true" />}
        </button>;
      })}
    </LoopPreviewGroup>;
  })}</>;
}
