import { MoreHorizontal, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss';
import type { AppLanguage } from '../../types';
import type { AppCenterPreferences } from './appCenterModel';

export function AppCenterSettingsMenu({ language, active, display, onDisplayChange, selectingLocal, onAddLocal, onAddLink }: {
  language: AppLanguage;
  active: boolean;
  display: AppCenterPreferences['display'];
  onDisplayChange: (display: AppCenterPreferences['display']) => void;
  selectingLocal: boolean;
  onAddLocal: () => void;
  onAddLink: () => void;
}) {
  const zh = language === 'zh', label = zh ? '应用中心设置' : 'App center settings';
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const close = useCallback((focus = false) => {
    menu.current?.hidePopover(); setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const containers = useMemo(() => [trigger, menu], []);
  const dismiss = useCallback((event?: Event) => {
    const escape = event instanceof KeyboardEvent && event.key === 'Escape';
    if (escape) { event.preventDefault(); event.stopPropagation(); }
    close(escape);
  }, [close]);
  useOutsideDismiss(open, containers, dismiss);
  useEffect(() => { if (!active) close(); }, [active, close]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect(), width = Math.min(260, innerWidth - 24);
    Object.assign(menu.current.style, { width: `${width}px`, maxHeight: `${innerHeight - 24}px` });
    menu.current.showPopover();
    const below = innerHeight - rect.bottom - 18, above = rect.top - 18;
    const upwards = below < menu.current.scrollHeight + 2 && above > below;
    Object.assign(menu.current.style, {
      left: `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`,
      top: `${upwards ? rect.top - 6 : rect.bottom + 6}px`,
      maxHeight: `${Math.max(0, upwards ? above : below)}px`, translate: upwards ? '0 -100%' : 'none',
    });
    menu.current.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!containers.some(ref => ref.current?.contains(event.target as Node))) close(); };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', outside, true); document.removeEventListener('focusin', outside, true); };
  }, [open, close, containers, dismiss]);
  const choose = (action: () => void) => { close(true); action(); };
  return <>
    <button ref={trigger} type="button" className="app-center-icon" aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => open ? close() : setOpen(true)}
      onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
      <MoreHorizontal size={18} aria-hidden="true"/>
    </button>
    <div ref={menu} id={id} popover="auto" role="dialog" aria-label={label} className="app-center-settings-menu"
      onToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'closed') setOpen(false); }}>
      {open && <>
        <div className="app-center-dock-settings">
          <span>{zh ? '底部快捷方式' : 'Dock shortcuts'}</span>
          <div className="app-center-display" role="group" aria-label={zh ? '快捷方式显示' : 'Show shortcuts'}>
            {(['always', 'hover'] as const).map(value => <button type="button" key={value} aria-pressed={display === value}
              onClick={() => onDisplayChange(value)}>{value === 'always' ? (zh ? '始终显示' : 'Always visible') : (zh ? '悬停展开' : 'Show on hover')}</button>)}
          </div>
        </div>
        <div className="app-center-add-actions">
          <button type="button" className="app-center-add" disabled={selectingLocal || !window.cardbushDesktop?.localApplications}
            title={zh ? '选择桌面快捷方式，自动读取名称和图标' : 'Choose a desktop shortcut and load its name and icon'}
            onClick={() => choose(onAddLocal)}><Plus size={16} aria-hidden="true"/>{selectingLocal ? (zh ? '正在选择…' : 'Choosing…') : (zh ? '添加本地应用' : 'Add local app')}</button>
          <button type="button" className="app-center-add" onClick={() => choose(onAddLink)}><Plus size={16} aria-hidden="true"/>{zh ? '添加应用链接' : 'Add app link'}</button>
        </div>
      </>}
    </div>
  </>;
}
