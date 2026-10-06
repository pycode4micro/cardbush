import { useEffect, useRef } from 'react';
import type { InspectorResourceTab } from './inspectorTabs';

/** Main-process Browser Use controls the same visible tabs as the user. */
export function useInspectorBrowserActions(actions: {
  open(tab: InspectorResourceTab): void; activate(tabId: string): void; close(tabId: string): void; show(): void;
}) {
  const current = useRef(actions);
  current.current = actions;
  useEffect(() => window.cardbushDesktop?.onInspectorBrowserAction?.(detail => {
    const actions = current.current;
    if (detail.action === 'open' && detail.url) {
      actions.open({ id: detail.tabId, kind: 'resource', detail: { target: detail.url } });
      actions.show();
    } else if (detail.action === 'activate') {
      actions.activate(detail.tabId); actions.show();
    } else if (detail.action === 'close') actions.close(detail.tabId);
  }), []);
}
