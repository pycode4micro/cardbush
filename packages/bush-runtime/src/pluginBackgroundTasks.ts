import { blobCacheEntries, memoryCacheEntry, temporaryCacheEntries } from './cacheMaintenance.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubagentTaskStore } from './subagentTaskStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import { settleAtAbort } from './abortSettlement.js';
import { briefText, catalogPage, catalogPageProperties, decodeCatalogQuery, type CatalogQuery } from './catalogPage.js';

export class PluginBackgroundTasks {
  get busy() { return this.active.size > 0; }
  async cacheEntries() {
    return [...await blobCacheEntries(this.root, 'plugin_background', name => /^[a-f0-9]{64}\.json$/.test(name)), ...await temporaryCacheEntries(this.root),
      ...[...this.delivered].map(([id, value]) => memoryCacheEntry('plugin_background', id, [...value], () => this.delivered.delete(id)))];
  }
  private readonly active = new Map<string, { session: string; turn: string; controller: AbortController; promise: Promise<unknown> }>();
  private readonly delivered = new Map<string, Set<string>>();
  constructor(private readonly root: string, private readonly tasks: SubagentTaskStore, registry: ToolRegistry) {
    registry.register<CatalogQuery & { action: string; ids: string[] }>({
      definition: { name: 'manage_plugin_agents', description: 'Manage background Agent tasks in this conversation. list returns paginated status summaries only; query filters task identity or status. read requires task_ids and returns their saved results. wait returns results after completion; stop cancels selected work and returns status. Background work may outlive the parent turn.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'wait', 'stop'] }, task_ids: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1 } }, ...catalogPageProperties }, required: ['action'], additionalProperties: false } },
      manifest: { effect_kind: 'observation', operation: 'agent.background.manage', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: input => {
        const value = input as Record<string, unknown>;
        if (!value || Array.isArray(value) || Object.keys(value).some(key => !['action', 'task_ids', 'query', 'offset', 'limit'].includes(key)) || !['list', 'read', 'wait', 'stop'].includes(String(value.action)) || (value.task_ids !== undefined && (!Array.isArray(value.task_ids) || value.task_ids.length > 32 || value.task_ids.some(id => typeof id !== 'string' || !id.trim())))) throw new Error('Invalid background Agent action.');
        const ids = value.task_ids as string[] ?? [];
        if (value.action === 'read' && !ids.length) throw new Error('read requires task_ids from list.');
        if (value.action !== 'list' && ['query', 'offset', 'limit'].some(key => value[key] !== undefined)) throw new Error('Pagination and query apply only to list.');
        return { ...decodeCatalogQuery(value), action: String(value.action), ids };
      },
      execute: async context => {
        await this.results(context.sessionId);
        const tasks = this.tasks.list(context.sessionId).filter(task => task.background);
        const ids = context.input.ids.length ? context.input.ids : tasks.map(task => task.taskId);
        if (ids.some(id => !tasks.some(task => task.taskId === id))) throw new Error('Background Agent task belongs to another conversation or is unavailable.');
        if (context.input.action === 'stop') ids.forEach(id => this.active.get(id)?.controller.abort());
        if (context.input.action === 'wait') await settleAtAbort(Promise.allSettled(ids.map(id => this.active.get(id)?.promise)), context.signal, 'Background Agent wait cancelled.');
        const selected = this.tasks.list(context.sessionId).filter(task => task.background && ids.includes(task.taskId));
        if (context.input.action === 'list' || context.input.action === 'stop') {
          const summaries = selected.map(({ taskId, childSessionId, childTurnId, status, finalResponse, errorMessage }) => ({ taskId, childSessionId, childTurnId, status, has_result: Boolean(finalResponse), error: briefText(errorMessage ?? '') }));
          const { items, ...page } = catalogPage(summaries, context.input);
          return { tasks: items, ...page };
        }
        return selected.map(({ taskId, childSessionId, childTurnId, status, finalResponse, errorMessage }) => ({ taskId, childSessionId, childTurnId, status, finalResponse, errorMessage }));
      },
    });
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
