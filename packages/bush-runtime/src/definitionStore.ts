import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DefinitionReceipt } from '@cardbush/bush-protocol';

/** Small versioned definitions owned by one Runtime, shared by tools and native UI. */
export class DefinitionStore<T extends { id: string }> {
  private readonly records = new Map<string, DefinitionReceipt<T>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly parse: (value: unknown) => T, private readonly directory?: string) {}
  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => {}, () => {});
    return pending;
  }
  private file(id: string) { return join(this.directory!, `${createHash('sha256').update(id).digest('hex')}.json`); }
  private decode(value: unknown): DefinitionReceipt<T> {
    const record = value as DefinitionReceipt<unknown>;
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 1 || typeof record.updatedAt !== 'string') throw new Error('Invalid persisted definition.');
    return { revision: record.revision, updatedAt: record.updatedAt, definition: this.parse(record.definition) };
  }
  get(id: string): Promise<DefinitionReceipt<T> | undefined> {
    // Windows cannot replace a file while a status reader has it open.
    return this.serialize(() => this.read(id));
  }
  private async read(id: string): Promise<DefinitionReceipt<T> | undefined> {
    if (!this.directory) return structuredClone(this.records.get(id));
    try {
      const record = this.decode(JSON.parse(await readFile(this.file(id), 'utf8')));
      if (record.definition.id !== id) throw new Error('Definition identity mismatch.');
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  list(): Promise<Array<DefinitionReceipt<T>>> {
    return this.serialize(async () => {
      if (!this.directory) return structuredClone([...this.records.values()]);
      let files: string[];
      try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      return Promise.all(files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort().map(async file => this.decode(JSON.parse(await readFile(join(this.directory!, file), 'utf8')))));
    });
  }
  put(value: unknown, expectedRevision: number): Promise<DefinitionReceipt<T>> {
    const definition = this.parse(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expected_revision must be a nonnegative integer; use 0 to create.');
    return this.serialize(async () => {
      const before = await this.read(definition.id);
      if ((before?.revision ?? 0) !== expectedRevision) throw new Error('Definition changed. Read its current revision before saving.');
      const record = { revision: expectedRevision + 1, updatedAt: new Date().toISOString(), definition };
      if (this.directory) {
        await mkdir(this.directory, { recursive: true });
        const path = this.file(definition.id), temporary = `${path}.${randomUUID()}.tmp`;
        try { await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
        finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      } else this.records.set(definition.id, structuredClone(record));
      return structuredClone(record);
    });
  }
  remove(id: string, expectedRevision: number): Promise<void> {
    return this.serialize(async () => {
      const before = await this.read(id);
      if (!before || before.revision !== expectedRevision) throw new Error('Definition changed or unavailable. Read its current revision before deleting.');
      if (this.directory) await unlink(this.file(id)); else this.records.delete(id);
    });
  }
}
