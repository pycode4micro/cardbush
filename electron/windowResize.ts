import type { BrowserWindow, WillResizeDetails } from 'electron';

export type WindowResizeGesture = {
  phase: 'start' | 'end' | 'cancel';
  edge: WillResizeDetails['edge'];
  /** Content widths in renderer CSS pixels, independent of the display DPI. */
  startWidth: number;
  width: number;
};

/** Only native edge drags produce will-resize; maximize/restore and setBounds do not. */
export function installWindowResizeEvents(window: BrowserWindow) {
  let gesture: Omit<WindowResizeGesture, 'phase' | 'width'> | undefined;
  const width = () => window.getContentBounds().width / window.webContents.getZoomFactor();
  const send = (phase: WindowResizeGesture['phase']) => {
    if (gesture && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('window:resize-gesture', { ...gesture, phase, width: width() } satisfies WindowResizeGesture);
    }
  };
  const end = () => { send('end'); gesture = undefined; };
  const cancel = () => { send('cancel'); gesture = undefined; };
  const start = (_event: Electron.Event, bounds: Electron.Rectangle, details: WillResizeDetails) => {
    if (window.isMaximized() || window.isFullScreen()) return;
    if (!gesture && bounds.width === window.getBounds().width) return;
    if (gesture?.edge === details.edge) return;
    cancel();
    gesture = { edge: details.edge, startWidth: width() };
    send('start');
  };
  window.on('will-resize', start);
  window.on('resized', end);
  window.on('blur', end);
  window.on('maximize', cancel);
  window.on('unmaximize', cancel);
  window.on('enter-full-screen', cancel);
  window.on('leave-full-screen', cancel);
  const dispose = () => {
    cancel();
    window.off('will-resize', start);
    window.off('resized', end);
    window.off('blur', end);
    window.off('maximize', cancel);
    window.off('unmaximize', cancel);
    window.off('enter-full-screen', cancel);
    window.off('leave-full-screen', cancel);
    window.off('closed', dispose);
  };
  window.once('closed', dispose);
  return dispose;
}
