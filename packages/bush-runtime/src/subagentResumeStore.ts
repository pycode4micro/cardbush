import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runtimeSessionTurnRequestSchema, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';
import { cacheFiles, fileCacheEntry, temporaryCacheEntries } from './cacheMaintenance.js';

/** Latest execution configuration per child, retaining its original prefix and persisted session history. */
export class SubagentResumeStore {
  private memory = new Map<string, RuntimeSessionTurnRequest>();
  constructor(private directory?: string) {}
  async cacheEntries() {
    if (!this.directory) return [];
    const files = await cacheFiles(this.directory, name => /^[a-f0-9]{64}\.json$/.test(name));
    return [
      ...files.map(file => fileCacheEntry(file, 'subagent_resume', [basename(file.path, '.json')])),
      ...await temporaryCacheEntries(this.directory, /^[a-f0-9]{64}\.json\.[\w-]+\.tmp$/),
    ];
  }
  private path(session: string) { return join(this.directory!, `${createHash('sha256').update(session).digest('hex')}.json`); }
  async save(request: RuntimeSessionTurnRequest) {
    if (!this.directory) { this.memory.set(request.sessionId, structuredClone(request)); return; }
    await mkdir(this.directory, { recursive: true });
    const path = this.path(request.sessionId), temporary = `${path}.${request.turnId.replace(/[^a-zA-Z0-9_-]/g, '')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async load(session: string) {
    if (!this.directory) { const value = this.memory.get(session); return value && structuredClone(value); }
    try { return runtimeSessionTurnRequestSchema.parse(JSON.parse(await readFile(this.path(session), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async remove(session: string) {
    if (!this.directory) { this.memory.delete(session); return; }
    await unlink(this.path(session)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
