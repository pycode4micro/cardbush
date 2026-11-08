import { screen, type BrowserWindow, type Rectangle } from 'electron';

export type AssistantSurface = 'capsule' | 'compose' | 'replies';
const height = 40;
const inset = 4;
const anchors = new WeakMap<BrowserWindow, { x: number; y: number }>();
export const residentCapsuleSize = { width: 152, height: height + inset * 2 };

export function restoreAssistantFrame(win: BrowserWindow) {
  anchors.delete(win);
  if (process.platform === 'win32' || process.platform === 'linux') win.setShape([]);
  win.setResizable(true);
  win.setMinimumSize(480, 480);
}

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

export function sizeAssistantSurface(win: BrowserWindow, mode: AssistantSurface, workspaceFrame: boolean, measuredReplyHeight: number) {
  const before = win.getBounds();
  const anchor = anchors.get(win) ?? { x: before.x, y: before.y };
  anchors.set(win, anchor);
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  const captionBand = workspaceFrame && process.platform === 'win32' ? 40 : 0;
  const zoom = win.webContents.getZoomFactor();
  const dip = (pixels: number) => Math.round(pixels * zoom);
  const width = Math.min(area.width, dip(mode === 'capsule' ? residentCapsuleSize.width : 344));
  const replyHeight = mode === 'replies' ? Math.min(dip(measuredReplyHeight), Math.max(1, area.height - captionBand - dip(residentCapsuleSize.height + 6))) : 0;
  const targetHeight = dip(residentCapsuleSize.height) + captionBand + (replyHeight ? replyHeight + dip(6) : 0);
  win.setMinimumSize(1, 1); win.setResizable(false);
  win.setBounds(fit({ ...anchor, width, height: targetHeight }, area));
  if (workspaceFrame && (process.platform === 'win32' || process.platform === 'linux')) {
    // Retain the live workspace renderer. Only the pill and its reply sheet get
    // native paint/input regions; Windows' caption buttons sit above those regions.
    const client = win.getContentBounds(), outer = win.getBounds();
    const x = client.x - outer.x + dip(inset);
    const y = client.y - outer.y + client.height - targetHeight + captionBand + dip(inset);
    const rowWidth = mode === 'compose' ? client.width : Math.min(client.width,dip(residentCapsuleSize.width));
    const shape = roundedRows(x, y, rowWidth - 2 * dip(inset), dip(height), dip(height) / 2);
    if (replyHeight) shape.push(...roundedRows(x, y + dip(height + 6), client.width - 2 * dip(inset), replyHeight, Math.min(dip(14),replyHeight/2)));
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
  anchors.set(win, { x: next.x, y: next.y });
  win.setPosition(next.x, next.y);
}
