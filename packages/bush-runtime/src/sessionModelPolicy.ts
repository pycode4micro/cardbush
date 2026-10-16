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

/** Restore the session's presentation before history assembly. Historical
 * templates and upgrade migrations are not part of runtime execution. */
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
