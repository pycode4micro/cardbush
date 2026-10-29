import { setTimeout as delay } from 'node:timers/promises';
import { supportsRemoteInteraction, subagentInteractionCapabilitiesSchema, SUBAGENT_INTERACTION_OPERATIONS } from '@cardbush/bush-protocol';
import type { RemoteSubagentRequest, RemoteSubagentResult, SessionSnapshot } from '@cardbush/bush-protocol';
import type { AgentJob, AgentInfo, AgentOperation, AgentEventRequest, AgentEventFrame } from './agentTypes.js';
import { AgentNetworkError, AgentHttpError } from './agentHttpClient.mjs';

export interface RemoteSubagentConnection {
  connect(id: string): Promise<AgentInfo>;
  call(id: string, operation: AgentOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  events(id: string, input: AgentEventRequest, signal: AbortSignal): AsyncIterable<AgentEventFrame>;
}

function transient(error: unknown): boolean {
  return error instanceof AgentNetworkError || error instanceof AgentHttpError && [408, 429, 502, 503, 504].includes(error.status)
    || error instanceof Error && /^Agent event stream (disconnected|timed out)/.test(error.message);
}

/** Credentials remain in the main process. A detached HTTP reader never owns the remote job. */
export async function runRemoteSubagent(manager: RemoteSubagentConnection, request: RemoteSubagentRequest, signal?: AbortSignal,
  recovery: { attempts?: number; delayMs?: number } = {}): Promise<RemoteSubagentResult> {
  signal?.throwIfAborted();
  const { connectionId, agentId, ...input } = request;
  const info = await manager.connect(connectionId);
  signal?.throwIfAborted();
  if (agentId && info.id !== agentId) throw new Error('Remote Agent identity changed.');
  if (!info.capabilities.delegation) throw new Error('Update this Agent service to enable remote subagent delegation.');
  if (input.worker && !supportsRemoteInteraction(info.capabilities.workerInteraction)) throw new Error('Update this worker service before using a registered role and interactive delegation.');
  if (input.queue && (!supportsRemoteInteraction(info.capabilities.workerInteraction) ||
      !subagentInteractionCapabilitiesSchema.parse({ operations: info.capabilities.workerInteraction!.operations ?? [...SUBAGENT_INTERACTION_OPERATIONS] }).operations.includes('queue'))) throw new Error('Worker queue capability is unavailable.');
  let submitted = false;
  let cursor: number | undefined;
  let failures = 0;
  const resultFor = async (job: AgentJob, readSignal = signal): Promise<RemoteSubagentResult> => {
    const snapshot = await manager.call(connectionId, 'sessions.get', { sessionId: input.sessionId }, readSignal) as SessionSnapshot;
    if (snapshot.sessionId !== input.sessionId || snapshot.metadata?.delegationOwner !== input.parentSessionId) throw new Error('Remote child ownership changed.');
    const turn = snapshot.turns.find(item => item.turnId === input.turnId);
    return { status: job.status === 'completed' ? 'completed' : job.status === 'stopped' ? 'stopped' : 'failed',
      finalResponse: [...(turn?.messages ?? [])].reverse().find(item => item.message.role === 'assistant'
        && !item.message.toolCalls?.length && item.metadata?.runtimeMaintenance !== 'context_compaction'
        && typeof item.message.content === 'string')?.message.content as string ?? '',
      errorMessage: job.error ?? '', usage: turn?.usage ?? {} };
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      try {
        // This endpoint is idempotent by taskId, including uncertain acknowledgements.
        if (!submitted) { await manager.call(connectionId, 'delegation.submit', input, signal); submitted = true; }
        const jobs = await manager.call(connectionId, 'chat.jobs', { sessionId: input.sessionId }, signal) as AgentJob[];
        const job = jobs.find(item => item.id === input.taskId);
        if (!job) throw new Error('The remote delegated task is missing.');
        if (job.sessionId !== input.sessionId || job.turnId !== input.turnId || job.delegation?.parentSessionId !== input.parentSessionId) throw new Error('Remote task ownership changed.');
        if (!['running', 'queued'].includes(job.status)) {
          return await resultFor(job);
        }
        for await (const frame of manager.events(connectionId, { sessionId: input.sessionId, turnId: input.turnId, ...(cursor === undefined ? {} : { afterSequence: cursor }) }, signal ?? new AbortController().signal)) {
          if (frame.type === 'event') { cursor = frame.event.sequence; failures = 0; }
          else if (frame.type === 'heartbeat') failures = 0;
        }
      } catch (error) {
        if (signal?.aborted || !transient(error)) throw error;
        if (++failures > (recovery.attempts ?? 5)) return { status: 'unavailable', finalResponse: '', usage: {},
          errorMessage: `Remote observation unavailable. Task ${input.taskId} may still be running; inspect the original task before starting replacement work.` };
        await delay(Math.min(15_000, (recovery.delayMs ?? 750) * 2 ** (failures - 1)), undefined, { signal });
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      // A submission may have been accepted even if its acknowledgement was lost.
      try {
        const confirmation = AbortSignal.timeout(15_000);
        for (let attempt = 0; attempt < 30; attempt++) {
          const jobs = await manager.call(connectionId, 'chat.jobs', { sessionId: input.sessionId }, confirmation) as AgentJob[];
          const owned = jobs.find(job => job.id === input.taskId);
          if (!owned) throw new Error('The submission outcome is unknown.');
          if (owned.sessionId !== input.sessionId || owned.turnId !== input.turnId || owned.delegation?.parentSessionId !== input.parentSessionId) throw new Error('Remote task ownership changed.');
          if (!['queued', 'running'].includes(owned.status)) return await resultFor(owned, confirmation);
          if (attempt === 0) await manager.call(connectionId, 'chat.stop', { id: owned.id }, confirmation);
          await delay(500, undefined, { signal: confirmation });
        }
        throw new Error('The remote task has not stopped yet.');
      } catch {
        return { status: 'unavailable', finalResponse: '', usage: {}, errorMessage: 'Remote cancellation could not be confirmed. Inspect this task on the target Agent before retrying.' };
      }
    }
    if (submitted) return { status: 'unavailable', finalResponse: '', usage: {},
      errorMessage: `Remote observation stopped after task acceptance. Task ${input.taskId} may still be running; verify its original service and inspect it before retrying. ${error instanceof Error ? error.message : String(error)}` };
    throw error;
  }
}
