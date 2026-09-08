import type { BrowserWindow } from 'electron';

/** A window can outlive its renderer. Deliver only to its current live frame. */
export function sendToLiveRenderer(window: BrowserWindow | null, channel: string, ...args: unknown[]): boolean {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return false;
  const frame = contents.mainFrame;
  if (frame.isDestroyed() || frame.detached) return false;
  try {
    frame.send(channel, ...args);
    return true;
  } catch (error) {
    // Keep the exact frame: navigation must not deliver an old notification to
    // a replacement document. Other errors (e.g. invalid payloads) stay visible.
    if (contents.isDestroyed() || contents.isCrashed() || frame.isDestroyed() || frame.detached) return false;
    throw error;
  }
}
