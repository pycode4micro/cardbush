import type { RuntimeEvent, RemoteObservation } from '@cardbush/bush-protocol';
import { projectSubagentObservation } from '@cardbush/bush-runtime';
import type { AgentJob } from './agentTypes.js';
export { permissionDigest } from '@cardbush/bush-runtime';

export function workerObservation(job: AgentJob, events: RuntimeEvent[], authority: 'parent_delegate' | 'human_required'): RemoteObservation {
  return projectSubagentObservation({ contextId: job.sessionId, taskId: job.id, status: job.status }, events, authority);
}
