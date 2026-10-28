import { uiText } from '../../i18n';
import { Lock, LockOpen } from 'lucide-react';
import type { AppLanguage } from '../../types';

export function InspectorTabLock({ language, locked, onToggle, contextMenu = false }: {
  language: AppLanguage; locked: boolean; onToggle(): void; contextMenu?: boolean;
}) {
  const label = (locked ? uiText(language)('inspectorTabLock.unlockTab') : uiText(language)('inspectorTabLock.lockTab'));
  return <button type="button" className={contextMenu ? 'right-inspector-tab-context-action' : `right-inspector-tab-lock${locked ? ' locked' : ''}`}
    role={contextMenu ? 'menuitemcheckbox' : undefined} aria-checked={contextMenu ? locked : undefined}
    aria-pressed={contextMenu ? undefined : locked}
    aria-label={locked ? label : uiText(language)('inspectorTabLock.lockTabAcrossConversations')}
    onClick={onToggle}>
    {locked ? <Lock size={12} aria-hidden="true" /> : <LockOpen size={12} aria-hidden="true" />}
    {contextMenu && <span>{label}</span>}
  </button>;
}
