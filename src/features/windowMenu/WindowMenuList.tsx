import { Check, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ShortcutId } from '../shortcuts/keyboardShortcuts';
import type { WindowMenuEntry, WindowMenuItem } from './applicationMenus';

export type MenuPosition = { anchor: HTMLElement; focus?: 'first' | 'last' | 'menu' };

type Props = {
  entries: WindowMenuEntry[];
  label: string;
  position: MenuPosition;
  nested?: boolean;
  shortcutLabel: (id: ShortcutId) => string;
  onRun: (item: WindowMenuItem) => void;
  onClose: () => void;
  onDismiss: () => void;
};

const enabledItems = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)'));

export function WindowMenuList({ entries, label, position, nested, shortcutLabel, onRun, onClose, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [child, setChild] = useState<MenuPosition | null>(null);
  const branch = child && entries.find((entry): entry is WindowMenuItem =>
    !('separator' in entry) && entry.id === child.anchor.dataset.menuItem && !entry.disabled);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = position.anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    let left = nested ? rect.right : rect.left;
    if (nested && left + width > window.innerWidth - 8) left = rect.left - width;
    menu.style.left = Math.max(8, Math.min(left, window.innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(36, Math.min(nested ? rect.top : rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)) + 'px';
    if (position.focus === 'menu') menu.focus({ preventScroll: true });
    else if (position.focus) {
      const items = enabledItems(menu);
      (position.focus === 'last' ? items.at(-1) : items[0])?.focus();
    }
  }, [position, nested]);

  function closeChild() {
    child?.anchor.focus({ preventScroll: true });
    setChild(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = enabledItems(event.currentTarget);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End': {
        setChild(null);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        break;
      }
      case 'ArrowRight': {
        const anchor = buttons[index];
        if (anchor?.getAttribute('aria-haspopup') === 'menu') setChild({ anchor, focus: 'first' });
        break;
      }
      case 'ArrowLeft':
      case 'Escape':
        if (child) closeChild();
        else if (nested || event.key === 'Escape') onClose();
        break;
      case 'Tab': onDismiss(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return <>
    <div className="window-frame-menu-popover no-drag" ref={ref} role="menu" tabIndex={-1}
      aria-label={label} onKeyDown={onKeyDown} onScroll={() => setChild(null)}>
      {entries.map((entry, index) => 'separator' in entry
        ? <div key={'separator-' + index} className="window-menu-separator" role="separator"/>
        : <button key={entry.id} type="button" data-menu-item={entry.id} data-shortcut={entry.shortcut} title={entry.label}
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={entry.checked} disabled={entry.disabled}
            aria-haspopup={entry.children ? 'menu' : undefined} aria-expanded={entry.children ? branch?.id === entry.id : undefined}
            onPointerEnter={event => {
              const anchor = event.currentTarget;
              if (child?.anchor !== anchor) setChild(entry.children && !entry.disabled ? { anchor } : null);
            }}
            onClick={event => {
              if (entry.children) setChild({ anchor: event.currentTarget, focus: event.detail === 0 ? 'first' : 'menu' });
              else onRun(entry);
            }}>
            <span className="window-menu-check">{entry.checked && <Check size={13}/>}</span>
            <span className="window-menu-label">{entry.label}</span>
            {(entry.shortcut || entry.keyLabel) && <kbd>{entry.shortcut ? shortcutLabel(entry.shortcut) : entry.keyLabel}</kbd>}
            {entry.children && <ChevronRight size={13}/>}
          </button>)}
    </div>
    {child && branch?.children && <WindowMenuList key={branch.id} nested entries={branch.children} position={child}
      label={branch.label} shortcutLabel={shortcutLabel} onRun={onRun} onClose={closeChild} onDismiss={onDismiss}/>}
  </>;
}
