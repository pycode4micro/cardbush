import type { ToolRegistry, ToolResource } from './toolRegistry.js';

type Request = { resources: ToolResource[]; grant: () => void };
const schedulers = new WeakMap<ToolRegistry, ToolResourceScheduler>();
export function toolResourceScheduler(registry: ToolRegistry) {
  let scheduler = schedulers.get(registry);
  if (!scheduler) { scheduler = new ToolResourceScheduler(); schedulers.set(registry, scheduler); }
  return scheduler;
}
function conflicts(a: ToolResource[], b: ToolResource[]) {
  return a.some(left => b.some(right => left.key === right.key && (left.mode === 'write' || right.mode === 'write')));
}
/** FIFO for conflicting resources, concurrent for independent resources and readers. */
export class ToolResourceScheduler {
  private active = new Set<Request>();
  private pending: Request[] = [];
  acquire(resources: ToolResource[], signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const normalized = new Map<string, ToolResource>();
    for (const resource of resources) {
      if (!resource.key.trim()) throw Error('A tool resource requires a canonical key.');
      if (resource.capacity !== undefined && (!Number.isSafeInteger(resource.capacity) || resource.capacity < 1)) throw Error('Tool resource capacity must be a positive integer.');
      const previous = normalized.get(resource.key);
      const capacity = Math.min(previous?.capacity ?? Infinity, resource.capacity ?? Infinity);
      normalized.set(resource.key, { key: resource.key, mode: previous?.mode === 'write' ? 'write' : resource.mode,
        ...(Number.isFinite(capacity) ? { capacity } : {}) });
    }
    return new Promise((resolve, reject) => {
      const request: Request = { resources: [...normalized.values()], grant: () => {
        signal?.removeEventListener('abort', abort);
        this.active.add(request);
        let released = false;
        resolve(() => { if (!released) { released = true; this.active.delete(request); this.drain(); } });
      } };
      const abort = () => { this.pending = this.pending.filter(item => item !== request); reject(signal?.reason ?? new DOMException('Wait cancelled', 'AbortError')); this.drain(); };
      this.pending.push(request); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else this.drain();
    });
  }
  private drain() {
    const blocked: Request[] = [];
    for (const request of [...this.pending]) {
      const atCapacity = request.resources.some(resource => {
        const readers = [...this.active].flatMap(prior => prior.resources.filter(active => active.key === resource.key));
        const capacity = Math.min(resource.capacity ?? Infinity, ...readers.map(active => active.capacity ?? Infinity));
        return readers.length >= capacity;
      });
      if (atCapacity || [...this.active, ...blocked].some(prior => conflicts(prior.resources, request.resources))) { blocked.push(request); continue; }
      this.pending = this.pending.filter(item => item !== request); request.grant();
    }
  }
}
