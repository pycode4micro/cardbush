import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export async function replaceFileWithRetry(temporary: string, file: string, beforeReplace?: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    // Revalidate on every attempt: another editor may have changed the destination
    // while Windows briefly prevented its replacement.
    await beforeReplace?.();
    try { await fs.rename(temporary, file); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Publish a complete private JSON file without removing the previous version.
 * Windows indexers can briefly hold either path during an atomic replacement. */
export async function writePrivateJson(file: string, value: unknown) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await replaceFileWithRetry(temporary, file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}
