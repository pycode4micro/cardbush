import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';

export type SidebarContextMenuItem = {
  key: string;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: SidebarContextMenuItem[];
  onClick?: () => void;
};

type SidebarContextMenuState = {
  id: string;
  x: number;
  y: number;
  items: SidebarContextMenuItem[];
  anchor?: HTMLButtonElement;
  focusFirst?: boolean;
  drawerHost?: HTMLElement | null;
  trigger?: HTMLElement;
};
export type SidebarMenuEvent = MouseEvent | KeyboardEvent<HTMLElement>;

export function useSidebarContextMenu() {
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const closeMenus = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.sidebar-context-menu') ||
        target.closest('[data-sidebar-menu-trigger="true"]') === contextMenu?.trigger
      ) {
        return;
      }
      closeMenus();
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [closeMenus, contextMenu]);

  function openContextMenu(
    event: SidebarMenuEvent,
    id: string,
    items: SidebarContextMenuItem[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    const x = 'clientX' in event ? event.clientX + 2 : rect.left;
    const y = 'clientY' in event ? event.clientY + 2 : rect.bottom;
    setContextMenu({ id, items, x, y, trigger, drawerHost: trigger.closest<HTMLElement>('.recent-turn-drawer') });
  }

  function runContextMenuItem(item: SidebarContextMenuItem) {
    if (item.disabled) {
      return;
    }
    if (item.children?.length) {
      return;
    }
    closeMenus();
    item.onClick?.();
  }

  const menu = contextMenu && createPortal(
    <SidebarContextMenu menu={contextMenu} onSelect={runContextMenuItem} onClose={closeMenus} onDismiss={closeMenus}/>,
    contextMenu.drawerHost ?? contextMenu.trigger?.closest('.app') ?? document.body,
  );
  return { menu, openContextMenu, closeMenus };
}

function SidebarContextMenu({
  menu,
  onSelect,
  onClose,
  onDismiss,
}: {
  menu: SidebarContextMenuState;
  onSelect: (item: SidebarContextMenuItem) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<SidebarContextMenuState | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setSubmenu(null);
    // A translated drawer establishes a containing block for fixed descendants.
    // Keep DOM ownership for light-dismiss, but position the menu in the viewport's top layer.
    if (menu.drawerHost) node.showPopover();
    const anchor = menu.anchor?.getBoundingClientRect();
    let left = anchor ? anchor.right : menu.x;
    if (anchor && left + node.offsetWidth > window.innerWidth - 8) left = anchor.left - node.offsetWidth;
    node.style.left = Math.max(8, Math.min(left, window.innerWidth - node.offsetWidth - 8)) + 'px';
    node.style.top = Math.max(8, Math.min(anchor ? anchor.top - 8 : menu.y, window.innerHeight - node.offsetHeight - 8)) + 'px';
    if (menu.focusFirst) node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    else if (!menu.anchor) node.focus({ preventScroll: true });
    return () => { if (node.matches(':popover-open')) node.hidePopover(); };
  }, [menu]);
  useEffect(() => {
    window.addEventListener('resize', onDismiss);
    const drawer = menu.drawerHost;
    const dismissOnClose = (event: ToggleEvent) => { if (event.newState === 'closed') onDismiss(); };
    drawer?.addEventListener('beforetoggle', dismissOnClose);
    return () => {
      window.removeEventListener('resize', onDismiss);
      drawer?.removeEventListener('beforetoggle', dismissOnClose);
    };
  }, [onDismiss, menu.drawerHost]);

  function expand(item: SidebarContextMenuItem, anchor: HTMLButtonElement, focusFirst = false) {
    if (item.disabled || !item.children?.length) { setSubmenu(null); return; }
    setSubmenu({ id: item.key, x: 0, y: 0, items: item.children, anchor, focusFirst, drawerHost: menu.drawerHost });
  }

  return <>
    <div
      ref={ref}
      className="sidebar-context-menu"
      popover={menu.drawerHost ? 'manual' : undefined}
      role="menu"
      tabIndex={-1}
      aria-label={menu.anchor?.textContent ?? undefined}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onScroll={() => setSubmenu(null)}
      onKeyDown={event => {
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); setSubmenu(null);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        } else if (event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation();
          const item = menu.items.find(item => item.key === buttons[current]?.dataset.sidebarMenuItem);
          if (item && buttons[current]) expand(item, buttons[current], true);
        } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); onClose();
          menu.trigger?.focus({ preventScroll: true });
        } else if (event.key === 'Tab') {
          event.preventDefault(); onDismiss();
        }
      }}
    >
      {menu.items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && item.separatorBefore && <div className="sidebar-menu-separator" role="separator" />}
          <button
            className={'sidebar-menu-button ' + (item.danger ? 'danger' : '')}
            data-sidebar-menu-item={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-haspopup={item.children?.length ? 'menu' : undefined}
            aria-expanded={item.children?.length ? submenu?.id === item.key : undefined}
            onPointerEnter={event => expand(item, event.currentTarget)}
            onClick={event => {
              event.stopPropagation();
              if (item.children?.length) expand(item, event.currentTarget, event.detail === 0);
              else onSelect(item);
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
            {Boolean(item.children?.length) && <ChevronRight className="sidebar-menu-chevron" size={16} aria-hidden="true" />}
          </button>
        </Fragment>
      ))}
    </div>
    {submenu && <SidebarContextMenu menu={submenu} onSelect={onSelect} onDismiss={onDismiss}
      onClose={() => { setSubmenu(null); submenu.anchor?.focus({ preventScroll: true }); }} />}
  </>;
}
