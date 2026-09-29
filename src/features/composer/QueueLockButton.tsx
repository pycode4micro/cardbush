import { LockKeyhole, LockKeyholeOpen } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';

export function QueueLockButton({ language, locked, pending = false, onToggle }: {
  language: AppLanguage; locked: boolean; pending?: boolean; onToggle?: () => void;
}) {
  const shortcuts = useKeyboardShortcuts();
  const label = language === 'zh'
    ? locked ? '解锁队列，恢复自动发送' : '锁定队列，暂停自动发送'
    : locked ? 'Unlock queue and resume automatic sending' : 'Lock queue and pause automatic sending';
  return <button type="button" className="composer-queue-lock" aria-label={label} aria-pressed={locked}
    aria-busy={pending} aria-keyshortcuts={shortcuts.aria('toggleQueueLock')} disabled={pending || !onToggle}
    title={[label, shortcuts.label('toggleQueueLock')].filter(Boolean).join(' · ')} onClick={onToggle}>
    {locked ? <LockKeyhole size={15} aria-hidden="true" /> : <LockKeyholeOpen size={15} aria-hidden="true" />}
  </button>;
}
