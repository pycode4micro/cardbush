import { useState } from 'react';
import type { PersonalProfile } from '@cardbush/bush-protocol';
import { savePersonalProfile, readPersonalProfile } from '../../backend/personalization';
import { ProfileEditorView } from './ProfileEditorView';

export function ProfileEditor({ language, initial, suggestion, close, saved }: {
  language: string; initial: PersonalProfile | null; suggestion: string; close(): void; saved(value: PersonalProfile): void;
}) {
  const [base, setBase] = useState(initial), [name, setName] = useState(initial?.preferredName ?? suggestion);
  const [habits, setHabits] = useState(initial?.habits ?? ''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<'profile.saveFailed' | 'profile.conflict'>();
  const submit = async () => {
    setBusy(true); setError(undefined);
    try { saved(await savePersonalProfile({ preferredName:name.trim(), habits:habits.trim() }, base)); close(); }
    catch (cause) {
      if (String(cause).includes('personal_profile_changed')) {
        try { const latest = await readPersonalProfile(); setBase(latest); setName(latest?.preferredName ?? ''); setHabits(latest?.habits ?? ''); setError('profile.conflict'); }
        catch { setError('profile.saveFailed'); }
      } else setError('profile.saveFailed');
    } finally { setBusy(false); }
  };
  return <ProfileEditorView language={language} name={name} habits={habits} busy={busy} error={error}
    onName={setName} onHabits={setHabits} close={close} submit={submit}/>;
}
