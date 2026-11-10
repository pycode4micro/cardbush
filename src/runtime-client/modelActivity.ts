import { uiText } from '../i18n';
import { providerStreamActivity, providerActivityLabel, type ProviderActivity, type RuntimeEvent } from '@cardbush/bush-protocol';

type Activity = ProviderActivity | 'compacting' | 'retrying' | '';
type TurnActivity = { activity: Activity; compacting: boolean; startedAt?: string; completedAt?: string };
const turns = new Map<string, TurnActivity>();
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
  let startedAt = previous?.startedAt, completedAt = previous?.completedAt;
  if (event.kind === 'turn_terminal') {
    // History and tool receipts may arrive later. Stop the visible clock as
    // soon as the terminal event arrives, including during reconnect.
    completedAt ??= event.payload.completedAt ?? event.createdAt;
    compacting = false;
    activity = '';
  }
  else if (event.kind === 'turn_accepted') startedAt ??= event.payload.startedAt ?? event.createdAt;
  else if (completedAt) return;
  else if (event.kind === 'context_compaction_started') { compacting = true; activity = 'compacting'; }
  else if (['context_compaction_completed', 'context_compaction_failed', 'context_compaction_cancelled'].includes(event.kind)) { compacting = false; activity = ''; }
  else if (event.kind === 'provider_stream_diagnostic') activity = compacting ? 'compacting' : providerStreamActivity(event.payload) ?? '';
  else if (event.kind === 'provider_retry') activity = 'retrying';
  else if (event.kind === 'turn_started') { startedAt ??= event.createdAt; activity = 'waiting'; }
  else if (event.kind === 'tool_queued' || event.kind === 'tool_running') activity = '';
  else return;
  if (previous?.activity === activity && previous.compacting === compacting &&
      previous.startedAt === startedAt && previous.completedAt === completedAt) return;
  turns.set(event.turnId, { activity, compacting, startedAt, completedAt });
  if (turns.size > 128) turns.delete(turns.keys().next().value!);
  notify();
}

export function subscribeModelActivity(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function modelActivityForTurn(turnId: string | undefined) { return turnId ? turns.get(turnId) : undefined; }
export function modelActivityLabel(turnId: string | undefined, language: string): string {
  const activity = turnId ? turns.get(turnId)?.activity : undefined;
  if (!activity) return '';
  if (activity === 'compacting') return uiText(language)('modelActivity.compactingContext');
  if (activity === 'retrying') return uiText(language)('modelActivity.waitingToRetry');
  return providerActivityLabel(activity, language);
}
