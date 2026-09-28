import { useEffect, useState } from 'react';
import { Volume2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { playNotificationSound, readNotificationSoundPreferences, saveNotificationSoundPreferences,
  subscribeNotificationSoundPreferences, type NotificationSoundPreferences } from '../notificationSound';
import { SettingsCard, SettingsSwitch } from './SettingsControls';

export function NotificationSoundSettings({ language }: { language: AppLanguage }) {
  const zh = language === 'zh';
  const [preferences, setPreferences] = useState(readNotificationSoundPreferences);
  const [testing, setTesting] = useState(false), [error, setError] = useState('');
  useEffect(() => subscribeNotificationSoundPreferences(() => setPreferences(readNotificationSoundPreferences())), []);
  const update = (patch: Partial<NotificationSoundPreferences>) => {
    setError(''); saveNotificationSoundPreferences({ ...readNotificationSoundPreferences(), ...patch });
  };
  const preview = async () => {
    setTesting(true); setError('');
    if (!await playNotificationSound(true)) setError(zh ? '暂时无法播放，请检查音频设备后重试。' : 'Unable to play. Check your audio device and try again.');
    setTesting(false);
  };
  return <SettingsCard title={zh ? '消息提醒' : 'Message notifications'}>
    <SettingsSwitch title={zh ? '提醒音效' : 'Notification sound'} checked={preferences.enabled}
      subtitle={zh ? '回复完成、需要确认或发生错误时播放一次，当前会话也会提醒。' : 'Play once when a response finishes, needs your input, or encounters an error, including the current chat.'}
      onChange={enabled => update({ enabled })} />
    <div className="settings-value-row notification-sound-controls">
      <label htmlFor="notification-sound-volume">{zh ? '音量' : 'Volume'}</label>
      <input id="notification-sound-volume" type="range" min="0" max="100" step="5" value={preferences.volume}
        aria-valuetext={preferences.volume + '%'} onChange={event => update({ volume: Number(event.currentTarget.value) })}/>
      <output htmlFor="notification-sound-volume">{preferences.volume}%</output>
      <button type="button" className="secondary-button" disabled={testing || preferences.volume === 0} onClick={() => void preview()}>
        <Volume2 size={14}/>{zh ? '试听' : 'Preview'}
      </button>
    </div>
    {error && <p className="settings-inline-error" role="status">{error}</p>}
  </SettingsCard>;
}
