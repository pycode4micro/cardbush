import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppLanguage, AppSection } from '../../types';
import { inspectorMaximum } from '../../components/rightInspectorSizing';
import type { InspectorTab, InspectorResourceTab } from './inspectorTabs';
import { addPanel, panelIds, retainPanels, type PanelLayout } from './panelLayout';

type InspectorWorkspaceOptions = {
  language: AppLanguage;
  windowMaximized: boolean;
  compactLayout: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  section: AppSection;
  setSection: (section: AppSection) => void;
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  inspectorTabs: InspectorTab[];
  activeInspectorTab: InspectorTab | null;
  openInspectorTab: (tab: InspectorTab) => void;
  setInspectorAddMenuOpen: (open: boolean) => void;
  setInspectorTabsMenuOpen: (open: boolean) => void;
};

/** Owns workspace geometry and its restore lifecycle; the app supplies navigation and tabs. */
export function useInspectorWorkspace({
  language, windowMaximized, compactLayout,
  sidebarCollapsed, setSidebarCollapsed, section, setSection,
  inspectorOpen, setInspectorOpen, inspectorTabs, activeInspectorTab, openInspectorTab,
  setInspectorAddMenuOpen, setInspectorTabsMenuOpen,
}: InspectorWorkspaceOptions) {
  const [inspectorWidth, setInspectorWidthState] = useState(() => {
    const stored = Number.parseFloat(window.localStorage.getItem('cardbush.inspector_width') ?? '');
    return Number.isFinite(stored) ? Math.min(window.innerWidth, Math.max(380, stored)) : 620;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  const [inspectorLayout, setInspectorLayout] = useState<PanelLayout | null>(null);
  const [inspectorCover, setInspectorCover] = useState(false);
  const [quickInputOpen, setQuickInputOpen] = useState(false);
  const multiPageRestore = useRef<{ width: number; sidebar: boolean } | null>(null);
  const coverRestore = useRef<{ section: AppSection; sidebar: boolean } | null>(null);
  const setInspectorWidth = useCallback((width: number) => {
    const next = Math.min(
      inspectorMaximum(windowMaximized, window.innerWidth),
      Math.max(380, Math.round(width)),
    );
    inspectorWidthRef.current = next;
    setInspectorWidthState(next);
    window.localStorage.setItem('cardbush.inspector_width', String(next));
  }, [windowMaximized]);
  const leaveInspectorCover = useCallback(() => {
    setInspectorCover(false); setQuickInputOpen(false);
    const previous = coverRestore.current; coverRestore.current = null;
    if (previous) { setSidebarCollapsed(previous.sidebar); setSection(previous.section); }
  }, [setSidebarCollapsed, setSection]);
  const enterInspectorCover = useCallback(() => {
    coverRestore.current ??= { section, sidebar: sidebarCollapsed };
    setInspectorCover(true); setSidebarCollapsed(true); setInspectorOpen(true);
  }, [section, sidebarCollapsed, setSidebarCollapsed, setInspectorOpen]);
  const leaveMultiPage = useCallback(() => {
    setInspectorLayout(null);
    const previous = multiPageRestore.current; multiPageRestore.current = null;
    if (previous) { setInspectorWidth(previous.width); if (!coverRestore.current) setSidebarCollapsed(previous.sidebar); }
  }, [setInspectorWidth, setSidebarCollapsed]);
  const toggleMultiPage = () => {
    if (inspectorLayout) { leaveMultiPage(); return; }
    if (!window.confirm(language === 'zh'
      ? '多页面 (Beta) 为大屏设计。DPI、缩放和多显示器可能影响页面尺寸、弹层及输入体验。请确认正在使用大屏，再开启两个并排页面。继续吗？'
      : 'Multiple pages (Beta) is designed for large displays. DPI, scaling and multiple monitors may affect page sizes, popovers and input. Confirm you are using a large display to open at least two panes. Continue?')) return;
    multiPageRestore.current = { width: inspectorWidthRef.current, sidebar: sidebarCollapsed };
    const initial = [activeInspectorTab, ...inspectorTabs.filter(tab => tab.id !== activeInspectorTab?.id)].filter((tab): tab is InspectorTab => Boolean(tab)).slice(0, 2);
    while (initial.length < 2) {
      const tab: InspectorResourceTab = { id: `browser:${crypto.randomUUID()}`, kind: 'resource', detail: { target: 'about:blank', title: language === 'zh' ? '新页面' : 'New page' } };
      openInspectorTab(tab); initial.push(tab);
    }
    setInspectorLayout(initial.reduce<PanelLayout | null>((tree, tab) => addPanel(tree, tab.id), null));
    setSidebarCollapsed(true); setInspectorOpen(true);
    setInspectorWidth(window.innerWidth - 340);
    setInspectorAddMenuOpen(false); setInspectorTabsMenuOpen(false);
  };
  useEffect(() => {
    if (!inspectorLayout) return;
    const available = new Set(inspectorTabs.map(tab => tab.id));
    let next = retainPanels(inspectorLayout, available);
    if (activeInspectorTab && !panelIds(next).includes(activeInspectorTab.id)) next = addPanel(next, activeInspectorTab.id);
    if (panelIds(next).length < 2) { leaveMultiPage(); return; }
    if (JSON.stringify(next) !== JSON.stringify(inspectorLayout)) setInspectorLayout(next);
  }, [inspectorTabs, activeInspectorTab, inspectorLayout, leaveMultiPage]);
  useEffect(() => { if (!inspectorOpen && inspectorCover) leaveInspectorCover(); }, [inspectorOpen, inspectorCover, leaveInspectorCover]);
  useEffect(() => {
    if (!inspectorCover) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (quickInputOpen) setQuickInputOpen(false); else leaveInspectorCover();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [inspectorCover, quickInputOpen, leaveInspectorCover]);

  useEffect(() => {
    let previousLeft = window.screenX;
    let previousOuterWidth = window.outerWidth;
    let previousInnerWidth = window.innerWidth;
    let pendingWidthDelta = 0;
    let animationFrame = 0;
    let resizeSettleTimer = 0;

    const resizeInspectorFromWindowRightEdge = () => {
      const nextLeft = window.screenX;
      const nextOuterWidth = window.outerWidth;
      const nextInnerWidth = window.innerWidth;
      const innerWidthDelta = nextInnerWidth - previousInnerWidth;
      const rightEdgeDelta = nextLeft + nextOuterWidth - (
        previousLeft + previousOuterWidth
      );
      const leftEdgeStayedPut = Math.abs(nextLeft - previousLeft) <= 2;

      previousLeft = nextLeft;
      previousOuterWidth = nextOuterWidth;
      previousInnerWidth = nextInnerWidth;

      if (
        !inspectorOpen || compactLayout ||
        innerWidthDelta === 0 ||
        !leftEdgeStayedPut ||
        Math.sign(innerWidthDelta) !== Math.sign(rightEdgeDelta)
      ) {
        return;
      }

      document.body.classList.add('window-right-edge-resizing');
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      resizeSettleTimer = window.setTimeout(() => {
        resizeSettleTimer = 0;
        document.body.classList.remove('window-right-edge-resizing');
      }, 140);
      pendingWidthDelta += innerWidthDelta;
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const widthDelta = pendingWidthDelta;
        pendingWidthDelta = 0;
        if (widthDelta !== 0) {
          setInspectorWidth(inspectorWidthRef.current + widthDelta);
        }
      });
    };

    window.addEventListener('resize', resizeInspectorFromWindowRightEdge);
    return () => {
      window.removeEventListener('resize', resizeInspectorFromWindowRightEdge);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      document.body.classList.remove('window-right-edge-resizing');
    };
  }, [inspectorOpen, setInspectorWidth, compactLayout]);
  return {
    inspectorWidth, setInspectorWidth, inspectorLayout, setInspectorLayout,
    inspectorCover, enterInspectorCover, leaveInspectorCover,
    quickInputOpen, setQuickInputOpen, toggleMultiPage,
  };
}
