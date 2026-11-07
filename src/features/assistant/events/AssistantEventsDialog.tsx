import { useRef, useState } from 'react';
import { AssistantEventsDialogView } from './AssistantEventsDialogView';
import { eventBackend } from './eventBackend';
import { previousEventHistory } from './eventPreferences';
import { useEventExecution } from './useEventExecution';

export function AssistantEventsDialog({ language, close }: { language: string; close(): void }) {
  const { snapshot, refresh, error } = useEventExecution(true);
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
  return <AssistantEventsDialogView language={language} snapshot={snapshot} event={event} draft={draft} history={previousEventHistory()}
    pending={pending} failed={error || failed} onClose={close} onSelect={select} onEdit={edit} onSubmit={submit} onRefresh={refresh}
    onManage={action => { if (event) void run(() => eventBackend.manage(action, event.id)); }}/>;
}
