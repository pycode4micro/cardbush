import fs from 'node:fs';
import path from 'node:path';

export function sharedBrowserDataRoot(profile: string): string {
  const physical = fs.realpathSync.native(profile);
  if (process.platform === 'win32' && /\\Packages\\[^\\]+\\LocalCache\\Roaming\\cardbush$/i.test(physical)) {
    const root = path.resolve(physical, '..', '..', '..', 'LocalState'); fs.mkdirSync(root, { recursive: true }); return root;
  }
  return physical;
}
