import { browserTabReferenceHref, type BrowserTabReference, type BrowserTabOpenResult } from '@cardbush/bush-protocol';
import { OPEN_INSPECTOR_EVENT, type InspectorOpenDetail } from '../inspector/inspectorEvents';

export const REVEAL_BROWSER_TAB_EVENT = 'cardbush:reveal-browser-tab';
export type RevealBrowserTabDetail = { tabId: string; complete(result: BrowserTabOpenResult): void };

export async function openBrowserTabReference(reference: BrowserTabReference, reopen = false): Promise<BrowserTabOpenResult> {
  if (reference.connectionId !== 'cardbush') {
    return window.cardbushDesktop?.openBrowserTabReference?.(browserTabReferenceHref(reference), reopen)
      ?? { status: 'unavailable' };
  }
  if (reopen) {
    window.dispatchEvent(new CustomEvent<InspectorOpenDetail>(OPEN_INSPECTOR_EVENT, {
      detail: { target: reference.url, title: reference.title, newTab: true },
    }));
    return { status: 'opened' };
  }
  if (reference.targetKey) {
    const result = await window.cardbushDesktop?.openBrowserTabReference?.(browserTabReferenceHref(reference));
    if (!result || result.status !== 'opened') return result ?? { status: 'unavailable' };
  }
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve({ status: 'unavailable' }), 10000);
    const complete = (result: BrowserTabOpenResult) => { window.clearTimeout(timer); resolve(result); };
    const event = new CustomEvent<RevealBrowserTabDetail>(REVEAL_BROWSER_TAB_EVENT, { cancelable: true, detail: { tabId: reference.tabId, complete } });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) complete({ status: 'unavailable' });
  });
}
