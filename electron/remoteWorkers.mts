import { z } from 'zod';
import { remoteControlSchema, supportsRemoteInteraction, subagentInteractionCapabilitiesSchema, SUBAGENT_INTERACTION_OPERATIONS, type SessionSnapshot, type RemoteSubagentRequest } from '@cardbush/bush-protocol';
import type { AgentConnectionManager } from './agentConnections.mjs';
import { runRemoteSubagent } from './remoteSubagent.mjs';
import { workerConnectionStatus } from './workerConnectionStatus.mjs';
import { uiText } from '@cardbush/platform/i18n';

function connectionManagementFailure() {
  return Object.assign(new Error(uiText('en')('workerConnection.error.verification_failed')), { code: 'worker_connection_failed' });
}

const identity = z.object({ connectionId: z.string().min(1), agentId: z.string().min(1).optional(), parentSessionId: z.string().min(1) });
/** CardBush host adapter. Protocol operations do not expose Runtime commands or tool names. */
export async function callRemoteWorker(manager: AgentConnectionManager, operation: string, payload: unknown, signal?: AbortSignal, onAccepted?: () => void): Promise<unknown> {
  if (operation === 'agents.verify' || operation === 'agents.reconnect') {
    const input = z.object({ connectionId: z.string().min(1).max(200) }).strict().parse(payload);
    signal?.throwIfAborted();
    const list = () => manager.list().catch(() => { signal?.throwIfAborted(); throw connectionManagementFailure(); });
    const registered = await list();
    signal?.throwIfAborted();
    if (!registered.some(item => item.id === input.connectionId)) throw new Error('Unknown worker connection.');
    try { await (operation === 'agents.verify' ? manager.verify(input.connectionId) : manager.reconnect(input.connectionId)); }
    catch {
      // The boundary owns failure text, including unexpected cleanup/store errors.
      signal?.throwIfAborted();
      if (!(await list()).find(item => item.id === input.connectionId)?.connectionErrorCode) throw connectionManagementFailure();
    }
    signal?.throwIfAborted();
    const connection = (await list()).find(item => item.id === input.connectionId);
    signal?.throwIfAborted();
    if (!connection) throw new Error('Worker registration was removed.');
    return workerConnectionStatus(connection);
  }
  if (operation === 'agents.list') return (await manager.list()).filter(item => item.hasToken && !item.migrationIssue).map(item => ({ ...workerConnectionStatus(item),
    ...(supportsRemoteInteraction(item.info?.capabilities.workerInteraction) ? { interactionCapabilities: subagentInteractionCapabilitiesSchema.parse({ operations: item.info!.capabilities.workerInteraction!.operations ?? [...SUBAGENT_INTERACTION_OPERATIONS] }) } : {}) }));
  if (operation === 'agents.delegate') return runRemoteSubagent(manager, payload as RemoteSubagentRequest, signal, { onAccepted });
  if (operation === 'agents.control') {
    const input = identity.extend({ control: remoteControlSchema, worker: z.unknown().optional() }).strict().parse(payload);
    const info = await manager.connect(input.connectionId); signal?.throwIfAborted();
    if (!input.agentId || info.id !== input.agentId) throw new Error('Remote worker identity is not verified or has changed.');
    if (!supportsRemoteInteraction(info.capabilities.workerInteraction)) throw new Error('Update the remote worker to support this interaction protocol.');
    const operations = subagentInteractionCapabilitiesSchema.parse({ operations: info.capabilities.workerInteraction!.operations ?? [...SUBAGENT_INTERACTION_OPERATIONS] }).operations;
    if (!operations.includes(input.control.operation === 'message' ? input.control.delivery : input.control.operation)) throw new Error('unsupported_operation');
    return manager.call(input.connectionId, 'delegation.control', { parentSessionId: input.parentSessionId, control: input.control }, signal);
  }
  const input = identity.extend({ sessionId: z.string().min(1), turnId: z.string().optional(), messageId: z.string().optional(), content: z.string().optional(), worker: z.unknown().optional() }).strict().parse(payload);
  const info = await manager.connect(input.connectionId); signal?.throwIfAborted();
  if (!input.agentId || info.id !== input.agentId) throw new Error('Remote worker identity is not verified or has changed.');
  const session = await manager.call(input.connectionId, 'sessions.get', { sessionId: input.sessionId }, signal) as SessionSnapshot | undefined;
  if (!session || session.metadata?.delegationOwner !== input.parentSessionId) throw new Error('This child conversation belongs to another parent.');
  if (operation === 'agents.read-child') return session;
  if (operation !== 'agents.guide-child' || !input.turnId || !input.messageId || !input.content) throw new Error('Invalid worker operation.');
  return manager.call(input.connectionId, 'runtime.command', { kind: 'runtime.enqueue_guidance', payload: {
    protocol: 'bush.runtime_guidance.v1', sessionId: input.sessionId, turnId: input.turnId, messageId: input.messageId,
    content: input.content, createdAt: new Date().toISOString(), mode: 'interrupt_and_continue', metadata: { subagentAuthor: 'parent', realtimeParent: true },
  } }, signal);
}
