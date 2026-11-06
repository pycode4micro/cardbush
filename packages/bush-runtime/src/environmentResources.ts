import type { RuntimeAgentFact, SubagentTask } from '@cardbush/bush-protocol';
import type { RuntimeEnvironment } from './runtimeEnvironment.js';
import { commandSandboxPolicyForRequest, snapshotCommandSandbox, type CommandSandboxConfiguration } from './commandSandboxPolicy.js';

/** Projects the delegation owner's ledger. Reading never polls or connects a remote Worker. */
export function remoteAgentFacts(tasks: SubagentTask[]): RuntimeAgentFact[] {
  const latest = new Map<string, SubagentTask>();
  for (const task of tasks) if (task.remote) latest.set(JSON.stringify([task.remote.connectionId, task.childSessionId]), task);
  return [...latest.values()].map(task => ({
    agentId: task.childSessionId, executionId: task.childTurnId, parentAgentId: task.parentSessionId,
    hostId: task.remote!.connectionId, transport: 'remote', role: 'child',
    status: task.status === 'running' ? task.observation?.state === 'input_required' ? 'waiting'
      : task.executionStartedAt || task.remoteAcceptedAt ? 'running' : 'queued' : task.status,
    observationStatus: task.observationError || task.status === 'unavailable' ? 'unavailable' : 'last_known',
    readOnly: null, canDelegate: false, canWake: false, startedAt: task.createdAt, updatedAt: task.updatedAt,
  }));
}

export function registerSandboxEnvironment(environment: RuntimeEnvironment, options: {
  commandSandbox?: CommandSandboxConfiguration; loadCommandSandbox?: () => Promise<CommandSandboxConfiguration>;
}) {
  environment.register('sandbox', async ({ request }) => {
    const configuration = options.loadCommandSandbox ? await options.loadCommandSandbox() : snapshotCommandSandbox(options.commandSandbox);
    if (configuration.mode === 'auto' && !request.permissionMode) return { mode: configuration.mode, active: null, reason: 'request_policy_unknown' };
    const policy = commandSandboxPolicyForRequest(configuration, { metadata: request.metadata, permissionMode: request.permissionMode ?? 'task_free' });
    return { mode: configuration.mode, active: !!policy, network: policy?.network ?? 'host',
      readableRoots: policy?.readableRoots ?? [], writableRoots: policy?.writableRoots ?? [] };
  });
}
