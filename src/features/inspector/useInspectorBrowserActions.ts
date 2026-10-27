import { useEffect, useRef, useState } from 'react';
import type { InspectorResourceTab, InspectorTabsState } from './inspectorTabs';
import type { BrowserTabAction, BrowserTabPresentation } from '../../../electron/integratedBrowser';

/** Main-process Browser Use addresses the same retained inspector tabs as the user. */
export function useInspectorBrowserActions(actions: {
  workspaceId: string;
  snapshot(workspaceId: string): InspectorTabsState & { open: boolean };
  bind(tabIds: string[], workspaceId?: string): void;
  open(tab: InspectorResourceTab, workspaceId?: string, activate?: boolean): void;
  activate(tabId: string, workspaceId?: string): void;
  close(tabId: string, workspaceId?: string): void;
  show(workspaceId?: string): void;
  workspace?(sessionId: string | undefined, tabId: string): string;
}) {
  const current = useRef(actions);
  current.current = actions;
  const [pending, setPending] = useState<BrowserTabAction[]>([]);
  useEffect(() => window.cardbushDesktop?.onInspectorBrowserAction?.(detail => {
    const actions = current.current;
    const workspaceId = actions.workspace?.(detail.sessionId, detail.tabId);
    if (detail.action === 'bind') {
      actions.bind(detail.tabIds ?? [detail.tabId], workspaceId);
    } else if (detail.action === 'open' && detail.url) {
      actions.open({ id: detail.tabId, kind: 'resource', detail: { target: detail.url } }, workspaceId, detail.background !== true);
      if (detail.background !== true) actions.show(workspaceId);
    } else if (detail.action === 'activate') {
      actions.activate(detail.tabId, workspaceId); actions.show(workspaceId);
    } else if (detail.action === 'close') actions.close(detail.tabId, workspaceId);
    if (detail.requestId) setPending(requests => [...requests, detail]);
  }), []);
  // Acknowledge after React commits, using the real guest and host geometry.
  // Timers also run in background windows, where requestAnimationFrame may pause.
  useEffect(() => {
    if (!pending.length) return;
    const started = performance.now();
    let timer: number;
    const report = () => {
      const actions = current.current;
      let settling = false;
      const results = pending.map(request => {
        const workspaceId = actions.workspace?.(request.sessionId, request.tabId) ?? actions.workspaceId;
        const workspace = actions.snapshot(workspaceId);
        const displayed = actions.snapshot(actions.workspaceId);
        const pages: BrowserTabPresentation[] = (request.tabIds ?? [request.tabId]).map(tabId => {
          const pane = Array.from(document.querySelectorAll<HTMLElement>('[data-inspector-page-id]')).find(pane => pane.dataset.inspectorPageId === tabId);
          const webview = pane?.querySelector<HTMLElement & { getWebContentsId?: () => number }>('webview');
          let guestWebContentsId: number | null = null;
          try { guestWebContentsId = webview?.getWebContentsId?.() ?? null; } catch { /* A guest may be attaching or closing. */ }
          const inWorkspace = workspace.tabs.some(tab => tab.id === tabId);
          const displayedHere = displayed.tabs.some(tab => tab.id === tabId);
          const active = displayedHere && displayed.activeId === tabId;
          const shown = displayedHere && displayed.open && pane?.classList.contains('active');
          const bounds = webview?.getBoundingClientRect();
          const visible = Boolean(shown && guestWebContentsId && bounds && bounds.width > 0 && bounds.height > 0 &&
            bounds.bottom > 0 && bounds.right > 0 && bounds.top < window.innerHeight && bounds.left < window.innerWidth &&
            !webview?.closest('[inert], [aria-hidden="true"]') && getComputedStyle(webview!).visibility === 'visible');
          if (shown && !visible && !pane?.querySelector('.showing-start-page')) settling = true;
          if (request.action === 'close' && webview) settling = true;
          return { tabId, guestWebContentsId, inWorkspace, active, visible };
        });
        return { requestId: request.requestId!, pages };
      });
      if (settling && performance.now() - started < 400) { timer = window.setTimeout(report, 25); return; }
      for (const result of results) void window.cardbushDesktop?.acknowledgeInspectorBrowserAction?.(result).catch(() => {});
      const ids = new Set(results.map(result => result.requestId));
      setPending(requests => requests.filter(request => !ids.has(request.requestId!)));
    };
    timer = window.setTimeout(report, 0);
    return () => window.clearTimeout(timer);
  }, [pending]);
}
