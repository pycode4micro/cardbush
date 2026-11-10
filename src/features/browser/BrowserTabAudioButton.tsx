import { uiText } from '../../i18n';
import { Volume2, VolumeX } from 'lucide-react';
import type { AppLanguage } from '../../types';
import type { InspectorNavigationState, InspectorWebviewHandle } from '../inspector/InspectorWebview';

export function BrowserTabAudioButton({ navigation, handle, language, title, contextMenu = false, onAction }: {
  navigation?: InspectorNavigationState;
  handle?: InspectorWebviewHandle;
  language: AppLanguage;
  title: string;
  contextMenu?: boolean;
  onAction?: () => void;
}) {
  // Keep an explicitly muted tab recoverable even after its sound stops.
  // The context menu also lets users mute a quiet page before playback starts.
  if (!contextMenu && ((!navigation?.audible && !navigation?.audioMuted) || !handle?.toggleAudioMuted)) return null;
  const muted = Boolean(navigation?.audioMuted);
  const label = muted
    ? uiText(language)('browserTabAudioButton.unmuteTab')
    : uiText(language)('browserTabAudioButton.muteTab');
  return <button type="button" className={contextMenu ? 'right-inspector-tab-context-action' : `right-inspector-tab-audio${muted ? ' muted' : ''}`}
    title={label} aria-label={`${label} · ${title}`} role={contextMenu ? 'menuitemcheckbox' : undefined}
    aria-checked={contextMenu ? muted : undefined} aria-pressed={contextMenu ? undefined : muted}
    disabled={contextMenu && (!handle?.toggleAudioMuted || !navigation?.guestWebContentsId)}
    onPointerDown={event => event.stopPropagation()} onAuxClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); handle?.toggleAudioMuted?.(); onAction?.(); }}>
    {muted ? <VolumeX size={14} aria-hidden="true"/> : <Volume2 size={14} aria-hidden="true"/>}
    {contextMenu && <span>{label}</span>}
  </button>;
}
