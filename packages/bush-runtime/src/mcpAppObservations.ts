import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AppObservation = {
  sequence: number; turnId: string; toolCallId: string; source: string; resourceUri: string;
  viewId: string; event: 'resource_loading' | 'resource_loaded' | 'frame_loaded' | 'initialized' | 'failed' | 'closed';
  observedAt: string; detail?: string;
};
type Journal = { sequence: number; events: AppObservation[] };

/** Bounded, factual UI observations. No provider payloads or capability tokens. */
export class McpAppObservations {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly root: string) {}
  private file(session: string) { return join(this.root, createHash('sha256').update(session).digest('hex') + '.json'); }
  private async read(session: string): Promise<Journal> {
    try { return JSON.parse(await readFile(this.file(session), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return { sequence: 0, events: [] }; }
  }
  async append(session: string, event: Omit<AppObservation, 'sequence' | 'observedAt'>): Promise<void> {
    const pending = (this.writes.get(session) ?? Promise.resolve()).then(async () => {
      const journal = await this.read(session);
      const observed: AppObservation = { ...event, sequence: journal.sequence + 1, observedAt: new Date().toISOString() };
      const next = { sequence: observed.sequence, events: [...journal.events, observed].slice(-128) };
      await mkdir(this.root, { recursive: true });
      const file = this.file(session), temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx' }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    const settled = pending.catch(() => {});
    this.writes.set(session, settled);
    try { await pending; }
    finally { if (this.writes.get(session) === settled) this.writes.delete(session); }
  }
  async since(session: string, after = 0) {
    await this.writes.get(session);
    const journal = await this.read(session);
    return { protocol: 'bush.mcp_app_observations.v1', cursor: journal.sequence,
      truncated: journal.events.length > 0 && after < journal.events[0]!.sequence - 1,
      events: journal.events.filter(event => event.sequence > after) };
  }
  async flush() { await Promise.all(this.writes.values()); }
}
