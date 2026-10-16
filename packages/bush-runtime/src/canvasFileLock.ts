import { open, readFile, realpath, unlink, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Shared by the renderer file service and design tool, including separate processes. */
export async function withCanvasFileLock<T>(path: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = `${await realpath(path)}.canvas-lock`;
  const deadline = Date.now() + 4000;
  while (true) {
    signal?.throwIfAborted();
    try {
      const handle = await open(lock, 'wx');
      try { await handle.writeFile(String(process.pid)); } catch (error) { await handle.close(); await unlink(lock); throw error; }
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
      let abandoned = false;
      if (owner > 0) { try { process.kill(owner, 0); } catch (cause) { abandoned = (cause as NodeJS.ErrnoException).code === 'ESRCH'; } }
      else abandoned = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 30000;
      if (abandoned) { await unlink(lock).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw Error('CANVAS_BUSY: another canvas change is still being saved. Retry shortly.');
      await delay(40, undefined, { signal });
    }
  }
  try { return await run(); } finally { await unlink(lock).catch(() => {}); }
}
