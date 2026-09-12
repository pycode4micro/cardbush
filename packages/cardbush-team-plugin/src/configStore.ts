import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { load, dump, JSON_SCHEMA } from 'js-yaml';
import { replaceFile, withConfigFileLock } from '@cardbush/product-host';
import { defaultTeamConfiguration, teamConfigurationSchema, type TeamFileConfiguration, type TeamConfigurationReceipt } from './configuration.js';

const MAX_CONFIG_BYTES = 2_000_000;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export function decodeTeamConfigurationFile(text: string): TeamFileConfiguration {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('Team configuration exceeds 2 MB.');
  return teamConfigurationSchema.parse(load(text.replace(/^\uFEFF/, ''), { schema: JSON_SCHEMA }));
}
export function encodeTeamConfigurationFile(configuration: unknown, format: 'json' | 'yaml' = 'json'): string {
  const value = teamConfigurationSchema.parse(configuration);
  return format === 'yaml' ? dump(value, { noRefs: true, lineWidth: 100 }) : `${JSON.stringify(value, null, 2)}\n`;
}

/** One editable file is authoritative. Receipts detect GUI/external-editor conflicts. */
export class TeamConfigurationFileStore {
  readonly path: string;
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('Team configuration path must be absolute.');
    this.path = resolve(path);
  }
  read(migration?: unknown): Promise<TeamConfigurationReceipt> {
    return withConfigFileLock(this.path, async () => {
      try { return await this.#read(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const configuration = migration === undefined ? defaultTeamConfiguration() : teamConfigurationSchema.parse(migration);
        return this.#write(configuration);
      }
    });
  }
  write(configuration: unknown, expectedHash: string): Promise<TeamConfigurationReceipt> {
    const validated = teamConfigurationSchema.parse(configuration);
    return withConfigFileLock(this.path, async () => {
      const before = await this.#read();
      if (!expectedHash || before.contentHash !== expectedHash) throw new Error('Team configuration changed on disk. Refresh before saving.');
      return this.#write(validated);
    });
  }
  async #read(): Promise<TeamConfigurationReceipt> {
    const text = await readFile(this.path, 'utf8');
    return { path: this.path, contentHash: digest(text), configuration: decodeTeamConfigurationFile(text) };
  }
  async #write(configuration: TeamFileConfiguration): Promise<TeamConfigurationReceipt> {
    const text = encodeTeamConfigurationFile(configuration, /\.ya?ml$/i.test(extname(this.path)) ? 'yaml' : 'json');
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('Team configuration exceeds 2 MB.');
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await replaceFile(temporary, this.path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { path: this.path, contentHash: digest(text), configuration };
  }
}
