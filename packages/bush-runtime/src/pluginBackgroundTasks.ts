import { blobCacheEntries, memoryCacheEntry, temporaryCacheEntries } from './cacheMaintenance.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubagentTaskStore } from './subagentTaskStore.js';

export class PluginBackgroundTasks {
  get busy() { return this.active.size > 0; }
  async cacheEntries() {
    return [...await blobCacheEntries(this.root, 'plugin_background', name => /^[a-f0-9]{64}\.json$/.test(name)), ...await temporaryCacheEntries(this.root),
      ...[...this.delivered].map(([id, value]) => memoryCacheEntry('plugin_background', id, [...value], () => this.delivered.delete(id)))];
  }
  private readonly active = new Map<string, { session: string; turn: string; controller: AbortController; promise: Promise<unknown> }>();
  private readonly delivered = new Map<string, Set<string>>();
  constructor(private readonly root: string, private readonly tasks: SubagentTaskStore) {}
  async stopTask(session: string, id: string) {
    await this.results(session);
    const task = this.tasks.get(session, id);
    if (!task?.background) throw new Error('Background Agent task is unavailable in this conversation.');
    const active = this.active.get(id);
    if (active && active.session !== session) throw new Error('Background Agent task belongs to another conversation.');
    active?.controller.abort();
    return { task_id: id, stop_requested: !!active };
  }
  start<T>(session: string, turn: string, id: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active.size >= 8) {
      this.tasks.finish({ parentSessionId: session, taskId: id, status: 'failed', finalResponse: '', errorMessage: 'At most eight background plugin Agents can run concurrently.', usage: {} });
      throw new Error('At most eight background plugin Agents can run concurrently.');
    }
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => run(controller.signal)).finally(() => this.active.delete(id));
    this.active.set(id, { session, turn, controller, promise }); void promise.catch(() => {}); return promise;
  }
  stop(session?: string, turn?: string) { for (const entry of this.active.values()) if ((!session || entry.session === session) && (!turn || entry.turn === turn)) entry.controller.abort(); }
  private file(session: string) { return join(this.root, `${createHash('sha256').update(session).digest('hex')}.json`); }
  async results(session: string) {
    if (!this.delivered.has(session)) {
      let ids: unknown = []; try { ids = JSON.parse(await readFile(this.file(session), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid background Agent delivery store.');
      this.delivered.set(session, new Set(ids));
      // Persisted executions without a live owner were interrupted; never silently replay side effects.
      for (const task of this.tasks.list(session).filter(task => task.background && task.status === 'running' && !this.active.has(task.taskId))) this.tasks.finish({ ...task, status: 'stopped', finalResponse: '', errorMessage: 'Background Agent was interrupted by a runtime restart.', usage: task.usage });
    }
    return this.tasks.list(session).filter(task => task.background && task.status !== 'running' && !this.delivered.get(session)!.has(task.taskId));
  }
  async acknowledge(session: string, ids: string[]) {
    if (!ids.length) return; await this.results(session);
    const next = new Set([...this.delivered.get(session)!, ...ids]); await mkdir(this.root, { recursive: true });
    const temporary = `${this.file(session)}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify([...next]), { flag: 'wx' }); await rename(temporary, this.file(session)); }
    finally { await unlink(temporary).catch(() => {}); }
    this.delivered.set(session, next);
  }
}
