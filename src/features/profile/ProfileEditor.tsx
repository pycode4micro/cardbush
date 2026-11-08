import { useRef, useState } from 'react';
import { prepareAvatarImage } from '../../shared/avatarImage';
import type { PersonalProfile } from '@cardbush/bush-protocol';
import { savePersonalProfile, readPersonalProfile } from '../../backend/personalization';
import { ProfileEditorView } from './ProfileEditorView';

export function ProfileEditor({ language, initial, suggestion, close, saved }: {
  language: string; initial: PersonalProfile | null; suggestion: string; close(): void; saved(value: PersonalProfile): void;
}) {
  const [base, setBase] = useState(initial), [name, setName] = useState(initial?.preferredName ?? suggestion);
  const [habits, setHabits] = useState(initial?.habits ?? ''), [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState(initial?.avatar), [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState(''), selection = useRef(0);
  const chooseAvatar = async (file?: File) => {
    const request = ++selection.current;
    setImageError(''); setPreparing(Boolean(file));
    if (!file) { setAvatar(undefined); return; }
    try {
      const image = await prepareAvatarImage(file, language);
      if (request === selection.current) setAvatar(image);
    } catch (cause) {
      if (request === selection.current) setImageError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request === selection.current) setPreparing(false); }
  };
  const [error, setError] = useState<'profile.saveFailed' | 'profile.conflict'>();
  const submit = async () => {
    if (busy || preparing) return;
    setBusy(true); setError(undefined);
    try { saved(await savePersonalProfile({ preferredName:name.trim(), habits:habits.trim(), ...(avatar ? {avatar} : {}) }, base)); close(); }
    catch (cause) {
      if (String(cause).includes('personal_profile_changed')) {
        try { const latest = await readPersonalProfile(); setBase(latest); setName(latest?.preferredName ?? ''); setHabits(latest?.habits ?? ''); setAvatar(latest?.avatar); setError('profile.conflict'); }
        catch { setError('profile.saveFailed'); }
      } else setError('profile.saveFailed');
    } finally { setBusy(false); }
  };
  return <ProfileEditorView language={language} name={name} habits={habits} busy={busy} error={error}
    avatar={avatar} preparing={preparing} imageError={imageError} onAvatar={chooseAvatar}
    onName={setName} onHabits={setHabits} close={close} submit={submit}/>;
}
