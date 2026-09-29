import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type PastedTextAttachment = { id: string; path: string; name: string; size: number };
export type PastedTextAttachmentApi = {
  create(text: string): Promise<PastedTextAttachment>;
  retain(ids: string[]): Promise<void>;
  discard(id: string): Promise<void>;
};
type Record = { name: string; updatedAt: number; state: 'writing' | 'draft' | 'retained' };
const maxBytes = 64 * 1024 * 1024;
const chunkBytes = 512 * 1024;
export const pastedTextDraftLifetime = 7 * 24 * 60 * 60 * 1000;
const validId = (id: string) => /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id);

/** Only generated text files live here. Sent files never expire or move. */
export class PastedTextAttachments {
  readonly root: string;
  #writes = Promise.resolve();
  #active = new Set<string>();
  #lastSweep = 0;
  constructor(root: string, private now = Date.now) { this.root = resolve(root); }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#writes.then(action);
    this.#writes = next.then(() => undefined, () => undefined);
    return next;
  }
  async #root() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await realpath(this.root) !== this.root) throw new Error('Text attachment storage must not be a symbolic link.');
  }
  async #directory(id: string, create = false) {
    if (!validId(id)) throw new Error('Invalid text attachment ID.');
    await this.#root();
    const directory = join(this.root, id);
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Invalid text attachment directory.');
    return directory;
  }
  async #record(directory: string): Promise<Record> {
    const path = join(directory, 'metadata.json');
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid text attachment metadata.');
    const value = JSON.parse(await readFile(path, 'utf8')) as Record;
    if (!/^pasted-text-[\dT-]+\.txt$/.test(value.name) || !Number.isFinite(value.updatedAt) || !['writing', 'draft', 'retained'].includes(value.state)) throw new Error('Invalid text attachment metadata.');
    return value;
  }
  async #save(directory: string, record: Record) {
    const temporary = join(directory, `metadata-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(directory, 'metadata.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  async #newRecord(directory: string) {
    const record: Record = { name: `pasted-text-${new Date(this.now()).toISOString().replace(/[:.Z]/g, '-')}.txt`, updatedAt: this.now(), state: 'writing' };
    await this.#save(directory, record);
    return record;
  }

  create(text: string): Promise<PastedTextAttachment> {
    return this.#serialize(async () => {
      if (typeof text !== 'string' || !text.length || text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('粘贴文本不能超过 64 MiB / Maximum pasted text size: 64 MiB');
      await this.#sweepIfDue();
      const id = randomUUID(), directory = await this.#directory(id, true);
      try {
        const record = await this.#newRecord(directory);
        const path = join(directory, record.name);
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await this.#save(directory, { ...record, state: 'draft' });
        this.#active.add(id);
        return { id, path, name: record.name, size: Buffer.byteLength(text, 'utf8') };
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    });
  }

  /** Chunked UTF-8 uploads stay below the Agent HTTP body limit. Retries are idempotent. */
  upload(input: { id: string; offset: number; content: string; complete: boolean }): Promise<PastedTextAttachment & { nextOffset: number }> {
    return this.#serialize(async () => {
      if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > maxBytes || typeof input.content !== 'string' || input.content.length > 710_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new Error('Invalid text attachment chunk.');
      const bytes = Buffer.from(input.content, 'base64');
      if (bytes.length > chunkBytes || input.offset + bytes.length > maxBytes) throw new Error('Maximum pasted text size: 64 MiB');
      await this.#sweepIfDue();
      const directory = await this.#directory(input.id, input.offset === 0);
      const record = await this.#record(directory).catch(error => { if (error.code === 'ENOENT' && input.offset === 0) return this.#newRecord(directory); throw error; });
      const path = join(directory, record.name);
      const exists = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (exists && (!exists.isFile() || exists.isSymbolicLink())) throw new Error('Invalid text attachment file.');
      const file = await open(path, exists ? 'r+' : 'wx', 0o600);
      let size = 0;
      try {
        size = (await file.stat()).size;
        if (size !== input.offset || record.state !== 'writing') {
          const previous = Buffer.alloc(bytes.length);
          const { bytesRead } = await file.read(previous, 0, previous.length, input.offset);
          if (size < input.offset + bytes.length || bytesRead !== bytes.length || !previous.equals(bytes)) throw new Error('Text attachment upload offset conflict.');
        } else {
          let written = 0;
          while (written < bytes.length) {
            const count = (await file.write(bytes, written, bytes.length - written, input.offset + written)).bytesWritten;
            if (!count) throw new Error('Text attachment write made no progress.');
            written += count;
          }
          size += bytes.length;
          await file.sync();
        }
        if (input.complete && size !== input.offset + bytes.length) throw new Error('Text attachment upload length conflict.');
      } finally { await file.close(); }
      if (record.state !== 'retained') await this.#save(directory, { ...record, updatedAt: this.now(), state: input.complete ? 'draft' : record.state });
      if (input.complete) this.#active.add(input.id);
      return { id: input.id, path, name: record.name, size, nextOffset: input.offset + bytes.length };
    });
  }

  retain(ids: string[]): Promise<void> {
    return this.#serialize(async () => {
      if (!Array.isArray(ids) || ids.length > 32) throw new Error('Invalid text attachment list.');
      for (const id of ids) {
        const directory = await this.#directory(id), record = await this.#record(directory);
        if (record.state === 'writing') throw new Error('Text attachment upload is incomplete.');
        const info = await lstat(join(directory, record.name));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Text attachment is unavailable.');
        await this.#save(directory, { ...record, state: 'retained' });
        this.#active.delete(id);
      }
    });
  }
  discard(id: string): Promise<void> {
    return this.#serialize(async () => {
      try {
        const directory = await this.#directory(id), record = await this.#record(directory);
        // A delayed remove request must never destroy a sent/queued reference.
        if (record.state !== 'retained') await rm(directory, { recursive: true, force: true });
        this.#active.delete(id);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  }
  sweep(): Promise<void> { return this.#serialize(() => this.#sweep()); }
  async #sweepIfDue() { if (this.now() - this.#lastSweep > 60 * 60 * 1000) await this.#sweep(); }
  async #sweep() {
    await this.#root();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name) || this.#active.has(entry.name)) continue;
      const directory = await this.#directory(entry.name);
      const record = await this.#record(directory).catch(() => undefined);
      if (record && record.state !== 'retained' && this.now() - record.updatedAt > pastedTextDraftLifetime) await rm(directory, { recursive: true, force: true });
    }
    this.#lastSweep = this.now();
  }
}
