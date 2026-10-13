import { useEffect, useRef } from 'react';
import type { InspectorTab } from '../inspector/inspectorTabs';
import { REVEAL_BROWSER_TAB_EVENT, type RevealBrowserTabDetail } from './browserTabReferences';
import { isBrowserReferenceUrl } from '../../shared/promptReferences';

/** Resolve identity across retained pages, without navigating or moving the guest. */
export function useBrowserTabReferences(actions: {
  tabs: InspectorTab[];
  workspaceId: string;
  ownerOfTab(id: string): string | undefined;
  visible(id: string): boolean;
  select(id: string, workspace: string): void;
  show(workspace: string): void;
  navigate(workspace: string): Promise<boolean>;
}) {
  const current = useRef(actions);
  current.current = actions;
  useEffect(() => {
    const listener = (event: Event) => {
      const request = event as CustomEvent<RevealBrowserTabDetail>;
      if (typeof request.detail?.tabId !== 'string') return;
      request.preventDefault();
      const { tabId, complete } = request.detail;
      const actions = current.current;
      const tab = actions.tabs.find(tab => tab.id === tabId && tab.kind === 'resource' && !tab.detail.mediaType && isBrowserReferenceUrl(tab.detail.target));
      if (!tab) { complete({ status: 'missing' }); return; }
      const owner = actions.visible(tabId) ? actions.workspaceId : actions.ownerOfTab(tabId);
      if (!owner) { complete({ status: 'missing' }); return; }
      void (async () => {
        if (owner !== actions.workspaceId && !await actions.navigate(owner)) { complete({ status: 'unavailable' }); return; }
        if (!current.current.tabs.some(tab => tab.id === tabId)) { complete({ status: 'missing' }); return; }
        current.current.select(tabId, owner);
        current.current.show(owner);
        complete({ status: 'opened' });
      })().catch(error => complete({ status: 'unavailable', message: String(error) }));
    };
    window.addEventListener(REVEAL_BROWSER_TAB_EVENT, listener);
    return () => window.removeEventListener(REVEAL_BROWSER_TAB_EVENT, listener);
  }, []);
}
