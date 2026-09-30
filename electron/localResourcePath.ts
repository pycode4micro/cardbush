import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFileSystemPathFromProtocolUrl } from './localFileProtocol';

/** File readers accept explicit local resources, never reference IDs or cwd-relative strings. */
export function localResourcePath(value: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof value !== 'string') throw new Error('Resource requires an absolute local file path.');
  let target = value.trim();
  if (/^(?:file|cardbush-file):\/\//i.test(target)) {
    const url = new URL(target);
    if (url.username || url.password || url.port || url.search || url.hash) throw new Error('Invalid local file URL.');
    if (url.protocol === 'cardbush-file:' && ['ssh-file', 'text-preview', 'office-preview', 'office-source', 'model-preview'].includes(url.hostname.toLowerCase())) {
      throw new Error('Preview routes are not local file paths.');
    }
    target = url.protocol === 'file:' ? fileURLToPath(url, { windows: platform === 'win32' })
      : localFileSystemPathFromProtocolUrl(target, platform);
  }
  const absolute = platform === 'win32'
    ? /^[a-z]:[\\/]/i.test(target) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(target)
    : path.posix.isAbsolute(target);
  if (!absolute || /[\x00-\x1f\x7f]/.test(target)) throw new Error('Resource requires an absolute local file path.');
  return target;
}
