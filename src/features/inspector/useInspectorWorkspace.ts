import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppLanguage, AppSection } from '../../types';
import { inspectorMaximum, minimumConversationWidth, minimumInspectorWidth } from '../../components/rightInspectorSizing';
import { useInspectorRecovery } from './useInspectorRecovery';
import type { InspectorTab, InspectorResourceTab } from './inspectorTabs';
import { addPanel, panelIds, retainPanels, type PanelLayout } from './panelLayout';
import { useInspectorSessionRef, useInspectorSessionState } from './useInspectorSessionState';

type InspectorWorkspaceOptions = {
  workspaceId?: string;
  language: AppLanguage;
  windowMaximized: boolean;
  compactLayout: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  setSidebarCollapsed: (collapsed: boolean) => void;
  section: AppSection;
  setSection: (section: AppSection) => void;
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  inspectorTabs: InspectorTab[];
  activeInspectorTab: InspectorTab | null;
  openInspectorTab: (tab: InspectorTab) => void;
  setInspectorTabsMenuOpen: (open: boolean) => void;
};

/** Owns workspace geometry and its restore lifecycle; the app supplies navigation and tabs. */
export function useInspectorWorkspace({
  workspaceId = 'shared', language, windowMaximized, compactLayout,
  sidebarCollapsed, sidebarWidth, setSidebarCollapsed, section, setSection,
  inspectorOpen, setInspectorOpen, inspectorTabs, activeInspectorTab, openInspectorTab,
  setInspectorTabsMenuOpen,
}: InspectorWorkspaceOptions) {
  const [inspectorWidth, setInspectorWidthState] = useState(() => {
    const stored = Number.parseFloat(window.localStorage.getItem('cardbush.inspector_width') ?? '');
    return Number.isFinite(stored) ? Math.max(minimumInspectorWidth, stored) : 620;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  const preferredWidthRef = useRef(inspectorWidth);
  const conversationCoverRequested = useInspectorSessionRef(workspaceId, false);
  const [inspectorLayout, setInspectorLayout] = useInspectorSessionState<PanelLayout | null>(workspaceId, null);
  const [inspectorCover, setInspectorCover] = useInspectorSessionState(workspaceId, false);
  const [quickInputOpen, setQuickInputOpen] = useInspectorSessionState(workspaceId, false);
  const { mainStageRef, conversationCovered, splitWidthRef } = useInspectorRecovery({ workspaceId, open: inspectorOpen, covered: inspectorCover, width: inspectorWidth });
  const inspectorControlsVisible = inspectorOpen && (inspectorCover || conversationCovered);
  const multiPageRestore = useInspectorSessionRef<{ width: number; sidebar: boolean } | null>(workspaceId, null);
  const coverRestore = useInspectorSessionRef<{ section: AppSection; sidebar: boolean; width: number } | null>(workspaceId, null);
  const windowResize = useRef<{ startWidth: number; inspectorWidth: number; preferredWidth: number } | null>(null);
  const resizeContext = useRef({ inspectorOpen, inspectorCover, compactLayout, sidebarCollapsed, sidebarWidth, conversationCoverRequested });
  resizeContext.current = { inspectorOpen, inspectorCover, compactLayout, sidebarCollapsed, sidebarWidth, conversationCoverRequested };
  useLayoutEffect(() => {
    const clear = () => {
      windowResize.current = null;
      mainStageRef.current?.parentElement?.classList.remove('inspector-window-resizing');
    };
    const unsubscribe = window.cardbushDesktop?.onWindowResizeGesture?.(gesture => {
      const shell = mainStageRef.current?.parentElement;
      const context = resizeContext.current;
      if (!shell) { clear(); return; }
      if (gesture.phase === 'start') {
        clear();
        const panel = shell.querySelector(':scope > .right-inspector');
        if (!['right', 'top-right', 'bottom-right'].includes(gesture.edge) || !context.inspectorOpen ||
          context.inspectorCover || context.compactLayout || context.conversationCoverRequested.current ||
          !panel || getComputedStyle(panel).position === 'absolute') return;
        const available = gesture.startWidth - (window.innerWidth - shell.clientWidth)
          - (context.sidebarCollapsed ? 0 : context.sidebarWidth);
        windowResize.current = {
          startWidth: gesture.startWidth,
          inspectorWidth: Math.min(preferredWidthRef.current, Math.max(minimumInspectorWidth, available - minimumConversationWidth)),
          preferredWidth: preferredWidthRef.current,
        };
        shell.classList.add('inspector-window-resizing');
        return;
      }
      const resize = windowResize.current;
      if (!resize) return;
      const preferred = gesture.phase === 'cancel' || Math.abs(gesture.width - resize.startWidth) < 1 ? resize.preferredWidth
        : Math.max(minimumInspectorWidth, Math.round(resize.inspectorWidth + gesture.width - resize.startWidth));
      preferredWidthRef.current = preferred;
      if (gesture.phase === 'end') window.localStorage.setItem('cardbush.inspector_width', String(preferred));
      clear();
      // The ordinary viewport fitting effect handles minimums and overlays.
      setInspectorWidthState(preferred);
    });
    return () => { unsubscribe?.(); clear(); };
  }, [mainStageRef]);
  const setInspectorWidth = useCallback((width: number, keepConversationVisible = false) => {
    const next = Math.min(
      inspectorMaximum(windowMaximized, window.innerWidth),
      Math.max(minimumInspectorWidth, Math.round(width)),
    );
    const shell = mainStageRef.current?.parentElement;
    const available = (shell?.clientWidth ?? window.innerWidth) - (sidebarCollapsed ? 0 : sidebarWidth);
    // Only an explicit oversized pane choice may hide the conversation. A
    // viewport change must never turn an ordinary split into a cover by itself.
    conversationCoverRequested.current = !keepConversationVisible && !compactLayout && next > available - minimumConversationWidth;
    preferredWidthRef.current = next;
    inspectorWidthRef.current = next;
    setInspectorWidthState(next);
    window.localStorage.setItem('cardbush.inspector_width', String(next));
  }, [windowMaximized, mainStageRef, sidebarCollapsed, sidebarWidth, compactLayout, conversationCoverRequested]);

  const previousWorkspace = useRef({ workspaceId, coverRestore, multiPageRestore });
  useLayoutEffect(() => {
    const previous = previousWorkspace.current;
    previousWorkspace.current = { workspaceId, coverRestore, multiPageRestore };
    if (previous.workspaceId === workspaceId) return;
    // Leave the old conversation's cover/layout intact. Only restore shared
    // geometry and dismiss transient input when navigating to another workspace.
    const restore = previous.coverRestore.current ?? previous.multiPageRestore.current;
    setQuickInputOpen(false);
    windowResize.current = null;
    mainStageRef.current?.parentElement?.classList.remove('inspector-window-resizing');
    if (inspectorOpen && (inspectorCover || inspectorLayout)) setSidebarCollapsed(true);
    else if (restore) setSidebarCollapsed(restore.sidebar);
    if (inspectorLayout && inspectorOpen) setInspectorWidth(window.innerWidth - minimumConversationWidth, true);
    else if (restore) setInspectorWidth(restore.width, true);
  }, [workspaceId, coverRestore, multiPageRestore, inspectorOpen, inspectorCover, inspectorLayout,
    setQuickInputOpen, setSidebarCollapsed, setInspectorWidth]);
  const leaveInspectorCover = useCallback(() => {
    setInspectorCover(false); setQuickInputOpen(false);
    const previous = coverRestore.current; coverRestore.current = null;
    if (previous) { setSidebarCollapsed(previous.sidebar); setSection(previous.section); }
    const collapsed = previous?.sidebar ?? sidebarCollapsed;
    const available = (mainStageRef.current?.parentElement?.clientWidth ?? window.innerWidth) - (collapsed ? 0 : sidebarWidth);
    const maximum = available - minimumConversationWidth;
    if (compactLayout || maximum < minimumInspectorWidth) {
      setInspectorOpen(false);
    } else {
      setInspectorWidth(Math.min(previous?.width ?? splitWidthRef.current ?? 620, maximum), true);
    }
  }, [setSidebarCollapsed, setSection, sidebarCollapsed, sidebarWidth, compactLayout, setInspectorOpen, setInspectorWidth, mainStageRef, splitWidthRef, coverRestore, setInspectorCover, setQuickInputOpen]);
  const revealConversation = useCallback(() => {
    if (inspectorControlsVisible) {
      leaveInspectorCover();
    } else if (inspectorOpen) {
      const panel = mainStageRef.current?.parentElement?.querySelector(':scope > .right-inspector');
      // In a narrow window the inspector overlays the conversation. Navigation
      // must reveal the destination, while a usable docked split can stay open.
      if (compactLayout || panel && getComputedStyle(panel).position === 'absolute') {
        setInspectorOpen(false);
      }
    }
    if (compactLayout) setSidebarCollapsed(true);
    // Quick input may have selected a conversation since cover mode opened.
    // Its status opens that current conversation, not the previous app section.
    setSection(section);
  }, [inspectorControlsVisible, leaveInspectorCover, inspectorOpen, mainStageRef,
    compactLayout, setInspectorOpen, setSidebarCollapsed, section, setSection]);
  const enterInspectorCover = useCallback(() => {
    coverRestore.current ??= { section, sidebar: sidebarCollapsed, width: conversationCovered ? splitWidthRef.current ?? 620 : inspectorWidthRef.current };
    setInspectorCover(true); setSidebarCollapsed(true); setInspectorOpen(true);
  }, [section, sidebarCollapsed, setSidebarCollapsed, setInspectorOpen, conversationCovered, splitWidthRef, coverRestore, setInspectorCover]);
  const leaveMultiPage = useCallback(() => {
    setInspectorLayout(null);
    const previous = multiPageRestore.current; multiPageRestore.current = null;
    if (previous) { setInspectorWidth(previous.width, true); if (!coverRestore.current) setSidebarCollapsed(previous.sidebar); }
  }, [setInspectorWidth, setSidebarCollapsed, setInspectorLayout, multiPageRestore, coverRestore]);
  const toggleMultiPage = () => {
    if (inspectorLayout) { leaveMultiPage(); return; }
    multiPageRestore.current = { width: inspectorWidthRef.current, sidebar: sidebarCollapsed };
    const initial = [activeInspectorTab, ...inspectorTabs.filter(tab => tab.id !== activeInspectorTab?.id)].filter((tab): tab is InspectorTab => Boolean(tab)).slice(0, 2);
    while (initial.length < 2) {
      const tab: InspectorResourceTab = { id: `browser:${crypto.randomUUID()}`, kind: 'resource', detail: { target: 'about:blank', title: language === 'zh' ? '新页面' : 'New page' } };
      openInspectorTab(tab); initial.push(tab);
    }
    setInspectorLayout(initial.reduce<PanelLayout | null>((tree, tab) => addPanel(tree, tab.id), null));
    setSidebarCollapsed(true); setInspectorOpen(true);
    setInspectorWidth(window.innerWidth - minimumConversationWidth, true);
    setInspectorTabsMenuOpen(false);
  };
  const openMultiPage = (tabs: InspectorTab[], layout: PanelLayout) => {
    multiPageRestore.current ??= { width: inspectorWidthRef.current, sidebar: sidebarCollapsed };
    // Open/select together before reconciling the tree, so the previously active
    // tab cannot accidentally become an extra pane in the restored layout.
    for (const tab of tabs) openInspectorTab(tab);
    setInspectorLayout(layout);
    setSidebarCollapsed(true); setInspectorOpen(true);
    setInspectorWidth(window.innerWidth - minimumConversationWidth, true);
    setInspectorTabsMenuOpen(false);
  };
  useEffect(() => {
    if (!inspectorLayout) return;
    const available = new Set(inspectorTabs.map(tab => tab.id));
    let next = retainPanels(inspectorLayout, available);
    if (activeInspectorTab && !panelIds(next).includes(activeInspectorTab.id)) next = addPanel(next, activeInspectorTab.id);
    if (panelIds(next).length < 2) { leaveMultiPage(); return; }
    if (JSON.stringify(next) !== JSON.stringify(inspectorLayout)) setInspectorLayout(next);
  }, [inspectorTabs, activeInspectorTab, inspectorLayout, leaveMultiPage, setInspectorLayout]);
  useEffect(() => { if (!inspectorOpen && inspectorCover) leaveInspectorCover(); }, [inspectorOpen, inspectorCover, leaveInspectorCover]);
  useEffect(() => {
    if (!inspectorControlsVisible) { setQuickInputOpen(false); return; }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (inspectorCover && !sidebarCollapsed) { setSidebarCollapsed(true); return; }
      if (quickInputOpen) setQuickInputOpen(false); else leaveInspectorCover();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [inspectorControlsVisible, quickInputOpen, leaveInspectorCover, inspectorCover, sidebarCollapsed, setSidebarCollapsed, setQuickInputOpen]);

  useEffect(() => {
    if (!inspectorControlsVisible || !quickInputOpen) return;
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
      '.inspector-cover-controls, .composer-popover, .composer-command-portal, dialog[open], .voice-dialog, .voice-mini, .voice-floating-composer',
    ));
    const outsidePointer = (event: PointerEvent) => {
      if (!inside(event.target)) setQuickInputOpen(false);
    };
    // Native guest clicks do not bubble into the host document. Observe the
    // focus transfer without consuming the click or stealing page focus.
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const guestFocus = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        const target = document.activeElement;
        if (target?.matches('webview, iframe') && !inside(target)) setQuickInputOpen(false);
      }, 0);
    };
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('focusin', guestFocus, true);
    window.addEventListener('blur', guestFocus);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('focusin', guestFocus, true);
      window.removeEventListener('blur', guestFocus);
    };
  }, [inspectorControlsVisible, quickInputOpen, setQuickInputOpen]);

  useLayoutEffect(() => {
    const shell = mainStageRef.current?.parentElement;
    if (!shell || !inspectorOpen || inspectorCover) return;
    const fit = () => {
      if (document.body.classList.contains('right-inspector-resizing') ||
        document.body.classList.contains('sidebar-resizing')) return;
      const panel = shell.querySelector(':scope > .right-inspector');
      const overlay = compactLayout || panel && getComputedStyle(panel).position === 'absolute';
      const available = shell.clientWidth - (sidebarCollapsed ? 0 : sidebarWidth);
      const resize = windowResize.current;
      if (resize) {
        // Right-edge drags allocate their width delta to the inspector, keeping
        // the conversation boundary fixed until the inspector reaches its minimum.
        preferredWidthRef.current = Math.abs(window.innerWidth - resize.startWidth) < 1 ? resize.preferredWidth
          : Math.max(minimumInspectorWidth, Math.round(resize.inspectorWidth + window.innerWidth - resize.startWidth));
      }
      const next = overlay ? preferredWidthRef.current
        : conversationCoverRequested.current ? available
        : Math.min(preferredWidthRef.current, Math.max(minimumInspectorWidth, available - minimumConversationWidth));
      // Ordinary viewport changes (including maximize/restore) only fit the
      // preferred width. A native right-edge gesture explicitly adjusts it.
      inspectorWidthRef.current = next;
      if (resize && panel instanceof HTMLElement) panel.style.setProperty('--right-inspector-width', `${next}px`);
      setInspectorWidthState(current => current === next ? current : next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(shell);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [inspectorOpen, inspectorCover, inspectorWidth, sidebarCollapsed, sidebarWidth, compactLayout, mainStageRef, conversationCoverRequested]);
  return {
    inspectorWidth, setInspectorWidth, inspectorLayout, setInspectorLayout,
    inspectorCover, enterInspectorCover, leaveInspectorCover, revealConversation,
    mainStageRef, conversationCovered, inspectorControlsVisible,
    quickInputOpen, setQuickInputOpen, toggleMultiPage, openMultiPage,
  };
}
