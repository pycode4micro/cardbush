import { uiText } from '../i18n';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../types';
import { useKeyboardShortcuts } from '../features/shortcuts/useKeyboardShortcuts';
import { windowMenuItems, type WindowMenuItem } from '../features/windowMenu/applicationMenus';
import { WindowMenuList, type MenuPosition } from '../features/windowMenu/WindowMenuList';
import { captureMenuFocus } from '../features/windowMenu/menuFocus';
import { useWindowBack } from '../features/navigation/WindowBackTarget';
import { useWindowHistoryInput } from '../features/navigation/useWindowHistoryInput';
import type { HistoryDirection } from '../../electron/shortcutBinding';

type Props = {
  language: AppLanguage; sidebarCollapsed: boolean;
  children?: React.ReactNode;
  menus: WindowMenuItem[]; onBack?: () => void; onForward?: () => void;
  onInspectorHistory?: (direction: HistoryDirection, tabId?: string) => void;
  onError: (error: unknown) => void;
};

export function WindowFrame(props: Props) {
  const { language, sidebarCollapsed, menus } = props;
  const onBack = useWindowBack(props.onBack);

  const nativeControls = window.cardbushDesktop?.platform === 'win32';
  const shortcuts = useKeyboardShortcuts();
  useWindowHistoryInput({ ...props, onBack }, shortcuts.overrides);
  const [maximized, setMaximized] = useState(false);
  const [open, setOpen] = useState<MenuPosition | null>(null);
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
    setOpen(null);
    if (restore) restoreFocus.current?.();
    restoreFocus.current = null;
  }, []);

  useLayoutEffect(() => { if (sidebarCollapsed) close(false); }, [sidebarCollapsed, close]);

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

  async function openMenu(anchor: HTMLElement, focus: MenuPosition['focus']) {
    const generation = ++opening.current;
    restoreFocus.current = captureMenuFocus();
    try { editTarget.current = (await window.cardbushDesktop?.windowMenuContext())?.editTargetId; }
    catch (error) { current.current.onError(error); return; }
    if (generation !== opening.current || !anchor.isConnected) return;
    opened.current = true;
    setMenuInput(focus === 'menu' ? 'pointer' : 'keyboard');
    setOpen({ anchor, focus });
  }

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
        const menus = root.current?.querySelectorAll<HTMLElement>('[role="menu"]');
        (popup ?? menus?.[menus.length - 1])?.focus({ preventScroll: true });
      }
    }}
    onKeyDownCapture={event => {
      if (open && !event.ctrlKey && !event.metaKey && !event.altKey &&
        ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'].includes(event.key)) {
        setMenuInput('keyboard');
      }
    }}>
    <div className="window-navigation">
    <WindowBackButton language={language} fallback={props.onBack} beforeBack={close}/>
    {!sidebarCollapsed && <span className="window-brand">{uiText(language)('windowSidebarToggle.cardbush')}</span>}
    {!sidebarCollapsed && menus.length > 0 && <button type="button" className="frame-chip desktop-menu-toggle no-drag" aria-label={uiText(language)('windowFrame.applicationMenu')}
      aria-haspopup="menu" aria-expanded={Boolean(open)} onPointerDown={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); void openMenu(event.currentTarget, event.key === 'ArrowDown' ? 'first' : 'last');
        }
      }}
      onClick={event => open ? close() : void openMenu(event.currentTarget, event.detail === 0 ? 'first' : 'menu')}><MoreHorizontal/></button>}
    </div>

    {open && <div className="window-menu-dismiss-layer no-drag" aria-hidden="true" onPointerDown={event => { event.preventDefault(); close(); }} />}
    {open && <WindowMenuList entries={menus} position={open} label={uiText(language)('windowFrame.applicationMenu')}
      shortcutLabel={shortcuts.label} onRun={run} onClose={close} onDismiss={close}/>}
    {props.children || <div className="window-spacer window-drag" aria-hidden="true" />}
    {!nativeControls && <>
      <WindowButton label={uiText(language)('windowFrame.minimize')} glyph="minimize" onClick={() => window.cardbushDesktop?.minimize()} />
      <WindowButton label={maximized ? (uiText(language)('windowFrame.restore')) : (uiText(language)('windowFrame.maximize'))}
        glyph={maximized ? 'restore' : 'maximize'} onClick={async () => { await window.cardbushDesktop?.toggleMaximize(); syncMaximized(); }} />
      <WindowButton label={uiText(language)('common.close')} glyph="close" danger onClick={() => window.cardbushDesktop?.closeToTray()} />
    </>}
  </header>;
}

export function WindowBackButton({ language, fallback, beforeBack }: { language: AppLanguage; fallback?: () => void; beforeBack?: () => void }) {
  const onBack = useWindowBack(fallback);
  return <div className="window-history-controls no-drag">
    <button type="button" className="frame-chip" data-history-action="back" disabled={!onBack}
      aria-label={uiText(language)('windowFrame.back')} title={uiText(language)('windowFrame.back')} data-shortcut="navigateBack"
      onClick={() => { beforeBack?.(); onBack?.(); }}><ArrowLeft size={15}/></button>
  </div>;
}

function WindowButton({ label, glyph, danger, onClick }: {
  label: string; glyph: string; danger?: boolean; onClick: () => void | Promise<void>;
}) {
  return <button className={`window-button no-drag ${danger ? 'danger' : ''}`} type="button" aria-label={label} title={label} data-shortcut={glyph === 'close' ? 'closeWindow' : undefined} onClick={onClick}>
    <span className={`window-glyph ${glyph}`} aria-hidden="true" />
  </button>;
}
