import type { AppLanguage, ChatToolExecution } from '../../types';
import { assistantRunActivity } from './assistantRunActivity';

export function AssistantActivityDetails({ executions, language }: {
  executions: ChatToolExecution[]; language: AppLanguage;
}) {
  const activity = assistantRunActivity(executions);
  const names = (items: ChatToolExecution[]) => items.map(item => item.summary || item.name).join(' · ');
  if (!executions.length) return null;
  return <div className="assistant-run-activity">
    {activity.waiting.length > 0 && <span className="awaiting-permission" title={names(activity.waiting)}>
      {language === 'zh' ? `待确认 ${activity.waiting.length} 项` : `${activity.waiting.length} awaiting approval`}
      {' · '}{activity.waiting[0].summary || activity.waiting[0].name}
    </span>}
    {activity.running.length > 0 && <span title={names(activity.running)}>
      {language === 'zh' ? `工具执行中 ${activity.running.length} 项` : `${activity.running.length} tools executing`}
      {' · '}{activity.running[0].summary || activity.running[0].name}
    </span>}
    {activity.observedRunningTerminals > 0 && <span>
      {language === 'zh' ? `后台终端：${activity.observedRunningTerminals} 个最近报告仍在运行`
        : `Background terminals: ${activity.observedRunningTerminals} last reported running`}
    </span>}
    {activity.lastToolEventAt && <span className="last-tool-event">
      {language === 'zh' ? '最近工具事件 ' : 'Last tool event '}
      {new Date(activity.lastToolEventAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-GB', { hour12: false })}
    </span>}
  </div>;
}
