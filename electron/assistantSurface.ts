import { screen, type BrowserWindow, type Rectangle } from 'electron';

export type AssistantSurface = 'capsule' | 'compose' | 'replies' | 'voice';
export const assistantCallPhases = ['connecting', 'listening', 'speaking', 'muted', 'error'] as const;
export type AssistantCallPhase = typeof assistantCallPhases[number];
const height = 40;
const inset = 6;
const desktopMargin = 12;
const anchors = new WeakMap<BrowserWindow, { x: number; y: number }>();
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

export function sizeAssistantSurface(win: BrowserWindow, mode: AssistantSurface, measuredReplyHeight: number) {
  const saved = anchors.get(win);
  const area = (saved ? screen.getDisplayNearestPoint(saved) : screen.getPrimaryDisplay()).workArea;
  // Keep the last pixel of the lower right corner on its own display at monitor boundaries.
  const anchor = saved ?? { x: area.x + area.width - desktopMargin - 1, y: area.y + area.height - desktopMargin - 1 };
  anchors.set(win, anchor);
  const zoom = win.webContents.getZoomFactor();
  const dip = (pixels: number) => Math.round(pixels * zoom);
  const width = Math.min(area.width, dip(mode === 'capsule' ? residentCapsuleSize.width : 344));
  const replyHeight = mode === 'replies' ? Math.min(dip(measuredReplyHeight), Math.max(1, area.height - dip(residentCapsuleSize.height + 6))) : 0;
  const targetHeight = dip(residentCapsuleSize.height) + (replyHeight ? replyHeight + dip(6) : 0);
  win.setMinimumSize(1, 1); win.setResizable(false);
  win.setBounds(fit({ x: anchor.x + 1 - width, y: anchor.y + 1 - targetHeight, width, height: targetHeight }, area));
  if (process.platform === 'win32' || process.platform === 'linux') {
    // Native regions are binary. Keep their edges outside the CSS curves and shadow
    // so the compositor can blend those pixels with the desktop.
    const client = win.getContentBounds();
    const padding = dip(inset);
    const rowWidth = mode === 'replies' ? Math.min(client.width, dip(residentCapsuleSize.width)) : client.width;
    const rowHeight = dip(residentCapsuleSize.height);
    const shape = roundedRows(client.width - rowWidth, client.height - rowHeight, rowWidth, rowHeight, rowHeight / 2);
    if (replyHeight) shape.push(...roundedRows(0, 0, client.width, replyHeight + 2 * padding, Math.min(dip(14), replyHeight / 2) + padding));
    win.setShape(shape);
  }
}

const dragOrigin = new WeakMap<BrowserWindow, Rectangle>();
export function dragAssistantSurface(win: BrowserWindow, action: unknown, dx: unknown, dy: unknown) {
  if (action === 'start') { dragOrigin.set(win, win.getBounds()); return; }
  if (action === 'end') { dragOrigin.delete(win); return; }
  const origin = dragOrigin.get(win);
  if (!origin || action !== 'move' || typeof dx !== 'number' || typeof dy !== 'number' ||
      !Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) || Math.abs(dx) > 65536 || Math.abs(dy) > 65536) return;
  const next = fit({ ...origin, x: origin.x + dx, y: origin.y + dy });
  anchors.set(win, { x: next.x + next.width - 1, y: next.y + next.height - 1 });
  win.setPosition(next.x, next.y);
}
