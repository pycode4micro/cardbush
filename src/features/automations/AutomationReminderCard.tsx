import { uiText } from '../../i18n';
import { Bell } from 'lucide-react';
import type { AutomationReminder } from '@cardbush/bush-protocol';
import { openAutomationRun } from './automationEvents';
import './automations.css';

export function AutomationReminderCard({ value, language }: { value: unknown; language: string }) {
  if (!value || typeof value !== 'object') return null;
  const reminder = value as AutomationReminder;
  if (!Number.isInteger(reminder.total) || reminder.total < 1 || !Array.isArray(reminder.items)) return null;

  return <details className="automation-reminder">
    <summary><Bell size={13}/>{uiText(language)('automationReminderCard.unreadScheduledResultsWhenSent', { value1: reminder.total })}</summary>
    <p>{uiText(language)('automationReminderCard.includedAsAppContextOpeningAResult')}</p>
    {reminder.items.slice(0, 8).filter(item => item && typeof item.runId === 'string' && typeof item.jobId === 'string' && typeof item.title === 'string').map(item =>
      <button key={item.runId} type="button" onClick={() => openAutomationRun(item.jobId, item.runId, item.title)}>{item.title}<span>{item.finishedAt ? new Date(item.finishedAt).toLocaleString(language) : ''}</span></button>)}
    {reminder.total > reminder.items.length && <p>{uiText(language)('automationReminderCard.moreInAutomations', { value1: reminder.total - reminder.items.length })}</p>}
  </details>;
}
