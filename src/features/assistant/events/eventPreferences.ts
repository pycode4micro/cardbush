import { assistantEventPreferencesSchema, type AssistantEventPreferences } from '@cardbush/bush-protocol';

export const emptyEventPreferences = (): AssistantEventPreferences => ({ recognition: {}, beforeExecution: 'ask', report: 'important' });
type PreviousEvent = { id: string; text: string; createdAt: string; archived: boolean };
type PreviousProfile = { version?: number; introduction?: { answers?: Record<string, string>; confirmedAt?: string };
  delegation?: Partial<AssistantEventPreferences>; events?: PreviousEvent[] };

function previousProfile(): PreviousProfile | undefined {
  try {
    const old = JSON.parse(localStorage.getItem('cardbush_your_friends_v1') ?? 'null');
    return old && [1, 2].includes(old.version) ? old : undefined;
  } catch { return; }
}
export function inheritedPreferences() {
  const old = previousProfile();
  if (!old?.introduction) return;
  const value = assistantEventPreferencesSchema.safeParse({
    ...emptyEventPreferences(), recognition: old.introduction.answers ?? {}, confirmedAt: old.introduction.confirmedAt,
    beforeExecution: old.delegation?.beforeExecution ?? 'ask', report: old.delegation?.report ?? 'important',
  });
  return value.success ? value.data : undefined;
}
// The interview journal predates Runtime events. Keep it readable without replaying it.
export function previousEventHistory(): PreviousEvent[] {
  const events = previousProfile()?.events;
  return Array.isArray(events) ? events.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string') : [];
}
