import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ignoredDirectories = new Set(['node_modules', '.git', '.hg', '.svn', '.cache', '__pycache__', '.venv', 'venv']);
const imageExtension = /\.(png|apng|avif|jpe?g|webp|gif|bmp|ico|svg)$/i;
type Entry = { path: string; name: string };
type Scan = { id: string; iterator: AsyncGenerator<Entry | null>; cancelled: boolean; busy: boolean; skipped: number };

/** One cancellable, metadata-only scan per window. Never follows directory links. */
export class ImageGalleryScanner {
  #scans = new Map<number, Scan>();
  #starts = new Map<number, string>();

  async start(owner: number, root: string, recursive: boolean) {
    const request = randomUUID();
    const closing = this.close(owner);
    this.#starts.set(owner, request);
    try {
      await closing;
      const resolved = path.resolve(root);
      if (!path.isAbsolute(root) || !(await stat(resolved)).isDirectory()) throw new Error('Image gallery requires a local directory.');
      const canonical = await realpath(resolved);
      if (this.#starts.get(owner) !== request) throw new Error('Image gallery scan was superseded.');
      const scan: Scan = { id: randomUUID(), iterator: undefined!, cancelled: false, busy: false, skipped: 0 };
      scan.iterator = this.#walk(canonical, recursive, scan, 0);
      this.#scans.set(owner, scan);
      return this.next(owner, scan.id);
    } finally {
      if (this.#starts.get(owner) === request) this.#starts.delete(owner);
    }
  }

  async next(owner: number, id: string) {
    const scan = this.#scans.get(owner);
    if (!scan || scan.id !== id) throw new Error('Image gallery scan has closed.');
    if (scan.busy) throw new Error('Image gallery scan is already reading.');
    scan.busy = true;
    const images: Entry[] = [];
    let done = false;
    try {
      const started = Date.now();
      for (let visited = 0; visited < 512 && images.length < 128 && !scan.cancelled; visited++) {
        const result = await scan.iterator.next();
        if (result.done) { done = true; break; }
        if (result.value) images.push(result.value);
        if (Date.now() - started >= 100) break;
      }
      if (scan.cancelled) { await scan.iterator.return(undefined); done = true; }
      if (done && this.#scans.get(owner) === scan) this.#scans.delete(owner);
      return { id, images, done, skipped: scan.skipped };
    } catch (error) {
      await scan.iterator.return(undefined).catch(() => undefined);
      if (this.#scans.get(owner) === scan) this.#scans.delete(owner);
      throw error;
    } finally { scan.busy = false; }
  }

  async close(owner: number, id?: string) {
    if (!id) this.#starts.delete(owner);
    const scan = this.#scans.get(owner);
    if (!scan || (id && scan.id !== id)) return;
    this.#scans.delete(owner);
    scan.cancelled = true;
    if (!scan.busy) await scan.iterator.return(undefined);
  }

  async *#walk(root: string, recursive: boolean, scan: Scan, depth: number): AsyncGenerator<Entry | null> {
    if (depth > 64) { scan.skipped++; return; }
    let directory;
    try { directory = await opendir(root); }
    catch (error) { if (depth === 0) throw error; scan.skipped++; return; }
    for await (const entry of directory) {
      if (scan.cancelled) return;
      const target = path.join(root, entry.name);
      if (entry.isFile() && imageExtension.test(entry.name)) yield { path: target, name: entry.name };
      else yield null; // Budget non-image entries too, so huge trees yield control.
      if (recursive && entry.isDirectory() && !entry.name.startsWith('.') && !ignoredDirectories.has(entry.name)) {
        yield* this.#walk(target, true, scan, depth + 1);
      }
    }
  }
}
