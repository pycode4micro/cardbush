import type { CanvasItem } from '@cardbush/bush-protocol';

export type CanvasFrame = CanvasItem['frame'];
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type AlignmentGuide = { axis: 'x' | 'y'; position: number; start: number; end: number };
type Bounds = { width: number; height: number };
type Target = { position: number; start: number; end: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Snap in screen pixels so alignment feels the same at every zoom level. */
export function adjustCanvasFrame({ frame, dx, dy, handle, bounds, peers = [], zoom = 1, snap = true }: {
  frame: CanvasFrame; dx: number; dy: number; handle?: ResizeHandle; bounds: Bounds;
  peers?: CanvasFrame[]; zoom?: number; snap?: boolean;
}): { frame: CanvasFrame; guides: AlignmentGuide[] } {
  let left = frame.x, top = frame.y, right = left + frame.width, bottom = top + frame.height;
  if (!handle) {
    left = clamp(Math.round(left + dx), 0, bounds.width - frame.width);
    top = clamp(Math.round(top + dy), 0, bounds.height - frame.height);
    right = left + frame.width; bottom = top + frame.height;
  } else {
    if (handle.includes('w')) left = clamp(Math.round(left + dx), Math.max(0, right - 10000), right - 80);
    if (handle.includes('e')) right = clamp(Math.round(right + dx), left + 80, Math.min(bounds.width, left + 10000));
    if (handle.includes('n')) top = clamp(Math.round(top + dy), Math.max(0, bottom - 10000), bottom - 60);
    if (handle.includes('s')) bottom = clamp(Math.round(bottom + dy), top + 60, Math.min(bounds.height, top + 10000));
  }
  const guides: AlignmentGuide[] = [];
  if (snap) {
    const targets = (axis: 'x' | 'y'): Target[] => {
      const horizontal = axis === 'x', limit = horizontal ? bounds.width : bounds.height;
      return [0, limit / 2, limit].map(position => ({ position, start: 0, end: horizontal ? bounds.height : bounds.width }))
        .concat(peers.flatMap(peer => {
          const start = horizontal ? peer.x : peer.y, length = horizontal ? peer.width : peer.height;
          return [start, start + length / 2, start + length].map(position => ({ position,
            start: horizontal ? peer.y : peer.x, end: horizontal ? peer.y + peer.height : peer.x + peer.width }));
        }));
    };
    const nearest = (axis: 'x' | 'y', anchors: number[], accepts: (delta: number) => boolean) => {
      let match: { delta: number; target: Target } | undefined;
      for (const target of targets(axis)) for (const anchor of anchors) {
        const delta = target.position - anchor;
        if (Math.abs(delta) <= 6 / zoom && accepts(delta) && (!match || Math.abs(delta) < Math.abs(match.delta))) match = { delta, target };
      }
      return match;
    };
    const x = nearest('x', !handle ? [left, (left + right) / 2, right] : handle.includes('w') ? [left] : handle.includes('e') ? [right] : [], delta => {
      if (!handle) return left + delta >= 0 && right + delta <= bounds.width;
      const a = handle.includes('w') ? left + delta : left, b = handle.includes('e') ? right + delta : right;
      return a >= 0 && b <= bounds.width && b - a >= 80 && b - a <= 10000;
    });
    if (x) { if (!handle || handle.includes('w')) left += x.delta; if (!handle || handle.includes('e')) right += x.delta; }
    const y = nearest('y', !handle ? [top, (top + bottom) / 2, bottom] : handle.includes('n') ? [top] : handle.includes('s') ? [bottom] : [], delta => {
      if (!handle) return top + delta >= 0 && bottom + delta <= bounds.height;
      const a = handle.includes('n') ? top + delta : top, b = handle.includes('s') ? bottom + delta : bottom;
      return a >= 0 && b <= bounds.height && b - a >= 60 && b - a <= 10000;
    });
    if (y) { if (!handle || handle.includes('n')) top += y.delta; if (!handle || handle.includes('s')) bottom += y.delta; }
    if (x) guides.push({ axis: 'x', position: x.target.position, start: Math.min(top, x.target.start), end: Math.max(bottom, x.target.end) });
    if (y) guides.push({ axis: 'y', position: y.target.position, start: Math.min(left, y.target.start), end: Math.max(right, y.target.end) });
  }
  return { frame: { x: left, y: top, width: right - left, height: bottom - top }, guides };
}

/** Fit against the same left edge as the workspace title, leaving room for item handles. */
export function fitCanvasViewport(view: Bounds, board: Bounds, inset: number) {
  return { zoom: clamp(Math.min((view.width - inset * 2) / board.width, (view.height - 80) / board.height), .02, 2),
    origin: { x: inset, y: 40 } };
}

/** Keep the canvas point under the zoom anchor stationary. Coordinates are relative to the fitted origin. */
export function zoomCanvasPan(pan: { x: number; y: number }, from: number, to: number, anchor = { x: 0, y: 0 }) {
  const ratio = to / from;
  return { x: pan.x * ratio + anchor.x * (1 - ratio), y: pan.y * ratio + anchor.y * (1 - ratio) };
}

export function equalCanvasFrames(a: CanvasFrame, b: CanvasFrame) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
