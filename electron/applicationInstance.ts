import type { App } from 'electron';

/** Claim before opening profiles, bridges or windows. Early relaunches wait for
 * bootstrap to create the first window instead of racing a second creation. */
export function installApplicationInstance(app: Pick<App, 'requestSingleInstanceLock' | 'exit' | 'on'>, restore: () => void) {
  const primary = app.requestSingleInstanceLock();
  let ready = false, pending = false;
  if (!primary) app.exit(0);
  else app.on('second-instance', () => {
    if (ready) restore();
    else pending = true;
  });
  return { primary, windowReady() {
    ready = true;
    if (pending) { pending = false; restore(); }
  } };
}
