import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelRequest } from '@cardbush/bush-protocol';
import type { PluginHook } from './pluginExtensions.js';

/** Stores activation identities, never executable Hook definitions or trust decisions. */
export class PluginHookScopes {
  private readonly active = new Map<string, Set<string>>();
  private readonly queue = new Map<string, Promise<unknown>>();
  constructor(private readonly root: string) {}
  private file(session: string) { return join(this.root, `${createHash('sha256').update(session).digest('hex')}.json`); }
  private async read(session: string): Promise<Set<string>> {
    if (this.active.has(session)) return this.active.get(session)!;
    let ids: unknown = [];
    try { ids = JSON.parse(await readFile(this.file(session), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid plugin Hook activation store.');
    if (this.active.has(session)) return this.active.get(session)!;
    const value = new Set<string>(ids); this.active.set(session, value); return value;
  }
  async activate(session: string, id: string) {
    const pending = (this.queue.get(session) ?? Promise.resolve()).then(async () => {
      const ids = await this.read(session); if (ids.has(id)) return;
      const next = new Set(ids); next.add(id);
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.file(session)}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify([...next]), { flag: 'wx' }); await rename(temporary, this.file(session)); }
      finally { await unlink(temporary).catch(() => {}); }
      this.active.set(session, next);
    });
    this.queue.set(session, pending.catch(() => {})); await pending;
  }
  async select(hooks: PluginHook[], request: ModelRequest): Promise<PluginHook[]> {
    await this.queue.get(request.sessionId);
    const skills = new Set([...await this.read(request.sessionId), ...(Array.isArray(request.metadata.pluginScopedSkillIds) ? request.metadata.pluginScopedSkillIds.filter((id): id is string => typeof id === 'string') : [])]);
    const disabled = Array.isArray(request.metadata.disabledSkills) ? request.metadata.disabledSkills : [];
    return hooks.filter(hook => !hook.scope || (hook.scope.kind === 'agent'
      ? hook.scope.id === request.metadata.pluginAgentId
      : skills.has(hook.scope.id) && !disabled.includes(hook.scope.id) && !disabled.includes(hook.scope.id.split(':').at(-1))));
  }
  async remove(session: string) { await this.queue.get(session); this.active.delete(session); this.queue.delete(session); await unlink(this.file(session)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
