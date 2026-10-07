import { Volume2, VolumeX } from 'lucide-react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from '../inspector/InspectorWebview';

export function BrowserTabAudioButton({ navigation, handle, language, title, menu = false }: {
  navigation?: InspectorNavigationState;
  handle?: InspectorWebviewHandle;
  language: AppLanguage;
  title: string;
  menu?: boolean;
}) {
  // Keep an explicitly muted tab recoverable even after its sound stops.
  if ((!navigation?.audible && !navigation?.audioMuted) || !handle?.toggleAudioMuted) return null;
  const muted = Boolean(navigation.audioMuted);
  const label = muted
    ? language === 'zh' ? '取消标签页静音' : 'Unmute tab'
    : language === 'zh' ? '将标签页静音' : 'Mute tab';
  return <button type="button" className={`right-inspector-tab-audio${muted ? ' muted' : ''}`}
    title={label} aria-label={`${label} · ${title}`} role={menu ? 'menuitemcheckbox' : undefined}
    aria-checked={menu ? muted : undefined} aria-pressed={menu ? undefined : muted}
    onPointerDown={event => event.stopPropagation()} onAuxClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); handle.toggleAudioMuted?.(); }}>
    {muted ? <VolumeX size={14} aria-hidden="true"/> : <Volume2 size={14} aria-hidden="true"/>}
  </button>;
}
