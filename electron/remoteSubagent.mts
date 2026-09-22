import { setTimeout as delay } from 'node:timers/promises';
import type { RemoteSubagentRequest, RemoteSubagentResult, SessionSnapshot } from '@cardbush/bush-protocol';
import type { AgentConnectionManager } from './agentConnections.mjs';
import type { AgentJob } from './agentTypes.js';

function transient(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && (Boolean(error.cause) || /disconnected|stream timed out/.test(error.message)));
}

/** Credentials remain in the main process. A detached HTTP reader never owns the remote job. */
export async function runRemoteSubagent(manager: AgentConnectionManager, request: RemoteSubagentRequest, signal?: AbortSignal): Promise<RemoteSubagentResult> {
  signal?.throwIfAborted();
  const { connectionId, agentId, ...input } = request;
  const info = await manager.connect(connectionId);
  if (agentId && info.id !== agentId) throw new Error('Remote Agent identity changed.');
  if (!info.capabilities.delegation) throw new Error('Update this Agent service to enable remote subagent delegation.');
  let submitted = false;
  let cursor: number | undefined;
  const resultFor = async (job: AgentJob): Promise<RemoteSubagentResult> => {
    const snapshot = await manager.call(connectionId, 'sessions.get', { sessionId: input.sessionId }) as SessionSnapshot;
    const turn = snapshot.turns.find(item => item.turnId === input.turnId);
    return { status: job.status === 'completed' ? 'completed' : job.status === 'stopped' ? 'stopped' : 'failed',
      finalResponse: turn?.messages.filter(item => item.message.role === 'assistant' && typeof item.message.content === 'string').map(item => item.message.content).join('\n\n') ?? '',
      errorMessage: job.error ?? '', usage: turn?.usage ?? {} };
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      try {
        // This endpoint is idempotent by taskId, including uncertain acknowledgements.
        if (!submitted) { await manager.call(connectionId, 'delegation.submit', input); submitted = true; }
        const jobs = await manager.call(connectionId, 'chat.jobs', { sessionId: input.sessionId }) as AgentJob[];
        const job = jobs.find(item => item.id === input.taskId);
        if (!job) throw new Error('The remote delegated task is missing.');
        if (!['running', 'queued'].includes(job.status)) {
          return await resultFor(job);
        }
        for await (const frame of manager.events(connectionId, { sessionId: input.sessionId, turnId: input.turnId, ...(cursor === undefined ? {} : { afterSequence: cursor }) }, signal ?? new AbortController().signal)) {
          if (frame.type === 'event') cursor = frame.event.sequence;
        }
      } catch (error) {
        if (signal?.aborted || !transient(error)) throw error;
        await delay(1500, undefined, { signal });
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      // A submission may have been accepted even if its acknowledgement was lost.
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          const jobs = await manager.call(connectionId, 'chat.jobs', { sessionId: input.sessionId }) as AgentJob[];
          const owned = jobs.find(job => job.id === input.taskId);
          if (!owned) return { status: 'stopped', finalResponse: '', errorMessage: '', usage: {} };
          if (!['queued', 'running'].includes(owned.status)) return await resultFor(owned);
          if (attempt === 0) await manager.call(connectionId, 'chat.stop', { id: owned.id });
          await delay(500);
        }
        throw new Error('The remote task has not stopped yet.');
      } catch (failure) {
        throw new Error('Remote cancellation could not be confirmed. Inspect this task on the target Agent before retrying.', { cause: failure });
      }
    }
    throw error;
  }
}
