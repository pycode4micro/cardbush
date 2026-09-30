import { Check, MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import './queueActions.css';

export function QueueActionsMenu({ language, locked, lockPending = false, onToggleLock,
  busy = false, onEdit, onMoveUp, onMoveDown,
}: {
  language: AppLanguage;
  locked: boolean;
  lockPending?: boolean;
  onToggleLock?: () => void;
  busy?: boolean;
  onEdit?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const shortcuts = useKeyboardShortcuts();
  const label = language === 'zh' ? '更多引导操作' : 'More guidance actions';
  const close = (focus = false) => {
    menu.current?.hidePopover();
    setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  const choose = (action?: () => void) => { close(true); action?.(); };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const margin = 12, gap = 6;
    const width = Math.min(220, window.innerWidth - margin * 2);
    const above = rect.top - gap - margin, below = window.innerHeight - rect.bottom - gap - margin;
    const upwards = below < 190 && above > below;
    Object.assign(menu.current.style, {
      left: `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`,
      top: `${upwards ? rect.top - gap : rect.bottom + gap}px`,
      width: `${width}px`, maxHeight: `${Math.max(60, upwards ? above : below)}px`,
      translate: upwards ? '0 -100%' : 'none',
    });
    menu.current.showPopover();
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const node = menu.current;
    const sync = (event: Event) => { if ((event as ToggleEvent).newState === 'closed') setOpen(false); };
    node?.addEventListener('toggle', sync);
    return () => node?.removeEventListener('toggle', sync);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', dismiss, true); };
  }, [open]);

  return <>
    <button ref={trigger} type="button" className={`queue-actions-trigger${locked ? ' is-locked' : ''}`}
      aria-label={label} title={locked ? `${label} · ${language === 'zh' ? '已锁定' : 'Locked'}` : label}
      aria-haspopup="menu" aria-controls={menuId} aria-expanded={open}
      onClick={() => open ? close() : setOpen(true)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}><MoreHorizontal size={16} aria-hidden="true" /></button>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-label={label} className="queue-actions-popover"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}>
      {open && <>
        {onToggleLock && <button type="button" role="menuitemcheckbox" aria-checked={locked}
          data-queue-action="lock" disabled={lockPending} aria-busy={lockPending}
          aria-keyshortcuts={shortcuts.aria('toggleQueueLock')}
          title={[language === 'zh' ? '暂停自动发送，仍可手动发送' : 'Pause automatic sending; manual sending stays available', shortcuts.label('toggleQueueLock')].filter(Boolean).join(' · ')}
          onClick={() => choose(onToggleLock)}>
          <span className="queue-menu-label">{language === 'zh' ? '锁定引导队列' : 'Lock guidance queue'}</span>
          {locked && <Check size={14} aria-hidden="true" />}
        </button>}
        {onEdit && <button type="button" role="menuitem" data-queue-action="edit" disabled={busy} onClick={() => choose(onEdit)}>
          <span className="queue-menu-label">{language === 'zh' ? '编辑' : 'Edit'}</span>
        </button>}
        {(onMoveUp || onMoveDown) && <>
          <div className="queue-menu-divider" role="separator" />
          <button type="button" role="menuitem" data-queue-action="up" disabled={busy || !onMoveUp} onClick={() => choose(onMoveUp)}>
            <span className="queue-menu-label">{language === 'zh' ? '上移' : 'Move up'}</span>
          </button>
          <button type="button" role="menuitem" data-queue-action="down" disabled={busy || !onMoveDown} onClick={() => choose(onMoveDown)}>
            <span className="queue-menu-label">{language === 'zh' ? '下移' : 'Move down'}</span>
          </button>
        </>}
      </>}
    </div>
  </>;
}
