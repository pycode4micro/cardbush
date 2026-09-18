import { webContents, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

export type WindowMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'
  | 'zoomIn' | 'zoomOut' | 'resetZoom' | 'toggleFullscreen' | 'close' | 'quit';

function ownsRequest(event: IpcMainInvokeEvent, window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame);
}

/** Capture the editor before the title-bar menu takes keyboard focus. */
export function windowMenuContext(event: IpcMainInvokeEvent, window: BrowserWindow | null) {
  if (!ownsRequest(event, window)) throw new Error('Only the main window can open its application menu.');
  const focused = webContents.getFocusedWebContents();
  return { editTargetId: focused && (focused === window.webContents || focused.hostWebContents === window.webContents)
    ? focused.id : window.webContents.id };
}

export function executeWindowMenuAction(event: IpcMainInvokeEvent, window: BrowserWindow | null,
  action: unknown, editTargetId: unknown, quit: () => void) {
  if (!ownsRequest(event, window)) throw new Error('Only the main window can use its application menu.');
  switch (action) {
    case 'undo': case 'redo': case 'cut': case 'copy': case 'paste': case 'delete': case 'selectAll': {
      const target = typeof editTargetId === 'number' ? webContents.fromId(editTargetId) : window.webContents;
      if (!target || target.isDestroyed() || target !== window.webContents && target.hostWebContents !== window.webContents) {
        throw new Error('The original editor is no longer available.');
      }
      target.focus();
      target[action]();
      return;
    }
    case 'zoomIn': case 'zoomOut':
      window.webContents.setZoomLevel(Math.max(-3, Math.min(5,
        window.webContents.getZoomLevel() + (action === 'zoomIn' ? 0.5 : -0.5))));
      return;
    case 'resetZoom': window.webContents.setZoomLevel(0); return;
    case 'toggleFullscreen': window.setFullScreen(!window.isFullScreen()); return;
    case 'close': window.hide(); return;
    case 'quit': quit(); return;
    default: throw new Error('Unknown application menu action.');
  }
}
