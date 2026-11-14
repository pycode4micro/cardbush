import type { WorkerConnectionSnapshot } from '@cardbush/bush-protocol';
import type { AgentConnection } from './agentTypes.js';

/** Project only host-owned diagnostics. Endpoints, credentials and HTTP bodies
 * never become model-facing environment or connection receipts. */
export function workerConnectionStatus(connection: AgentConnection): WorkerConnectionSnapshot {
  const { id, name, agentId, connected, lastCheckedAt, verifiedAt, connectionErrorCode, connectionError } = connection;
  return { id, name, connected, connectionState: connection.connectionState ?? 'unverified',
    ...(agentId ? { agentId } : {}), ...(lastCheckedAt ? { lastCheckedAt } : {}), ...(verifiedAt ? { verifiedAt } : {}),
    ...(connectionErrorCode ? { connectionErrorCode } : {}), ...(connectionError ? { connectionError } : {}) };
}
