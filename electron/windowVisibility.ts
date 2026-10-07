import type { BrowserWindow } from 'electron';
import { sendToLiveRenderer } from './rendererDelivery';

const installed = new WeakMap<BrowserWindow, () => void>();

export function isWindowVisible(target: BrowserWindow): boolean {
  return !target.isDestroyed() && target.isVisible() && !target.isMinimized();
}

/** Background tasks/voice need unthrottled timers. Report native visibility
 * separately so decorative rendering can stop when the window is hidden. */
export function installWindowVisibilityEvents(target: BrowserWindow): () => void {
  const existing = installed.get(target);
  if (existing) return existing;
  const contents = target.webContents;
  let previous: boolean | undefined;
  let disposed = false;
  const publish = (force = false) => {
    if (disposed || contents.isDestroyed()) return;
    const visible = isWindowVisible(target);
    if (!force && visible === previous) return;
    if (sendToLiveRenderer(target, 'window:visibility-changed', visible)) previous = visible;
  };
  const update = () => publish();
  const ready = () => publish(true);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    target.removeListener('show', update);
    target.removeListener('hide', update);
    target.removeListener('minimize', update);
    target.removeListener('restore', update);
    target.removeListener('closed', dispose);
    contents.removeListener('dom-ready', ready);
    contents.removeListener('destroyed', dispose);
    installed.delete(target);
  };
  target.on('show', update);
  target.on('hide', update);
  target.on('minimize', update);
  target.on('restore', update);
  contents.on('dom-ready', ready);
  contents.once('destroyed', dispose);
  target.once('closed', dispose);
  installed.set(target, dispose);
  return dispose;
}
