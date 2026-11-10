import type { MouseEventHandler, ReactNode } from 'react';
import type { AppSection } from '../../types';
import type { ShortcutId } from '../shortcuts/keyboardShortcuts';

export function SidebarNavRow({ active, icon, label, onClick, onContextMenu, shortcut, ariaKeyShortcuts, navSection }: {
  active?: boolean; icon: ReactNode; label: string; onClick(): void;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>; shortcut?: ShortcutId; ariaKeyShortcuts?: string;
  navSection: AppSection | 'tabs' | 'projects';
}) {
  return <button type="button" className={active ? 'nav-row active' : 'nav-row'} data-nav-section={navSection}
    data-shortcut={shortcut} aria-keyshortcuts={ariaKeyShortcuts} aria-current={active ? 'page' : undefined}
    aria-label={label} title={label} onClick={onClick} onContextMenu={onContextMenu}>
    <span className="nav-row-icon" aria-hidden="true">{icon}</span><span>{label}</span>
  </button>;
}
