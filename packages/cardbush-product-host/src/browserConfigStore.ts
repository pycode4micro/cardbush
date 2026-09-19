import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserConfigurationSchema, browserStartPageSchema, defaultBrowserConfiguration, type BrowserConfiguration } from '@cardbush/bush-protocol';
import { replaceFile, withConfigFileLock } from './atomicFiles.js';

/** Host-owned preferences. Plugin install/uninstall never owns this configuration. */
export class BrowserConfigStore {
  constructor(readonly path: string) {
    if (!isAbsolute(path)) throw new Error('Browser configuration path must be absolute.');
  }
  async read(): Promise<BrowserConfiguration> {
    try { return browserConfigurationSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultBrowserConfiguration();
      throw error;
    }
  }
  async update(input: { startPage: string; expectedRevision: number }): Promise<BrowserConfiguration> {
    const startPage = browserStartPageSchema.parse(input?.startPage);
    return withConfigFileLock(this.path, async () => {
      const before = await this.read();
      if (input.expectedRevision !== before.revision) throw new Error('Browser settings changed. Refresh before saving again.');
      const next = { ...before, startPage, revision: before.revision + 1 };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
        await replaceFile(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
      return next;
    });
  }
}
