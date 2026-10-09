import type { AppLanguage, SubagentTaskSnapshot } from '../../types';
export { ContactRound as EmployeeIcon } from 'lucide-react';

export function isEmployeeTask(task: Pick<SubagentTaskSnapshot, 'agentProfileId'>) {
  return task.agentProfileId?.startsWith('registered:') === true;
}

export function employeeTaskTitle(task: SubagentTaskSnapshot, language: AppLanguage) {
  return task.agentName || (isEmployeeTask(task) ? task.agentProfileId!.slice('registered:'.length) : '') ||
    task.teamMemberId || (language === 'zh' ? '子 Agent' : 'Subagent');
}
