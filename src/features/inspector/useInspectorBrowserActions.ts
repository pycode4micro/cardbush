import { useEffect, useRef } from 'react';
import type { InspectorResourceTab } from './inspectorTabs';

/** Main-process Browser Use controls the same visible tabs as the user. */
export function useInspectorBrowserActions(actions: {
  open(tab: InspectorResourceTab, workspaceId?: string): void;
  activate(tabId: string, workspaceId?: string): void;
  close(tabId: string, workspaceId?: string): void;
  show(workspaceId?: string): void;
  workspace?(sessionId: string | undefined, tabId: string): string;
}) {
  const current = useRef(actions);
  current.current = actions;
  useEffect(() => window.cardbushDesktop?.onInspectorBrowserAction?.(detail => {
    const actions = current.current;
    const workspaceId = actions.workspace?.(detail.sessionId, detail.tabId);
    if (detail.action === 'open' && detail.url) {
      actions.open({ id: detail.tabId, kind: 'resource', detail: { target: detail.url } }, workspaceId);
      actions.show(workspaceId);
    } else if (detail.action === 'activate') {
      actions.activate(detail.tabId, workspaceId); actions.show(workspaceId);
    } else if (detail.action === 'close') actions.close(detail.tabId, workspaceId);
  }), []);
}
