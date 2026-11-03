import { useEffect, useState } from 'react';
import { uiText } from '../../i18n';
import { SettingsCard, SettingsInput, SettingsSwitch } from '../settings/SettingsControls';
import { updateFriendsState, useFriendsState } from './friendsStore';

export function YourFriendsSettings({ language }: { language: string }) {
  const t = uiText(language), state = useFriendsState();
  const [name, setName] = useState(state.name), [error, setError] = useState('');
  useEffect(() => setName(state.name), [state.name]);
  const save = (change: Parameters<typeof updateFriendsState>[0]) => {
    try { updateFriendsState(change); setError(''); } catch { setError(t('yourFriends.saveError')); }
  };
  return <SettingsCard title={t('yourFriends.title')} subtitle={t('yourFriends.settingsDescription')}>
    <SettingsInput label={t('yourFriends.nameLabel')} value={name} placeholder={t('yourFriends.title')}
      onChange={value => setName(value.slice(0, 60))}/>
    <button type="button" className="secondary-button" disabled={name.trim() === state.name} onClick={() => save(current => ({ ...current, name: name.trim() }))}>{t('yourFriends.saveName')}</button>
    <SettingsSwitch title={t('yourFriends.defaultEntry')} subtitle={t('yourFriends.defaultEntryDescription')} checked={state.startup}
      onChange={startup => save(current => ({ ...current, startup }))}/>
    <SettingsSwitch title={t('yourFriends.motion')} subtitle={t('yourFriends.motionDescription')} checked={state.motion}
      onChange={motion => save(current => ({ ...current, motion }))}/>
    {error && <p className="your-friends-error" role="alert">{error}</p>}
  </SettingsCard>;
}
