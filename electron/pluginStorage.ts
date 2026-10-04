import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function requireDiskSpace(destination: string, bytes: number) {
  const disk = await statfs(dirname(destination));
  if (bytes > disk.bavail * disk.bsize) throw Object.assign(new Error('Not enough disk space to download or extract this plugin. [market-disk-space]'), { code: 'ENOSPC' });
}
