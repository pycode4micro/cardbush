import { ArrowLeft, ArrowRight, Check, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AppLanguage } from '../types';
import { WindowSidebarToggle } from './WindowSidebarToggle';
import { useKeyboardShortcuts } from '../features/shortcuts/useKeyboardShortcuts';
import { windowMenuItems, type ApplicationMenu, type WindowMenuEntry, type WindowMenuItem } from '../features/windowMenu/applicationMenus';
import { captureMenuFocus } from '../features/windowMenu/menuFocus';

type OpenMenu = { id: string; anchor: HTMLElement; initialFocus?: 'first' | 'last' };
type Props = {
  language: AppLanguage; sidebarCollapsed: boolean; onToggleSidebar: () => void;
  menus: ApplicationMenu[]; onBack?: () => void; onForward?: () => void;
  onError: (error: unknown) => void;
};

export function WindowFrame(props: Props) {
  const { language, sidebarCollapsed, onToggleSidebar, menus, onBack, onForward } = props;
  const zh = language === 'zh';
  const nativeControls = window.cardbushDesktop?.platform === 'win32';
  const shortcuts = useKeyboardShortcuts();
  const [maximized, setMaximized] = useState(false);
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const [submenu, setSubmenu] = useState<OpenMenu | null>(null);
  const [menuInput, setMenuInput] = useState<'pointer' | 'keyboard'>('pointer');
  const root = useRef<HTMLElement>(null);
  const restoreFocus = useRef<(() => void) | null>(null);
  const editTarget = useRef<number | undefined>(undefined);
  const opening = useRef(0);
  const opened = useRef(false);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const current = useRef(props);
  current.current = props;
  const close = useCallback((restore = true) => {
    opening.current++;
    opened.current = false;
    setOpen(null); setSubmenu(null);
    if (restore) restoreFocus.current?.();
    restoreFocus.current = null;
  }, []);

  const syncMaximized = useCallback(() => {
    void window.cardbushDesktop?.isMaximized().then(setMaximized).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (nativeControls) return;
    syncMaximized(); window.addEventListener('resize', syncMaximized);
    return () => window.removeEventListener('resize', syncMaximized);
  }, [nativeControls, syncMaximized]);

  const run = useCallback((item: WindowMenuItem) => {
    if (item.disabled || item.children) return;
    const target = opened.current ? editTarget.current : undefined;
    close();
    try {
      const result = item.nativeAction
        ? window.cardbushDesktop?.executeWindowMenuAction(item.nativeAction, target) : item.onSelect?.();
      void Promise.resolve(result).catch(error => current.current.onError(error));
    } catch (error) { current.current.onError(error); }
  }, [close]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof Element && event.target.closest('[inert], dialog, [role="dialog"], [data-shortcut-recorder]')) return;
      if (Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(node => node.checkVisibility())) return;
      const item = windowMenuItems(current.current.menus).find(candidate => candidate.shortcut
        && !candidate.shortcutHandledElsewhere && shortcuts.matches(candidate.shortcut, { ...event,
          key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey }));
      if (!item) return;
      // Consume a disabled command as well (Ctrl+R must never reload the app).
      event.preventDefault();
      if (!event.repeat) run(item);
    };
    window.addEventListener('keydown', keydown);
    const unsubscribe = window.cardbushDesktop?.onWindowMenuKeyDown?.(gesture => {
      if (document.activeElement?.closest('[inert], dialog, [role="dialog"], [data-shortcut-recorder]')) return;
      keydown(new KeyboardEvent('keydown', { ...gesture, cancelable: true }));
    });
    return () => { window.removeEventListener('keydown', keydown); unsubscribe?.(); };
  }, [run, shortcuts]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) close(false); };
    const dismiss = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss);
    };
  }, [open, close]);

  async function openMenu(id: string, anchor: HTMLElement, initialFocus?: OpenMenu['initialFocus']) {
    const generation = ++opening.current;
    if (!opened.current) {
      restoreFocus.current = captureMenuFocus();
      try { editTarget.current = (await window.cardbushDesktop?.windowMenuContext())?.editTargetId; }
      catch (error) { current.current.onError(error); return; }
      if (generation !== opening.current) return;
    }
    opened.current = true;
    setMenuInput(initialFocus ? 'keyboard' : 'pointer');
    setSubmenu(null); setOpen({ id, anchor, initialFocus });
  }

  function switchMenu(delta: number) {
    const index = menus.findIndex(menu => menu.id === open?.id);
    const menu = menus[(index + delta + menus.length) % menus.length];
    const anchor = root.current?.querySelector<HTMLElement>(`[data-menu-trigger="${menu.id}"]`);
    if (anchor) void openMenu(menu.id, anchor, 'first');
  }

  function onMenuKey(event: ReactKeyboardEvent, entries: WindowMenuEntry[], nested: boolean) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const item = entries.find(entry => !('separator' in entry) && entry.id === buttons[index]?.dataset.menuItem);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation();
      if (item && !('separator' in item) && item.children) setSubmenu({ id: item.id, anchor: buttons[index], initialFocus: 'first' });
      else if (!nested) switchMenu(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (nested) { const anchor = submenu?.anchor; setSubmenu(null); anchor?.focus(); }
      else if (event.key === 'ArrowLeft') switchMenu(-1);
      else close();
    } else if (event.key === 'Tab') { event.preventDefault(); close(); }
  }

  const activeMenu = menus.find(menu => menu.id === open?.id);
  const activeSubmenu = activeMenu?.items.find((item): item is WindowMenuItem => !('separator' in item) && item.id === submenu?.id);
  const popup = (entries: WindowMenuEntry[], position: OpenMenu, nested: boolean, label: string) =>
    <MenuPopup key={position.id} position={position} nested={nested} label={label} onKeyDown={event => onMenuKey(event, entries, nested)}>
      {entries.map((entry, index) => 'separator' in entry ? <div className="window-menu-separator" role="separator" key={'separator-' + index} /> :
        <button key={entry.id} data-menu-item={entry.id} type="button" disabled={entry.disabled}
          role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={entry.checked}
          aria-haspopup={entry.children ? 'menu' : undefined} aria-expanded={entry.children ? submenu?.id === entry.id : undefined}
          onPointerEnter={event => {
            if (nested) return;
            setSubmenu(entry.children && !entry.disabled ? { id: entry.id, anchor: event.currentTarget } : null);
          }}
          onClick={event => entry.children ? setSubmenu({ id: entry.id, anchor: event.currentTarget,
            initialFocus: event.detail === 0 ? 'first' : undefined }) : run(entry)}>
          <span className="window-menu-check">{entry.checked && <Check size={13} />}</span>
          <span className="window-menu-label">{entry.label}</span>
          {(entry.shortcut || entry.keyLabel) && <kbd>{entry.shortcut ? shortcuts.label(entry.shortcut) : entry.keyLabel}</kbd>}
          {entry.children && <ChevronRight size={13} />}
        </button>)}
    </MenuPopup>;

  return <header className="window-frame window-drag" ref={root} data-menu-input={menuInput}
    data-native-controls={nativeControls ? 'true' : undefined}
    onPointerMoveCapture={event => {
      const previous = pointerPosition.current;
      pointerPosition.current = { x: event.clientX, y: event.clientY };
      if (!open || previous?.x === event.clientX && previous?.y === event.clientY) return;
      setMenuInput('pointer');
      // Mouse movement takes over from keyboard navigation without leaving
      // the previously focused row highlighted elsewhere in the menu.
      const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-menu-item]') : null;
      if (item && !item.disabled) item.focus({ preventScroll: true });
      else {
        const popup = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="menu"]') : null;
        (popup ?? root.current?.querySelector<HTMLElement>('.window-frame-menu-popover'))?.focus({ preventScroll: true });
      }
    }}
    onKeyDownCapture={event => {
      if (open && !event.ctrlKey && !event.metaKey && !event.altKey &&
        ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(event.key)) {
        setMenuInput('keyboard');
      }
    }}>
    <WindowSidebarToggle language={language} collapsed={sidebarCollapsed} onToggle={onToggleSidebar} />
    <div className="window-history-controls no-drag">
      {([{ id: 'back', label: zh ? '返回' : 'Back', action: onBack, icon: ArrowLeft, shortcut: 'navigateBack' },
        { id: 'forward', label: zh ? '前进' : 'Forward', action: onForward, icon: ArrowRight, shortcut: 'navigateForward' }] as const).map(item =>
        <button key={item.id} type="button" className="frame-chip" data-history-action={item.id} disabled={!item.action}
          aria-label={item.label} title={[item.label, shortcuts.label(item.shortcut)].filter(Boolean).join(' · ')}
          onClick={() => { close(); item.action?.(); }}><item.icon size={15} /></button>)}
    </div>
    <div className="window-frame-menu-group no-drag" role="menubar" aria-label={zh ? '应用菜单' : 'Application menu'}>
      {menus.map(menu => <div className="window-frame-menu" key={menu.id}>
        <button className="frame-chip window-frame-menu-trigger no-drag" type="button" role="menuitem"
          data-menu-trigger={menu.id} aria-haspopup="menu" aria-expanded={open?.id === menu.id}
          onPointerDown={event => event.preventDefault()}
          onClick={event => open?.id === menu.id ? close() : void openMenu(menu.id, event.currentTarget, event.detail === 0 ? 'first' : undefined)}
          onPointerEnter={event => { if (open && open.id !== menu.id) void openMenu(menu.id, event.currentTarget); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); void openMenu(menu.id, event.currentTarget, event.key === 'ArrowUp' ? 'last' : 'first'); }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              const index = menus.indexOf(menu), delta = event.key === 'ArrowRight' ? 1 : -1;
              root.current?.querySelector<HTMLElement>(`[data-menu-trigger="${menus[(index + delta + menus.length) % menus.length].id}"]`)?.focus();
            }
          }}>{menu.label}</button>
      </div>)}
    </div>
    {open && <div className="window-menu-dismiss-layer no-drag" aria-hidden="true" onPointerDown={event => { event.preventDefault(); close(); }} />}
    {open && activeMenu && popup(activeMenu.items, open, false, activeMenu.label)}
    {submenu && activeSubmenu?.children && popup(activeSubmenu.children, submenu, true, activeSubmenu.label)}
    <div className="window-spacer window-drag" aria-hidden="true" />
    {!nativeControls && <>
      <WindowButton label={zh ? '最小化' : 'Minimize'} glyph="minimize" onClick={() => window.cardbushDesktop?.minimize()} />
      <WindowButton label={maximized ? (zh ? '还原窗口' : 'Restore') : (zh ? '最大化' : 'Maximize')}
        glyph={maximized ? 'restore' : 'maximize'} onClick={async () => { await window.cardbushDesktop?.toggleMaximize(); syncMaximized(); }} />
      <WindowButton label={zh ? '关闭' : 'Close'} glyph="close" danger onClick={() => window.cardbushDesktop?.closeToTray()} />
    </>}
  </header>;
}

function MenuPopup({ position, nested, label, children, onKeyDown }: {
  position: OpenMenu; nested: boolean; label: string; children: React.ReactNode;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = position.anchor.getBoundingClientRect();
    const width = menu.offsetWidth, height = menu.offsetHeight;
    let left = nested ? rect.right + 5 : rect.left;
    if (left + width > window.innerWidth - 8) left = nested ? rect.left - width - 5 : window.innerWidth - width - 8;
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(36, Math.min(nested ? rect.top : rect.bottom + 4, window.innerHeight - height - 8)) + 'px';
    if (position.initialFocus) {
      const items = menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      (position.initialFocus === 'last' ? items[items.length - 1] : items[0])?.focus({ preventScroll: true });
    } else if (!nested) {
      // Keep Escape and arrow keys available without selecting a menu item.
      // A submenu opened by hovering must not steal focus from its parent.
      menu.focus({ preventScroll: true });
    }
  }, [position, nested]);
  return <div className="window-frame-menu-popover no-drag" ref={ref} role="menu" tabIndex={-1} aria-label={label} onKeyDown={onKeyDown}>{children}</div>;
}

function WindowButton({ label, glyph, danger, onClick }: {
  label: string; glyph: string; danger?: boolean; onClick: () => void | Promise<void>;
}) {
  return <button className={`window-button no-drag ${danger ? 'danger' : ''}`} type="button" aria-label={label} title={label} onClick={onClick}>
    <span className={`window-glyph ${glyph}`} aria-hidden="true" />
  </button>;
}
