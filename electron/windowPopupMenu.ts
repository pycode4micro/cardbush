import type { BrowserWindow, Menu } from 'electron';

const openMenus = new WeakMap<BrowserWindow, () => void>();

/** A popup belongs to one visible window, not to the lifetime of the app. */
export function showWindowPopupMenu(target: BrowserWindow, menu: Menu): void {
  openMenus.get(target)?.();
  if (target.isDestroyed() || target.webContents.isDestroyed() || !target.isVisible() || target.isMinimized()) return;
  const contents = target.webContents;
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    target.removeListener('hide', close);
    target.removeListener('minimize', close);
    target.removeListener('closed', close);
    contents.removeListener('destroyed', close);
    if (openMenus.get(target) === close) openMenus.delete(target);
  };
  const close = () => {
    if (finished) return;
    cleanup();
    // Electron destroys native popups along with their window.
    if (!target.isDestroyed()) menu.closePopup(target);
  };
  openMenus.set(target, close);
  target.on('hide', close);
  target.on('minimize', close);
  target.once('closed', close);
  contents.once('destroyed', close);
  try { menu.popup({ window: target, callback: cleanup }); }
  catch (error) { cleanup(); throw error; }
}
