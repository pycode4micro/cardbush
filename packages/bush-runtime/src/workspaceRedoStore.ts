import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Exact after-images retained before a legacy Tool change is reverted.
 * Git-versioned workspaces already keep both versions in their snapshot store. */
export class WorkspaceRedoStore {
  readonly #memory = new Map<string, Buffer>();
  constructor(readonly directory?: string) {}

  async save(hash: string, content: Buffer): Promise<void> {
    this.#verify(hash, content);
    if (!this.directory) { this.#memory.set(hash, Buffer.from(content)); return; }
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${hash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, join(this.directory, hash));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async read(hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid workspace restore revision.');
    let content: Buffer | undefined;
    try { content = this.directory ? await readFile(join(this.directory, hash)) : this.#memory.get(hash); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!content) throw new Error('Cannot undo this revert: its saved after-image is unavailable.');
    this.#verify(hash, content);
    return content;
  }

  #verify(hash: string, content: Buffer) {
    if (!/^[a-f0-9]{64}$/.test(hash) || createHash('sha256').update(content).digest('hex') !== hash) {
      throw new Error('The saved workspace restore image does not match its revision.');
    }
  }
}
