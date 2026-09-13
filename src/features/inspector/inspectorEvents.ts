export const OPEN_INSPECTOR_EVENT = 'cardbush:open-inspector';
export type InspectorMediaType = 'image' | 'video' | 'audio';

export type InspectorOpenDetail = {
  target: string;
  title?: string;
  sourceTabId?: string;
  mediaType?: InspectorMediaType;
};

export function openInspector(target: string, title?: string, sourceTabId?: string) {
  window.dispatchEvent(new CustomEvent<InspectorOpenDetail>(OPEN_INSPECTOR_EVENT, {
    detail: { target, title, ...(sourceTabId ? { sourceTabId } : {}) },
  }));
}

/** Explicit artifact types also identify extensionless URLs and inline MCP media. */
export function openMediaInspector(target: string, mediaType: InspectorMediaType, title?: string) {
  window.dispatchEvent(new CustomEvent<InspectorOpenDetail>(OPEN_INSPECTOR_EVENT, {
    detail: { target, title, mediaType },
  }));
}
