import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ConnectorBrowser } from './chromeConnectorWebSocket';

export function sharedBrowserDataRoot(profile: string): string {
  const physical = fs.realpathSync.native(profile);
  if (process.platform === 'win32' && /\\Packages\\[^\\]+\\LocalCache\\Roaming\\cardbush$/i.test(physical)) {
    const root = path.resolve(physical, '..', '..', '..', 'LocalState'); fs.mkdirSync(root, { recursive: true }); return root;
  }
  return physical;
}

/** One native dialog for the elected local broker, including when only the CLI
 * is running. Closing, cancelling or timing out always denies the request. */
export function requestBrowserConnectionApproval(nativeHostPath: string, browser: ConnectorBrowser, signal: AbortSignal): Promise<boolean> {
  if (process.platform !== 'win32' || signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile(nativeHostPath, ['--approve-browser-connection', browser], {
      windowsHide: true, encoding: 'utf8', timeout: 90_000, maxBuffer: 4096, signal,
    }, (error, stdout) => { resolve(!error && stdout.trim() === 'approved'); });
  });
}
