/** A partition tree fills the available area without overlapping or remounting pages. */
export type PanelLayout = { kind: 'page'; id: string } | { kind: 'split'; axis: 'x' | 'y'; ratio: number; first: PanelLayout; second: PanelLayout };
export type PanelRect = { x: number; y: number; width: number; height: number };
export const fullPanelRect: PanelRect = { x: 0, y: 0, width: 1, height: 1 };
export function panelIds(layout: PanelLayout | null): string[] {
  return !layout ? [] : layout.kind === 'page' ? [layout.id] : [...panelIds(layout.first), ...panelIds(layout.second)];
}
export function panelRects(layout: PanelLayout | null, rect = fullPanelRect): Record<string, PanelRect> {
  if (!layout) return {};
  if (layout.kind === 'page') return { [layout.id]: rect };
  const { axis, ratio } = layout;
  const first = { ...rect, [axis === 'x' ? 'width' : 'height']: (axis === 'x' ? rect.width : rect.height) * ratio };
  const second = axis === 'x' ? { ...rect, x: rect.x + first.width, width: rect.width - first.width }
    : { ...rect, y: rect.y + first.height, height: rect.height - first.height };
  return { ...panelRects(layout.first, first), ...panelRects(layout.second, second) };
}
export function addPanel(layout: PanelLayout | null, id: string): PanelLayout {
  if (!layout) return { kind: 'page', id };
  if (panelIds(layout).includes(id)) return layout;
  const rectangles = panelRects(layout);
  const largest = Object.entries(rectangles).sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height)[0];
  const visit = (node: PanelLayout): PanelLayout => node.kind === 'page' ? node.id !== largest[0] ? node : {
    kind: 'split', axis: largest[1].width >= largest[1].height * .7 ? 'x' : 'y', ratio: .5,
    first: node, second: { kind: 'page', id },
  } : { ...node, first: visit(node.first), second: visit(node.second) };
  return visit(layout);
}
export function retainPanels(layout: PanelLayout | null, ids: ReadonlySet<string>): PanelLayout | null {
  if (!layout) return null;
  if (layout.kind === 'page') return ids.has(layout.id) ? layout : null;
  const first = retainPanels(layout.first, ids), second = retainPanels(layout.second, ids);
  return first && second ? { ...layout, first, second } : first || second;
}
export function swapPanels(layout: PanelLayout, a: string, b: string): PanelLayout {
  return layout.kind === 'page' ? { ...layout, id: layout.id === a ? b : layout.id === b ? a : layout.id }
    : { ...layout, first: swapPanels(layout.first, a, b), second: swapPanels(layout.second, a, b) };
}
export function resizePanelSplit(layout: PanelLayout, path: string, ratio: number): PanelLayout {
  if (layout.kind === 'page' || !Number.isFinite(ratio)) return layout;
  if (!path) return { ...layout, ratio: Math.max(.15, Math.min(.85, ratio)) };
  const key = path[0] === '0' ? 'first' : 'second';
  return { ...layout, [key]: resizePanelSplit(layout[key], path.slice(1), ratio) };
}
export function panelDividers(layout: PanelLayout | null, rect = fullPanelRect, path = ''): Array<{ path: string; rect: PanelRect; axis: 'x' | 'y'; ratio: number }> {
  if (!layout || layout.kind === 'page') return [];
  const first = layout.axis === 'x' ? { ...rect, width: rect.width * layout.ratio } : { ...rect, height: rect.height * layout.ratio };
  const second = layout.axis === 'x' ? { ...rect, x: rect.x + first.width, width: rect.width - first.width }
    : { ...rect, y: rect.y + first.height, height: rect.height - first.height };
  return [{ path, rect, axis: layout.axis, ratio: layout.ratio }, ...panelDividers(layout.first, first, path + '0'), ...panelDividers(layout.second, second, path + '1')];
}
