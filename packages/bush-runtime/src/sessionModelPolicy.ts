import {
  modelMessageSchema,
  type RuntimeSessionTurnRequest,
  type SessionModelContract,
} from '@cardbush/bush-protocol';

export function systemPolicyIdentity(value: unknown): { id: string; version: string } | undefined {
  if (!value || typeof value !== 'object') return;
  const policy = value as Record<string, unknown>;
  return typeof policy.id === 'string' && policy.id && typeof policy.version === 'string' && policy.version
    ? { id: policy.id, version: policy.version } : undefined;
}

/** Only a product-declared version migration may replace a frozen contract.
 * Refresh named presentations, keeping every other Tool and its order stable.
 * Execution authorization is still checked against the live request/catalog. */
export function requestedSessionModelPolicyUpgrade(request: RuntimeSessionTurnRequest,
  saved: SessionModelContract | undefined): SessionModelContract | undefined {
  if (!saved) return;
  const policy = systemPolicyIdentity(request.metadata.systemPolicy);
  const migration = request.metadata.systemPolicy as { upgradeFrom?: unknown; refreshTools?: unknown } | undefined;
  if (!policy || policy.id !== saved.policyId || policy.version === saved.version ||
    !Array.isArray(migration?.upgradeFrom) || !migration.upgradeFrom.includes(saved.version)) return;
  const system = request.prefixMessages[0];
  if (system?.role !== 'system') throw new Error('A policy migration requires a leading system message.');
  const refresh = new Set(Array.isArray(migration.refreshTools) ? migration.refreshTools.filter(name => typeof name === 'string') : []);
  const current = new Map(request.tools.map(tool => [tool.name, tool]));
  // A restricted client without the replacement definition cannot complete an
  // atomic policy/schema migration. Keep the previous contract until it can.
  if (saved.tools.some(tool => refresh.has(tool.name) && !current.has(tool.name))) return;
  return { policyId: policy.id, version: policy.version, system,
    tools: saved.tools.map(tool => refresh.has(tool.name) ? current.get(tool.name)! : tool) };
}

/** Restore the durable presentation before history assembly. Version migrations
 * are separately committed at a Turn boundary, never during a running loop. */
export function restoreSessionModelPolicy(
  request: RuntimeSessionTurnRequest,
  saved: SessionModelContract | undefined,
) {
  const originalSystem = request.prefixMessages[0];
  const restore = (system: SessionModelContract['system']) => {
    request.prefixMessages[0] = structuredClone(system);
    const childPrefix = request.metadata.subagentChildPrefixMessages;
    const childSystem = Array.isArray(childPrefix) ? modelMessageSchema.safeParse(childPrefix[0]) : undefined;
    if (Array.isArray(childPrefix) && childSystem?.success && JSON.stringify(childSystem.data) === JSON.stringify(originalSystem)) {
      childPrefix[0] = structuredClone(system);
    }
  };
  if (saved) {
    restore(saved.system);
    request.metadata.systemPolicy = { id: saved.policyId, version: saved.version };
    return;
  }
  const policy = systemPolicyIdentity(request.metadata.systemPolicy);
  if (!policy) return;
  const system = request.prefixMessages[0];
  if (system?.role !== 'system') throw new Error('A versioned system policy requires a leading system message.');
  request.metadata.systemPolicy = policy;
}
