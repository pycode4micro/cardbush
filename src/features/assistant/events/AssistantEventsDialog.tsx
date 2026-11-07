import { useRef, useState } from 'react';
import { uiText } from '../../../i18n';
import { SettingsFormDialog } from '../../settings/SettingsFormDialog';
import { FriendsEventDetails, FriendsExecutionRequests } from './EventDetails';
import { eventBackend } from './eventBackend';
import { previousEventHistory } from './eventPreferences';
import { useEventExecution } from './useEventExecution';

export function AssistantEventsDialog({ language, close }: { language: string; close(): void }) {
  const t = uiText(language), { snapshot, refresh, error } = useEventExecution(true);
  const [selected, select] = useState(''), [draft, edit] = useState(''), [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  const retry = useRef<Parameters<typeof eventBackend.submit>[0] | undefined>(undefined);
  const event = snapshot?.events.find(item => item.id === selected);
  const run = async (work: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setFailed(false);
    try { await work(); await refresh(); } catch { setFailed(true); } finally { setPending(false); }
  };
  const submit = () => run(async () => {
    if (!draft.trim()) return;
    const input = retry.current?.text === draft && retry.current.relatesTo === event?.id ? retry.current :
      { id: crypto.randomUUID(), text: draft, createdAt: new Date().toISOString(), relatesTo: event?.id };
    retry.current = input;
    await eventBackend.submit(input); retry.current = undefined; edit(''); select(event?.id ?? input.id);
  });
  const history = previousEventHistory();
  return <SettingsFormDialog className="assistant-events-dialog" title={t('assistant.events.title')} language={language} onCancel={close} busy={pending} onSubmit={submit}
    footer={<><button type="button" onClick={close}>{t('common.close')}</button><button type="submit" disabled={pending || !draft.trim()}>{t(event ? 'yourFriends.continue' : 'assistant.events.create')}</button></>}>
    <label>{t('yourFriends.events')}<select disabled={pending} value={selected} onChange={e => select(e.target.value)}>
      <option value="">{t('assistant.events.create')}</option>
      {[...(snapshot?.events ?? [])].reverse().map(item => <option key={item.id} value={item.id}>{item.title} · {t(`yourFriends.status.${item.status}`)}</option>)}
    </select></label>
    {event && <><FriendsEventDetails event={event} snapshot={snapshot} language={language}/>
      <div className="assistant-event-actions">{(['pause', 'resume', event.archived ? 'restore' : 'archive'] as const).map(action =>
        <button type="button" key={action} disabled={pending || (action === 'resume' && event.status === 'running')} onClick={() => void run(() => eventBackend.manage(action, event.id))}>{t(action === 'pause' ? 'yourFriends.pauseExecution' : action === 'resume' ? 'yourFriends.resumeExecution' : action === 'restore' ? 'yourFriends.restore' : 'yourFriends.archive')}</button>)}</div></>}
    <label>{t(event ? 'yourFriends.continue' : 'assistant.events.intent')}<textarea disabled={pending} rows={3} maxLength={8000} value={draft} onChange={e => edit(e.target.value)}/></label>
    {!!(snapshot?.permissions.length || snapshot?.solutions.length) && <FriendsExecutionRequests snapshot={snapshot} language={language} refresh={refresh}/>}
    {!!history.length && <details><summary>{t('assistant.events.previous')}</summary>{history.map(item => <p key={item.id}>{item.text}</p>)}</details>}
    {(error || failed) && <p role="alert">{t('yourFriends.executionActionFailed')}</p>}
  </SettingsFormDialog>;
}
