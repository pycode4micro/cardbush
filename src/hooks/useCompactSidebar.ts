import { useCallback, useEffect, useState, type SetStateAction } from 'react';

export const compactWindowQuery = '(max-width: 760px)';

const drawerQuery = '(max-width: 1279px)';

/** Keep the user's wide-window layout separate from temporary drawer visibility. */
export function useCompactSidebar() {
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(compactWindowQuery).matches);
  const [drawerLayout, setDrawerLayout] = useState(() => window.matchMedia(drawerQuery).matches);
  const [wideCollapsed, setWideCollapsed] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(true);
  useEffect(() => {
    const media = window.matchMedia(compactWindowQuery);
    const drawer = window.matchMedia(drawerQuery);
    const changed = () => setCompactLayout(media.matches);
    const changeDrawer = () => { setDrawerLayout(drawer.matches); setDrawerCollapsed(true); };
    media.addEventListener('change', changed);
    drawer.addEventListener('change', changeDrawer);
    return () => {
      media.removeEventListener('change', changed);
      drawer.removeEventListener('change', changeDrawer);
    };
  }, []);
  const setSidebarCollapsed = useCallback((value: SetStateAction<boolean>) => {
    if (drawerLayout) setDrawerCollapsed(value); else setWideCollapsed(value);
  }, [drawerLayout]);
  const sidebarCollapsed = drawerLayout ? drawerCollapsed : wideCollapsed;
  useEffect(() => {
    if (!drawerLayout || sidebarCollapsed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open], [popover]:popover-open')) return;
      event.preventDefault();
      if (document.activeElement?.closest('.sidebar')) {
        document.querySelector<HTMLButtonElement>('.desktop-shell > .window-sidebar-toggle')?.focus({ preventScroll: true });
      }
      setDrawerCollapsed(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerLayout, sidebarCollapsed]);
  return { compactLayout, drawerLayout, sidebarCollapsed, setSidebarCollapsed };
}
