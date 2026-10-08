import { Lock, LockOpen } from 'lucide-react';
import type { AppLanguage } from '../../types';

export function InspectorTabLock({ language, locked, onToggle }: { language: AppLanguage; locked: boolean; onToggle(): void }) {
  return <button type="button" className={`right-inspector-tab-lock${locked ? ' locked' : ''}`}
    aria-pressed={locked} aria-label={language === 'zh' ? (locked ? '解锁标签页' : '锁定标签页，跨会话保留') : (locked ? 'Unlock tab' : 'Lock tab across conversations')}
    onClick={onToggle}>{locked ? <Lock size={12} aria-hidden="true" /> : <LockOpen size={12} aria-hidden="true" />}</button>;
}
