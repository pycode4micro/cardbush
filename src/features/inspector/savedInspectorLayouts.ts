import { isAbsoluteLocalPath } from '../../shared/localPaths';
import { bookmarkUrl } from './browserBookmarks';
import { inspectorFilePath, isInspectorBrowserTarget } from './inspectorTargets';
import type { InspectorNavigationState } from './InspectorWebview';
import type { InspectorOpenDetail } from './inspectorEvents';
import type { InspectorTab } from './inspectorTabs';
import { panelIds, type PanelLayout } from './panelLayout';

export const savedInspectorLayoutsKey = 'cardbush.inspector_layouts.v1';
export type InspectorLayoutSnapshot = { pages: Array<{ id: string; detail: InspectorOpenDetail }>; layout: PanelLayout };
export type SavedInspectorLayout = InspectorLayoutSnapshot & { id: string; name: string };

function savedTarget(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192) return;
  const target = input.trim();
  if (target === 'about:blank') return target;
  if (/^https?:/i.test(target)) return bookmarkUrl(target);
  if (isAbsoluteLocalPath(target)) return target;
  if (/^(?:file|cardbush-file):\/\//i.test(target) && isAbsoluteLocalPath(inspectorFilePath(target))) return target;
}

function mapLayout(layout: PanelLayout, ids: Map<string, string>): PanelLayout {
  return layout.kind === 'page' ? { kind: 'page', id: ids.get(layout.id)! }
    : { ...layout, first: mapLayout(layout.first, ids), second: mapLayout(layout.second, ids) };
}

/** Persist addresses and geometry only; never serialize live tasks, model configuration or guest state. */
export function captureInspectorLayout(layout: PanelLayout, tabs: InspectorTab[], navigation: Record<string, InspectorNavigationState>): InspectorLayoutSnapshot | null {
  const ids = panelIds(layout), mapping = new Map(ids.map((id, i) => [id, `p${i}`]));
  if (ids.length < 2 || ids.length > 16) return null;
  const pages: InspectorLayoutSnapshot['pages'] = [];
  for (const id of ids) {
    const tab = tabs.find(item => item.id === id);
    if (tab?.kind !== 'resource') return null;
    const state = navigation[id];
    const target = savedTarget(isInspectorBrowserTarget(tab.detail.target, tab.detail.mediaType) ? state?.url || tab.detail.target : tab.detail.target);
    if (!target) return null;
    pages.push({ id: mapping.get(id)!, detail: { target, title: (state?.title || tab.detail.title || target).slice(0, 300),
      ...(tab.detail.mediaType ? { mediaType: tab.detail.mediaType } : {}) } });
  }
  return { pages, layout: mapLayout(layout, mapping) };
}

function normalizeLayout(value: unknown, available: Set<string>, seen: Set<string>, depth = 0): PanelLayout | null {
  if (!value || typeof value !== 'object' || depth > 16) return null;
  const node = value as Record<string, unknown>;
  if (node.kind === 'page') {
    if (typeof node.id !== 'string' || !available.has(node.id) || seen.has(node.id)) return null;
    seen.add(node.id); return { kind: 'page', id: node.id };
  }
  if (node.kind !== 'split' || !['x', 'y'].includes(String(node.axis)) || typeof node.ratio !== 'number' || !Number.isFinite(node.ratio)) return null;
  const first = normalizeLayout(node.first, available, seen, depth + 1), second = normalizeLayout(node.second, available, seen, depth + 1);
  return first && second ? { kind: 'split', axis: node.axis as 'x' | 'y', ratio: Math.max(.15, Math.min(.85, node.ratio)), first, second } : null;
}

export function normalizeSavedInspectorLayouts(value: unknown): SavedInspectorLayout[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<string>();
  return value.slice(0, 50).flatMap(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || used.has(item.id) || typeof item.name !== 'string' || !item.name.trim()
      || !Array.isArray(item.pages) || item.pages.length < 2 || item.pages.length > 16) return [];
    const ids = new Set<string>(), pages: InspectorLayoutSnapshot['pages'] = [];
    for (const page of item.pages) {
      const target = savedTarget(page?.detail?.target);
      if (!target || typeof page.id !== 'string' || !page.id || page.id.length > 100 || ids.has(page.id)) return [];
      ids.add(page.id);
      pages.push({ id: page.id, detail: { target,
        title: typeof page.detail.title === 'string' ? page.detail.title.slice(0, 300) : target,
        ...(['image', 'audio', 'video'].includes(page.detail.mediaType) ? { mediaType: page.detail.mediaType } : {}) } });
    }
    const seen = new Set<string>(), layout = normalizeLayout(item.layout, ids, seen);
    if (!layout || seen.size !== pages.length) return [];
    used.add(item.id);
    return [{ id: item.id, name: item.name.trim().slice(0, 80), pages, layout }];
  });
}

/** A stable identity prevents repeated opens from duplicating/remounting live pages. */
export function restoreInspectorLayout(saved: SavedInspectorLayout, tabs: InspectorTab[], navigation: Record<string, InspectorNavigationState>, workspaceId = '') {
  const used = new Set<string>(), mapping = new Map<string, string>();
  const identity = (pageId: string) => `saved-layout:${workspaceId ? `${workspaceId}:` : ''}${saved.id}:${pageId}`;
  const reserved = new Set(saved.pages.map(page => identity(page.id)));
  const restored = saved.pages.map(page => {
    const stableId = identity(page.id);
    const existing = tabs.find(tab => tab.id === stableId) ?? tabs.find(tab => tab.kind === 'resource' && !used.has(tab.id) && !reserved.has(tab.id)
      && (isInspectorBrowserTarget(tab.detail.target, tab.detail.mediaType) ? navigation[tab.id]?.url || tab.detail.target : tab.detail.target) === page.detail.target
      && tab.detail.mediaType === page.detail.mediaType);
    const tab: InspectorTab = existing ?? { id: stableId, kind: 'resource', detail: { ...page.detail } };
    used.add(tab.id); mapping.set(page.id, tab.id); return tab;
  });
  return { tabs: restored, layout: mapLayout(saved.layout, mapping) };
}
