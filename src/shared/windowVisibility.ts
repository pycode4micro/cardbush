const visibilityEvent = 'cardbush:window-visibility';
let nativeVisible = true;

export function isWindowVisible(): boolean {
  return nativeVisible && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
}

export function watchWindowVisibility(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', callback);
  document.addEventListener(visibilityEvent, callback);
  return () => {
    document.removeEventListener('visibilitychange', callback);
    document.removeEventListener(visibilityEvent, callback);
  };
}

/** Called once by the renderer entry point; never changes timer/audio policy. */
export function installWindowVisibility(): () => void {
  const desktop = window.cardbushDesktop;
  let disposed = false;
  let revision = 0;
  const apply = () => {
    document.documentElement.dataset.windowVisible = String(isWindowVisible());
  };
  const receive = (visible: boolean) => {
    if (disposed || typeof visible !== 'boolean') return;
    revision++;
    if (nativeVisible === visible) return;
    nativeVisible = visible;
    apply();
    document.dispatchEvent(new Event(visibilityEvent));
  };
  const unsubscribe = desktop?.onWindowVisibilityChanged?.(receive);
  const requestedAt = revision;
  void desktop?.isWindowVisible?.().then(visible => {
    // A show/hide event can overtake the initial IPC response.
    if (!disposed && requestedAt === revision) receive(visible);
  }).catch(() => {});
  document.addEventListener('visibilitychange', apply);
  apply();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    document.removeEventListener('visibilitychange', apply);
    nativeVisible = true;
    delete document.documentElement.dataset.windowVisible;
  };
}
