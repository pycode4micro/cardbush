import { resolve } from 'node:path';
import { isWithin, normalizeIdentity } from './workspaceAccessPolicy.js';

interface Resource { kind: 'path' | 'host'; value: string }
interface Lease { owner: string; resources: Resource[] }

export function decodeExclusiveResources(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 4096 || /[\u0000-\u001f]/.test(item))) {
    throw new Error('exclusive_resources must contain at most 16 nonempty paths or host:name labels.');
  }
  return [...new Set((value as string[]).map(item => item.trim()))];
}

/** Cooperative leases shared by parent/child terminals and file edits in one Runtime process. */
export class ExclusiveResources {
  readonly #leases = new Set<Lease>();

  acquire(owner: string, cwd: string, values: readonly string[], code = 'terminal_resource_busy'): () => void {
    const resources = decodeExclusiveResources(values).map(value => {
      if (/^host:/i.test(value)) {
        if (!/^host:[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) throw new Error('Invalid host resource label.');
        return { kind: 'host' as const, value: value.toLowerCase() };
      }
      return { kind: 'path' as const, value: normalizeIdentity(resolve(cwd, value)) };
    });
    // Check the entire request before reserving anything, so conflicts cannot leak partial leases.
    for (const lease of this.#leases) {
      const conflict = resources.find(resource => lease.resources.some(held => overlaps(resource, held)));
      if (conflict) throw Object.assign(new Error(
        `Resource ${conflict.value} is held by ${lease.owner}. No operation was started. Wait for that operation to finish; do not bypass the lease or restart it.`,
      ), { code, resource: conflict.value, owner: lease.owner });
    }
    if (!resources.length) return () => {};
    const lease = { owner, resources };
    this.#leases.add(lease);
    return () => { this.#leases.delete(lease); };
  }
}

function overlaps(left: Resource, right: Resource): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'host' ? left.value === right.value
    : isWithin(left.value, right.value) || isWithin(right.value, left.value);
}

export const runtimeExclusiveResources = new ExclusiveResources();
