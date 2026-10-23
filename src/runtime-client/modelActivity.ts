import { providerStreamActivity, providerActivityLabel, type ProviderActivity, type RuntimeEvent } from '@cardbush/bush-protocol';

type Activity = ProviderActivity | 'compacting' | 'retrying' | '';
const turns = new Map<string, { activity: Activity; compacting: boolean }>();
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('Model activity observer failed', error); }
  }
}

// Ephemeral presentation only; these facts never become assistant content or
// model context. Turn IDs survive cursor reattachment and are globally unique.
export function publishModelActivity(event: RuntimeEvent): void {
  const previous = turns.get(event.turnId);
  let activity = previous?.activity ?? '', compacting = previous?.compacting ?? false;
  if (event.kind === 'turn_terminal') { if (turns.delete(event.turnId)) notify(); return; }
  if (event.kind === 'context_compaction_started') { compacting = true; activity = 'compacting'; }
  else if (['context_compaction_completed', 'context_compaction_failed', 'context_compaction_cancelled'].includes(event.kind)) { compacting = false; activity = ''; }
  else if (event.kind === 'provider_stream_diagnostic') activity = compacting ? 'compacting' : providerStreamActivity(event.payload) ?? '';
  else if (event.kind === 'provider_retry') activity = 'retrying';
  else if (event.kind === 'turn_started') activity = 'waiting';
  else if (event.kind === 'tool_queued' || event.kind === 'tool_running') activity = '';
  else return;
  if (previous?.activity === activity && previous.compacting === compacting) return;
  turns.set(event.turnId, { activity, compacting });
  if (turns.size > 128) turns.delete(turns.keys().next().value!);
  notify();
}

export function subscribeModelActivity(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function modelActivityLabel(turnId: string | undefined, language: 'zh' | 'en'): string {
  const activity = turnId ? turns.get(turnId)?.activity : undefined;
  if (!activity) return '';
  if (activity === 'compacting') return language === 'zh' ? '整理上下文' : 'Compacting context';
  if (activity === 'retrying') return language === 'zh' ? '等待重试' : 'Waiting to retry';
  return providerActivityLabel(activity, language);
}
