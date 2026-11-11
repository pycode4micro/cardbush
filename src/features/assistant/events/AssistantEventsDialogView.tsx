import { ArrowUpRight, ChevronRight, History, Plus } from 'lucide-react';
import type { FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../../i18n';
import { SettingsFormDialog } from '../../settings/SettingsFormDialog';
import { SettingsDropdown } from '../../settings/SettingsDropdown';
import { FriendsEventDetails, FriendsExecutionRequests } from './EventDetails';
import type { previousEventHistory } from './eventPreferences';
import { eventActionLabels, type EventAction } from './eventManagement';
import './assistantEventsDialog.css';

type Props = {
  language: string; snapshot?: FriendsSnapshot; event?: FriendsWorkEvent; draft: string;
  history: ReturnType<typeof previousEventHistory>; pending: boolean; failed: boolean;
  onClose(): void; onSelect(id: string): void; onEdit(value: string): void; onSubmit(): Promise<void>;
  onRefresh(): Promise<void>; onManage(action: EventAction): void;
};

export function AssistantEventsDialogView({ language, snapshot, event, draft, history, pending, failed,
  onClose, onSelect, onEdit, onSubmit, onRefresh, onManage }: Props) {
  const t = uiText(language);
  const createLabel = t('assistant.events.create');
  const submitLabel = event ? t('yourFriends.continue') : createLabel;
  const entries = snapshot?.events ?? [];
  const eventActions: EventAction[] = event ? ['pause', 'resume', event.archived ? 'restore' : 'archive', 'delete'] : [];
  if (event?.conversationExecution) eventActions.unshift(['running', 'queued'].includes(event.status) ? 'stop' : 'run');
  const switchLabel = t('assistant.events.switch');
  const footer = <>
    {entries.length > 0 && <SettingsDropdown label={switchLabel} disabled={pending} value={event?.id ?? ''} onChange={onSelect}
      options={[{ value: '', label: createLabel, selectedLabel: switchLabel }, ...[...entries].reverse().map(item => ({
        value: item.id, label: item.title, selectedLabel: switchLabel, description: t(`yourFriends.status.${item.status}`),
      }))]}/>}
    {!event?.conversationExecution?.pluginId && <button className="event-submit" type="submit" disabled={pending || !draft.trim()}>
      {event ? <ArrowUpRight aria-hidden="true"/> : <Plus aria-hidden="true"/>}{submitLabel}
    </button>}
  </>;
  return <SettingsFormDialog className="assistant-events-dialog" title={t('assistant.events.title')} language={language} onCancel={onClose}
    busy={pending} onSubmit={onSubmit} footer={footer}>
    {event && <section className="event-overview">
      <FriendsEventDetails event={event} snapshot={snapshot} language={language}/>
      <div className="event-actions">{eventActions.map(action =>
        <button type="button" key={action} data-action={action} disabled={pending || (action === 'resume' && event.status === 'running')} onClick={() => onManage(action)}>{t(eventActionLabels[action])}</button>)}</div>
    </section>}
    {!event?.conversationExecution?.pluginId && <label className="event-input"><span>{event ? submitLabel : t('assistant.events.intent')}</span>
      <textarea disabled={pending} rows={3} maxLength={8000} value={draft} onChange={e => onEdit(e.target.value)}
        placeholder={event ? undefined : t('assistant.events.example')}/>
    </label>}
    {!!(snapshot?.permissions.length || snapshot?.solutions.length) && <FriendsExecutionRequests snapshot={snapshot} language={language} refresh={onRefresh}/>}
    {history.length > 0 && <details className="event-history">
      <summary><History aria-hidden="true"/><span>{t('assistant.events.previous')}</span><ChevronRight aria-hidden="true"/></summary>
      <ul>{history.map(item => <li key={item.id}>{item.text}</li>)}</ul>
    </details>}
    {failed && <p className="event-error" role="alert">{t('yourFriends.executionActionFailed')}</p>}
  </SettingsFormDialog>;
}
