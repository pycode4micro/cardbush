import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { Volume2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { playNotificationSound, readNotificationSoundPreferences, saveNotificationSoundPreferences,
  subscribeNotificationSoundPreferences, type NotificationSoundPreferences } from '../notificationSound';
import { SettingsCard, SettingsSwitch } from './SettingsControls';

export function NotificationSoundSettings({ language }: { language: AppLanguage }) {

  const [preferences, setPreferences] = useState(readNotificationSoundPreferences);
  const [testing, setTesting] = useState(false), [error, setError] = useState('');
  useEffect(() => subscribeNotificationSoundPreferences(() => setPreferences(readNotificationSoundPreferences())), []);
  const update = (patch: Partial<NotificationSoundPreferences>) => {
    setError(''); saveNotificationSoundPreferences({ ...readNotificationSoundPreferences(), ...patch });
  };
  const preview = async () => {
    setTesting(true); setError('');
    if (!await playNotificationSound(true)) setError(uiText(language)('notificationSoundSettings.unableToPlayCheckYourAudioDevice'));
    setTesting(false);
  };
  return <SettingsCard title={uiText(language)('notificationSoundSettings.messageNotifications')}>
    <SettingsSwitch title={uiText(language)('notificationSoundSettings.notificationSound')} checked={preferences.enabled}
      subtitle={uiText(language)('notificationSoundSettings.playOnceWhenAResponseFinishesNeeds')}
      onChange={enabled => update({ enabled })} />
    <div className="settings-value-row notification-sound-controls">
      <label htmlFor="notification-sound-volume">{uiText(language)('notificationSoundSettings.volume')}</label>
      <input id="notification-sound-volume" type="range" min="0" max="100" step="5" value={preferences.volume}
        aria-valuetext={preferences.volume + '%'} onChange={event => update({ volume: Number(event.currentTarget.value) })}/>
      <output htmlFor="notification-sound-volume">{preferences.volume}%</output>
      <button type="button" className="secondary-button" disabled={testing || preferences.volume === 0} onClick={() => void preview()}>
        <Volume2 size={14}/>{uiText(language)('notificationSoundSettings.preview')}
      </button>
    </div>
    {error && <p className="settings-inline-error" role="status">{error}</p>}
  </SettingsCard>;
}
