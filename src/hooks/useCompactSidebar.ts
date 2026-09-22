import { useCallback, useEffect, useState, type SetStateAction } from 'react';

export const compactWindowQuery = '(max-width: 760px)';

/** Keep the user's wide-window layout separate from temporary drawer visibility. */
export function useCompactSidebar() {
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(compactWindowQuery).matches);
  const [wideCollapsed, setWideCollapsed] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(true);
  useEffect(() => {
    const media = window.matchMedia(compactWindowQuery);
    const changed = () => { setCompactLayout(media.matches); setDrawerCollapsed(true); };
    changed();
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const setSidebarCollapsed = useCallback((value: SetStateAction<boolean>) => {
    if (compactLayout) setDrawerCollapsed(value); else setWideCollapsed(value);
  }, [compactLayout]);
  const sidebarCollapsed = compactLayout ? drawerCollapsed : wideCollapsed;
  useEffect(() => {
    if (!compactLayout || sidebarCollapsed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setDrawerCollapsed(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [compactLayout, sidebarCollapsed]);
  return { compactLayout, sidebarCollapsed, setSidebarCollapsed };
}
