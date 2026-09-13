import { Bell } from 'lucide-react';
import type { AutomationReminder } from '@cardbush/bush-protocol';
import { openAutomationRun } from './automationEvents';
import './automations.css';

export function AutomationReminderCard({ value, language }: { value: unknown; language: 'zh' | 'en' }) {
  if (!value || typeof value !== 'object') return null;
  const reminder = value as AutomationReminder;
  if (!Number.isInteger(reminder.total) || reminder.total < 1 || !Array.isArray(reminder.items)) return null;
  const zh = language === 'zh';
  return <details className="automation-reminder">
    <summary><Bell size={13}/>{zh ? `发送时有 ${reminder.total} 条定时结果未读` : `${reminder.total} unread scheduled results when sent`}</summary>
    <p>{zh ? '已附给 agent 作为上下文，查看不会自动标记已读。' : 'Included as app context. Opening a result does not mark it read.'}</p>
    {reminder.items.slice(0, 8).filter(item => item && typeof item.runId === 'string' && typeof item.jobId === 'string' && typeof item.title === 'string').map(item =>
      <button key={item.runId} type="button" onClick={() => openAutomationRun(item.jobId, item.runId, item.title)}>{item.title}<span>{item.finishedAt ? new Date(item.finishedAt).toLocaleString(zh ? 'zh-CN' : 'en-US') : ''}</span></button>)}
    {reminder.total > reminder.items.length && <p>{zh ? `另有 ${reminder.total - reminder.items.length} 条，可在定时页查看。` : `${reminder.total - reminder.items.length} more in Automations.`}</p>}
  </details>;
}
