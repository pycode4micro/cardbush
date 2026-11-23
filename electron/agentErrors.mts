export const agentBusyMessage = 'Wait for this Agent’s tasks to finish or stop them first.';

/** A temporary scheduling conflict, not a failed task or configuration. */
export class AgentBusyError extends Error {
  readonly code = 'agent_busy';
  constructor() { super(agentBusyMessage); }
}

export class AgentWebFileUnavailableError extends Error {
  readonly code = 'web_file_unavailable';
  constructor() { super('File unavailable.'); }
}

export function isAgentWebFileUnavailable(error: unknown): error is AgentWebFileUnavailableError {
  return error instanceof Error && 'code' in error && error.code === 'web_file_unavailable';
}
