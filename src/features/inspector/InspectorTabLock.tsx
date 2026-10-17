import { Lock, LockOpen } from 'lucide-react';
import type { AppLanguage } from '../../types';

export function InspectorTabLock({ language, locked, onToggle, contextMenu = false }: {
  language: AppLanguage; locked: boolean; onToggle(): void; contextMenu?: boolean;
}) {
  const label = language === 'zh' ? (locked ? '解锁标签页' : '锁定标签页') : (locked ? 'Unlock tab' : 'Lock tab');
  return <button type="button" className={contextMenu ? 'right-inspector-tab-context-action' : `right-inspector-tab-lock${locked ? ' locked' : ''}`}
    role={contextMenu ? 'menuitemcheckbox' : undefined} aria-checked={contextMenu ? locked : undefined}
    aria-pressed={contextMenu ? undefined : locked}
    aria-label={locked ? label : language === 'zh' ? '锁定标签页，跨会话保留' : 'Lock tab across conversations'}
    onClick={onToggle}>
    {locked ? <Lock size={12} aria-hidden="true" /> : <LockOpen size={12} aria-hidden="true" />}
    {contextMenu && <span>{label}</span>}
  </button>;
}
