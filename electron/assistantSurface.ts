import { screen, type BrowserWindow, type Rectangle } from 'electron';

export type AssistantSurface = 'capsule' | 'compose' | 'replies' | 'voice';
export type AssistantSurfaceState = { surface: AssistantSurface; replyWidth?: number };
export const assistantCallPhases = ['connecting', 'listening', 'speaking', 'muted', 'error'] as const;
export type AssistantCallPhase = typeof assistantCallPhases[number];
const height = 40;
const inset = 6;
const desktopMargin = 12;
export const maxAssistantReplyHeight = 210;
const anchors = new WeakMap<BrowserWindow, { x: number; y: number }>();
const surfaceSizes = new WeakMap<BrowserWindow, Pick<Rectangle, 'width' | 'height'>>();
export const residentCapsuleSize = { width: 128 + inset * 2, height: height + inset * 2 };

function roundedRows(x: number, y: number, width: number, height: number, radius: number): Rectangle[] {
  const rows: Rectangle[] = [];
  for (let row = 0; row < height; row++) {
    const edge = Math.min(row + 0.5, height - row - 0.5, radius);
    const dx = Math.round(radius - Math.sqrt(radius ** 2 - (radius - edge) ** 2));
    rows.push({ x: x + dx, y: y + row, width: width - 2 * dx, height: 1 });
  }
  return rows;
}

function fit(bounds: Rectangle, area = screen.getDisplayMatching(bounds).workArea) {
  return { ...bounds, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) };
}

function surfaceGeometry(win: BrowserWindow) {
  const saved = anchors.get(win);
  const area = (saved ? screen.getDisplayNearestPoint(saved) : screen.getPrimaryDisplay()).workArea;
  const zoom = win.webContents.getZoomFactor();
  return { area, zoom, expandedWidth: Math.min(area.width, Math.round(344 * zoom)) };
}

export function assistantSurfaceState(win: BrowserWindow, surface: AssistantSurface): AssistantSurfaceState {
  if (surface !== 'replies') return { surface };
  const { expandedWidth, zoom } = surfaceGeometry(win);
  return { surface, replyWidth: expandedWidth / zoom - 2 * inset };
}

export function sizeAssistantSurface(win: BrowserWindow, mode: AssistantSurface, measuredReplyHeight = 0) {
  const { area, zoom, expandedWidth } = surfaceGeometry(win);
  // Keep the last pixel of the lower right corner on its own display at monitor boundaries.
  const anchor = anchors.get(win) ?? { x: area.x + area.width - desktopMargin - 1, y: area.y + area.height - desktopMargin - 1 };
  anchors.set(win, anchor);
  const dip = (pixels: number) => Math.round(pixels * zoom);
  const width = mode === 'capsule' ? Math.min(area.width, dip(residentCapsuleSize.width)) : expandedWidth;
  const replyHeight = mode === 'replies' ? Math.min(dip(measuredReplyHeight), Math.max(1, area.height - dip(residentCapsuleSize.height + 6))) : 0;
  const targetHeight = dip(residentCapsuleSize.height) + (replyHeight ? replyHeight + dip(6) : 0);
  const visible = fit({ x: anchor.x + 1 - width, y: anchor.y + 1 - targetHeight, width, height: targetHeight }, area);
  surfaceSizes.set(win, { width, height: targetHeight });
  // Resizing a visible transparent HWND discards its composed frame. Reserve the
  // backing surface once and expose only the control regions to paint and input.
  const fixedBacking = process.platform === 'win32';
  const backingWidth = fixedBacking ? expandedWidth : width;
  const backingHeight = fixedBacking ? Math.min(area.height, dip(residentCapsuleSize.height) + dip(6) + dip(maxAssistantReplyHeight)) : targetHeight;
  const x = visible.x + width - backingWidth, y = visible.y + targetHeight - backingHeight;
  const current = win.getBounds();
  if (current.width !== backingWidth || current.height !== backingHeight) win.setBounds({x, y, width: backingWidth, height: backingHeight});
  else if (current.x !== x || current.y !== y) win.setPosition(x, y);
  if (process.platform === 'win32' || process.platform === 'linux') {
    // Native regions are binary. Keep their edges outside the CSS curves and shadow
    // so the compositor can blend those pixels with the desktop.
    const client = win.getContentBounds();
    const padding = dip(inset);
    const rowWidth = mode === 'replies' || mode === 'capsule' ? Math.min(client.width, dip(residentCapsuleSize.width)) : client.width;
    const rowHeight = dip(residentCapsuleSize.height);
    const shape = roundedRows(client.width - rowWidth, client.height - rowHeight, rowWidth, rowHeight, rowHeight / 2);
    if (replyHeight) shape.push(...roundedRows(0, client.height - targetHeight, client.width, replyHeight + 2 * padding, Math.min(dip(14), replyHeight / 2) + padding));
    win.setShape(shape);
  }
}

const dragOrigin = new WeakMap<BrowserWindow, Rectangle>();
export function dragAssistantSurface(win: BrowserWindow, action: unknown, dx: unknown, dy: unknown) {
  if (action === 'start') {
    const bounds = win.getBounds();
    const { width, height } = surfaceSizes.get(win) ?? bounds;
    dragOrigin.set(win, { x: bounds.x + bounds.width - width, y: bounds.y + bounds.height - height, width, height });
    return;
  }
  if (action === 'end') { dragOrigin.delete(win); return; }
  const origin = dragOrigin.get(win);
  if (!origin || action !== 'move' || typeof dx !== 'number' || typeof dy !== 'number' ||
      !Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) || Math.abs(dx) > 65536 || Math.abs(dy) > 65536) return;
  const next = fit({ ...origin, x: origin.x + dx, y: origin.y + dy });
  anchors.set(win, { x: next.x + next.width - 1, y: next.y + next.height - 1 });
  const current = win.getBounds();
  win.setPosition(next.x + next.width - current.width, next.y + next.height - current.height);
}
