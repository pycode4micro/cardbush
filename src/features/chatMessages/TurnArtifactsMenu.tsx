import { Archive, LoaderCircle, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { AppLanguage } from '../../types';
import { FileTypeIcon } from './FileTypeIcon';
import './turn-artifacts.css';

export interface TurnArtifactEntry {
  path: string;
  name: string;
  additions?: number;
  deletions?: number;
  mediaType?: 'image' | 'video' | 'audio';
}

export function TurnArtifactsMenu({ items, language, reverted, busy, onRevert, onOpen, onContextMenu }: {
  items: TurnArtifactEntry[];
  language: AppLanguage;
  reverted: boolean;
  busy: boolean;
  onRevert?: () => Promise<void>;
  onOpen: (item: TurnArtifactEntry) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>, item: TurnArtifactEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = language === 'zh' ? '本轮产物' : 'Turn artifacts';
  const actionLabel = reverted ? (language === 'zh' ? '撤销撤回' : 'Undo revert') : (language === 'zh' ? '撤回' : 'Revert');
  const close = (focus = false) => {
    menu.current?.hidePopover(); setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const margin = 12, gap = 6;
    const width = Math.min(310, window.innerWidth - margin * 2);
    const above = rect.top - gap - margin, below = window.innerHeight - rect.bottom - gap - margin;
    const upwards = below < Math.min(336, (items.length + 1) * 38 + 12) && above > below;
    Object.assign(menu.current.style, {
      left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
      top: `${upwards ? rect.top - gap : rect.bottom + gap}px`,
      width: `${width}px`, maxHeight: `${Math.min(336, Math.max(40, upwards ? above : below))}px`,
      translate: upwards ? '0 -100%' : 'none',
    });
    menu.current.showPopover();
    menu.current.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, items.length]);
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

  return <div className="turn-artifacts">
    <button ref={trigger} className="turn-artifacts-trigger" type="button" aria-label={`${label} (${items.length})`}
      title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      onClick={() => open ? close() : setOpen(true)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}><Archive size={14} /><span>{language === 'zh' ? '产物' : 'Artifacts'}</span><small>{items.length}</small></button>
    <div ref={menu} id={menuId} popover="auto" role="menu" aria-label={label} className="turn-artifacts-popover"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
        const button = buttons[next], list = menu.current;
        if (button && list) {
          if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop - 5;
          else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight + 5;
        }
      }}>
      {open && <>
        {onRevert && <>
          <button className={`turn-artifacts-revert${reverted ? ' is-restoring' : ''}`} type="button" role="menuitem"
            disabled={working || busy} onClick={async () => {
              setWorking(true); setError('');
              try { await onRevert(); }
              catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
              finally { setWorking(false); }
            }}>
            {working ? <LoaderCircle size={15} className="spin" /> : reverted ? <Redo2 size={15} /> : <Undo2 size={15} />}
            <span>{actionLabel}</span>
          </button>
          <div className="turn-artifacts-divider" role="separator" />
        </>}
        {error && <p className="turn-artifacts-error" role="alert">{error}</p>}
        {items.map(item => <button key={item.path} className="turn-artifacts-file" type="button" role="menuitem"
          title={item.path} onContextMenu={onContextMenu ? event => onContextMenu(event, item) : undefined}
          onClick={() => { close(true); onOpen(item); }}>
          <FileTypeIcon path={item.path} fileName={item.name} mediaType={item.mediaType} />
          <span>{item.name}</span>
          {(Boolean(item.additions) || Boolean(item.deletions)) && <small>
            {!!item.additions && <em className="additions">+{item.additions}</em>}
            {!!item.deletions && <em className="deletions">-{item.deletions}</em>}
          </small>}
        </button>)}
      </>}
    </div>
  </div>;
}
