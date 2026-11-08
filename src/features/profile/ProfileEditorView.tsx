import { useId, useRef } from 'react';
import { UserRound } from 'lucide-react';
import { uiText } from '../../i18n';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';

export function ProfileEditorView({ language, name, habits, avatar, preparing, imageError, busy, error, onName, onHabits, onAvatar, close, submit }: {
  language: string; name: string; habits: string; busy: boolean; error?: 'profile.saveFailed' | 'profile.conflict';
  onName(value: string): void; onHabits(value: string): void; close(): void; submit(): Promise<void>;
  avatar?: string; preparing: boolean; imageError: string; onAvatar(file?: File): void;
}) {
  const t = uiText(language), hintId = useId(), picker = useRef<HTMLInputElement>(null);
  return <SettingsFormDialog language={language} className="profile-editor" title={t('profile.edit')} busy={busy} onCancel={close} onSubmit={submit}
    footer={<><button className="secondary-button" type="button" disabled={busy} onClick={close}>{t('agentConnectionForm.cancel')}</button><button className="primary-button" type="submit" disabled={busy || preparing}>{t('appCenter.save')}</button></>}>
    <fieldset className="settings-dialog-fields" disabled={busy}>
      <div className="profile-photo-row">
        <span className="profile-photo-preview">{avatar ? <img src={avatar} alt=""/> : <UserRound aria-hidden="true"/>}</span>
        <div className="profile-photo-options">
          <div><button className="secondary-button" type="button" onClick={() => picker.current?.click()}>{t(preparing ? 'assistantSettingsDialog.preparing' : 'assistantSettingsDialog.changeAvatar')}</button>
            {avatar && <button className="profile-photo-remove" type="button" onClick={() => onAvatar()}>{t('profile.removeAvatar')}</button>}</div>
          <small>{t('assistantSettingsDialog.pngJpgWebpUpTo8Mb')}</small>
        </div>
      </div>
      {imageError && <p className="settings-inline-error" role="alert">{imageError}</p>}
      <label className="settings-field">{t('profile.name')}<input name="preferredName" autoComplete="nickname" maxLength={80} value={name} onChange={e => onName(e.target.value)}/></label>
      <div className="settings-field"><label htmlFor={hintId+'-habits'}>{t('profile.habits')}</label>
        <textarea id={hintId+'-habits'} name="habits" rows={3} maxLength={1600} aria-describedby={hintId} value={habits} onChange={e => onHabits(e.target.value)}/>
        <small id={hintId}>{t('profile.habitsHint')}</small></div>
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={t('assistantSettingsDialog.chooseImage')} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) onAvatar(file);
      }}/>
      {error && <p className="settings-inline-error" role="alert">{t(error)}</p>}
    </fieldset>
  </SettingsFormDialog>;
}
