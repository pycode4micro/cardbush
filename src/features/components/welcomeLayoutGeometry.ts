import type { ComponentItem, WelcomePlacement } from './componentModel';
import { moveComposerPlacement } from './composerLayoutGeometry';

export type LayoutPoint = { x: number; y: number };
export type AlignmentGuide = { axis: 'x' | 'y'; position: number };
export type LayoutSpace = { left: number; top: number; scaleX: number; scaleY: number; width: number; height: number; scrollLeft: number; scrollTop: number };

// Pointer coordinates and client rects are viewport pixels; layout sizes and scroll
// offsets are CSS pixels. Keep that conversion in one place (including app zoom).
export function layoutSpace(element: HTMLElement): LayoutSpace {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width / (element.offsetWidth || 1), scaleY = rect.height / (element.offsetHeight || 1);
  return { left: rect.left + element.clientLeft * scaleX, top: rect.top + element.clientTop * scaleY,
    scaleX: scaleX || 1, scaleY: scaleY || 1, width: element.clientWidth, height: element.clientHeight,
    scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
}

export function layoutPoint(space: LayoutSpace, clientX: number, clientY: number): LayoutPoint {
  return { x: (clientX - space.left) / space.scaleX + space.scrollLeft, y: (clientY - space.top) / space.scaleY + space.scrollTop };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// New components belong in the viewport the user is editing, even when the
// saved page has content far below it. Prefer nearby free space; on a full
// canvas, keep the new component visible and available to drag instead.
export function placeInViewport(item: ComponentItem, peers: WelcomePlacement[], space: LayoutSpace): WelcomePlacement {
  const canvasWidth = Math.max(1, space.width), gap = 16;
  const width = item.width / 12 * 90, w = canvasWidth * width / 100;
  const top = space.scrollTop + 40, height = Math.min(item.height, Math.max(40, space.height - 56));
  const left = canvasWidth * .05, right = canvasWidth * .95 - w;
  const bottom = Math.max(top, space.scrollTop + space.height - gap - height);
  const center = { x: (canvasWidth - w) / 2, y: (top + bottom) / 2 };
  const visible = peers.filter(peer => peer.y + peer.height + gap > top && peer.y - gap < bottom + height)
    .map(peer => ({ x: peer.x * canvasWidth / 100, y: peer.y, width: peer.width * canvasWidth / 100, height: peer.height }));
  const xs = new Set([center.x, left, right]), ys = new Set([center.y, top, bottom]);
  for (const peer of visible) {
    for (const x of [peer.x - gap - w, peer.x + peer.width + gap]) if (x >= left && x <= right) xs.add(x);
    for (const y of [peer.y - gap - height, peer.y + peer.height + gap]) if (y >= top && y <= bottom) ys.add(y);
  }
  const candidates = [...ys].flatMap(y => [...xs].map(x => ({ x, y })))
    .sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
  const point = candidates.find(({ x, y }) => visible.every(peer => x + w + gap <= peer.x || x >= peer.x + peer.width + gap ||
    y + height + gap <= peer.y || y >= peer.y + peer.height + gap)) ?? center;
  return { componentId: item.id, x: point.x / canvasWidth * 100, y: point.y, width, height };
}

function correction(anchors: number[], targets: number[], tolerance: number, min: number, max: number) {
  let best = 0, distance = tolerance + Number.EPSILON;
  for (const anchor of anchors) for (const target of targets) {
    const delta = target - anchor;
    if (delta >= min && delta <= max && Math.abs(delta) < distance) { best = delta; distance = Math.abs(delta); }
  }
  return best;
}

export function alignPlacement(item: WelcomePlacement, peers: WelcomePlacement[], kind: 'move' | 'resize', delta: LayoutPoint,
  space: Pick<LayoutSpace, 'width' | 'height' | 'scaleX' | 'scaleY'>, snap = true): { placement: WelcomePlacement; guides: AlignmentGuide[] } {
  if (item.componentId === 'system-input') {
    const placement = moveComposerPlacement(item, kind, delta, space);
    return { placement, guides: [{ axis: 'x', position: space.width / 2 },
      ...(placement.composerDock ? [{ axis: 'y' as const, position: placement.y + placement.height }] : [])] };
  }
  const width = Math.max(1, space.width), px = width / 100;
  let x = item.x * px, y = item.y, w = item.width * px, h = item.height;
  const minWidth = Math.min(width - x, width * .1);
  if (kind === 'move') { x = clamp(x + delta.x, 0, width - w); y = clamp(y + delta.y, 0, 10000); }
  else { w = clamp(w + delta.x, minWidth, width - x); h = clamp(h + delta.y, 40, 1200); }
  const targetsX = [0, width / 2, width], targetsY = [0, space.height / 2, space.height];
  for (const peer of peers) {
    if (peer.componentId === item.componentId) continue;
    targetsX.push(peer.x * px, (peer.x + peer.width / 2) * px, (peer.x + peer.width) * px);
    targetsY.push(peer.y, peer.y + peer.height / 2, peer.y + peer.height);
  }
  const anchorsX = () => kind === 'move' ? [x, x + w / 2, x + w] : [x + w];
  const anchorsY = () => kind === 'move' ? [y, y + h / 2, y + h] : [y + h];
  const guides: AlignmentGuide[] = [];
  if (snap) {
    const dx = correction(anchorsX(), targetsX, 6 / space.scaleX, kind === 'move' ? -x : minWidth - w, width - x - w);
    const dy = correction(anchorsY(), targetsY, 6 / space.scaleY, kind === 'move' ? -y : 40 - h, kind === 'move' ? 10000 - y : 1200 - h);
    if (kind === 'move') { x += dx; y += dy; } else { w += dx; h += dy; }
    for (const position of new Set(targetsX)) if (anchorsX().some(anchor => Math.abs(anchor - position) < .01)) guides.push({ axis: 'x', position });
    for (const position of new Set(targetsY)) if (anchorsY().some(anchor => Math.abs(anchor - position) < .01)) guides.push({ axis: 'y', position });
  }
  return { placement: { ...item, x: x / px, y, width: w / px, height: h }, guides };
}

export function boundToolbar(point: LayoutPoint, container: { width: number; height: number }, toolbar: { width: number; height: number }, top: number): LayoutPoint {
  return { x: clamp(point.x, 8, Math.max(8, container.width - toolbar.width - 8)),
    y: clamp(point.y, top, Math.max(top, container.height - toolbar.height - 8)) };
}
