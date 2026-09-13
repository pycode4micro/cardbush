import type { AppLanguage } from '../../types';

export function automationSetupPrompt(language: AppLanguage): string {
  return language === 'zh'
    ? '我想创建一个定时任务，请通过对话帮我完善要执行的内容、时间和重复规则，信息明确后直接使用定时工具完成设置。'
    : 'Help me create a scheduled task through conversation. Ask about the task, timing and recurrence as needed, then use the scheduling tool to save it once the details are clear.';
}
