import type { CanvasItem, CreationCanvas } from '@cardbush/bush-protocol';

export type CanvasFrame = CanvasItem['frame'];
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type AlignmentGuide = { axis: 'x' | 'y'; position: number; start: number; end: number };
type Bounds = { width: number; height: number; x?: number; y?: number };
type Target = { position: number; start: number; end: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Snap in screen pixels so alignment feels the same at every zoom level. */
export function adjustCanvasFrame({ frame, dx, dy, handle, bounds, peers = [], zoom = 1, snap = true, snapToBounds = true }: {
  frame: CanvasFrame; dx: number; dy: number; handle?: ResizeHandle; bounds: Bounds;
  peers?: CanvasFrame[]; zoom?: number; snap?: boolean; snapToBounds?: boolean;
}): { frame: CanvasFrame; guides: AlignmentGuide[] } {
  const minX = bounds.x ?? 0, minY = bounds.y ?? 0;
  let left = frame.x, top = frame.y, right = left + frame.width, bottom = top + frame.height;
  if (!handle) {
    left = clamp(Math.round(left + dx), minX, bounds.width - frame.width);
    top = clamp(Math.round(top + dy), minY, bounds.height - frame.height);
    right = left + frame.width; bottom = top + frame.height;
  } else {
    if (handle.includes('w')) left = clamp(Math.round(left + dx), Math.max(minX, right - 10000), right - 80);
    if (handle.includes('e')) right = clamp(Math.round(right + dx), left + 80, Math.min(bounds.width, left + 10000));
    if (handle.includes('n')) top = clamp(Math.round(top + dy), Math.max(minY, bottom - 10000), bottom - 60);
    if (handle.includes('s')) bottom = clamp(Math.round(bottom + dy), top + 60, Math.min(bounds.height, top + 10000));
  }
  const guides: AlignmentGuide[] = [];
  if (snap) {
    const targets = (axis: 'x' | 'y'): Target[] => {
      const horizontal = axis === 'x', limit = horizontal ? bounds.width : bounds.height;
      const min = horizontal ? minX : minY;
      return (snapToBounds ? [min, (min + limit) / 2, limit] : []).map(position => ({ position, start: horizontal ? minY : minX, end: horizontal ? bounds.height : bounds.width }))
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
      if (!handle) return left + delta >= minX && right + delta <= bounds.width;
      const a = handle.includes('w') ? left + delta : left, b = handle.includes('e') ? right + delta : right;
      return a >= minX && b <= bounds.width && b - a >= 80 && b - a <= 10000;
    });
    if (x) { if (!handle || handle.includes('w')) left += x.delta; if (!handle || handle.includes('e')) right += x.delta; }
    const y = nearest('y', !handle ? [top, (top + bottom) / 2, bottom] : handle.includes('n') ? [top] : handle.includes('s') ? [bottom] : [], delta => {
      if (!handle) return top + delta >= minY && bottom + delta <= bounds.height;
      const a = handle.includes('n') ? top + delta : top, b = handle.includes('s') ? bottom + delta : bottom;
      return a >= minY && b <= bounds.height && b - a >= 60 && b - a <= 10000;
    });
    if (y) { if (!handle || handle.includes('n')) top += y.delta; if (!handle || handle.includes('s')) bottom += y.delta; }
    if (x) guides.push({ axis: 'x', position: x.target.position, start: Math.min(top, x.target.start), end: Math.max(bottom, x.target.end) });
    if (y) guides.push({ axis: 'y', position: y.target.position, start: Math.min(left, y.target.start), end: Math.max(right, y.target.end) });
  }
  return { frame: { x: left, y: top, width: right - left, height: bottom - top }, guides };
}

/** Saved dimensions describe the document, not an invisible wall in the editor. */
export function canvasEditBounds(board: Bounds): Bounds {
  return { x: board.width - 50000, y: board.height - 50000, width: 50000, height: 50000 };
}

/** Grow in all directions while preserving the existing nonnegative file format. */
export function updateCanvasFrame(document: CreationCanvas, id: string, frame: CanvasFrame) {
  const offset = { x: Math.max(0, -frame.x), y: Math.max(0, -frame.y) };
  return { offset, document: { ...document,
    width: Math.max(document.width, frame.x + frame.width) + offset.x,
    height: Math.max(document.height, frame.y + frame.height) + offset.y,
    items: document.items.map(item => {
      if (item.id !== id && !offset.x && !offset.y) return item;
      const next = item.id === id ? frame : item.frame;
      return { ...item, frame: { ...next, x: next.x + offset.x, y: next.y + offset.y } };
    }),
  } };
}

/** Fit the occupied area without changing saved frames; reserve the bottom controls. */
export function fitCanvasViewport(view: Bounds, board: Bounds & { items?: { frame: CanvasFrame }[] }, inset: number) {
  const frames = board.items?.map(item => item.frame) ?? [];
  const left = frames.length ? Math.min(...frames.map(frame => frame.x)) : 0;
  const top = frames.length ? Math.min(...frames.map(frame => frame.y)) : 0;
  const right = frames.length ? Math.max(...frames.map(frame => frame.x + frame.width)) : board.width;
  const bottom = frames.length ? Math.max(...frames.map(frame => frame.y + frame.height)) : board.height;
  const width = Math.max(1, view.width - inset * 2), height = Math.max(1, view.height - inset * 2 - 44);
  const zoom = Math.min(2, width / Math.max(1, right - left), height / Math.max(1, bottom - top));
  return { zoom, origin: { x: inset + (width - (right - left) * zoom) / 2 - left * zoom,
    y: inset + (height - (bottom - top) * zoom) / 2 - top * zoom } };
}

/** Present occupied canvas coordinates as one composition, without repacking regions. */
export function fitCanvasPresentation(view: Bounds, items: { frame: CanvasFrame }[], continuous: boolean) {
  const x = items.length ? Math.min(...items.map(item => item.frame.x)) : 0;
  const y = items.length ? Math.min(...items.map(item => item.frame.y)) : 0;
  const width = Math.max(1, ...items.map(item => item.frame.x + item.frame.width - x));
  const height = Math.max(1, ...items.map(item => item.frame.y + item.frame.height - y));
  const scale = Math.min(Math.max(1, view.width) / width, continuous ? Infinity : Math.max(1, view.height) / height);
  return { x, y, width: width * scale, height: height * scale, scale };
}

/** Keep the canvas point under the zoom anchor stationary. Coordinates are relative to the fitted origin. */
export function zoomCanvasPan(pan: { x: number; y: number }, from: number, to: number, anchor = { x: 0, y: 0 }) {
  const ratio = to / from;
  return { x: pan.x * ratio + anchor.x * (1 - ratio), y: pan.y * ratio + anchor.y * (1 - ratio) };
}

export function equalCanvasFrames(a: CanvasFrame, b: CanvasFrame) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
