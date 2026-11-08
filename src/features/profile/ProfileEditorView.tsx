import { useId } from 'react';
import { uiText } from '../../i18n';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';

export function ProfileEditorView({ language, name, habits, busy, error, onName, onHabits, close, submit }: {
  language: string; name: string; habits: string; busy: boolean; error?: 'profile.saveFailed' | 'profile.conflict';
  onName(value: string): void; onHabits(value: string): void; close(): void; submit(): Promise<void>;
}) {
  const t = uiText(language), hintId = useId();
  return <SettingsFormDialog language={language} className="profile-editor" title={t('profile.edit')} busy={busy} onCancel={close} onSubmit={submit}
    footer={<><button type="button" disabled={busy} onClick={close}>{t('agentConnectionForm.cancel')}</button><button type="submit" disabled={busy}>{t('appCenter.save')}</button></>}>
    <label>{t('profile.name')}<input name="preferredName" autoComplete="nickname" maxLength={80} value={name} onChange={e => onName(e.target.value)}/></label>
    <label>{t('profile.habits')}<textarea name="habits" rows={4} maxLength={1600} aria-describedby={hintId} value={habits} onChange={e => onHabits(e.target.value)}/></label>
    <small id={hintId}>{t('profile.habitsHint')}</small>
    {error && <p role="alert">{t(error)}</p>}
  </SettingsFormDialog>;
}
