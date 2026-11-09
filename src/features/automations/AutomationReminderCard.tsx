import { uiText } from '../../i18n';
import { Bell } from 'lucide-react';
import type { AutomationReminder } from '@cardbush/bush-protocol';
import { EventResultDisclosure, type ResultContentView } from './EventResultDisclosure';
import './automations.css';

export function AutomationReminderCard({ value, language, ResultContent }: { value: unknown; language: string; ResultContent: ResultContentView }) {
  if (!value || typeof value !== 'object') return null;
  const reminder = value as AutomationReminder;
  if (!Number.isInteger(reminder.total) || reminder.total < 1 || !Array.isArray(reminder.items)) return null;

  return <details className="automation-reminder">
    <summary><Bell size={13}/>{uiText(language)('automationReminderCard.unreadScheduledResultsWhenSent', { value1: reminder.total })}</summary>
    {reminder.items.slice(0, 8).filter(item => item && typeof item.runId === 'string' && typeof item.jobId === 'string' && typeof item.title === 'string').map(item =>
      <EventResultDisclosure key={item.runId} jobId={item.jobId} runId={item.runId} language={language} ResultContent={ResultContent}>
        {item.title}{item.finishedAt && <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString(language)}</time>}
      </EventResultDisclosure>)}
    {reminder.total > reminder.items.length && <p>{uiText(language)('automationReminderCard.moreInAutomations', { value1: reminder.total - reminder.items.length })}</p>}
  </details>;
}
