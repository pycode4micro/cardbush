export const OPEN_INSPECTOR_EVENT = 'cardbush:open-inspector';

export type InspectorOpenDetail = {
  target: string;
  title?: string;
  sourceTabId?: string;
};

export function openInspector(target: string, title?: string, sourceTabId?: string) {
  window.dispatchEvent(new CustomEvent<InspectorOpenDetail>(OPEN_INSPECTOR_EVENT, {
    detail: { target, title, ...(sourceTabId ? { sourceTabId } : {}) },
  }));
}
