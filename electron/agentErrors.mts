export const agentBusyMessage = 'Wait for this Agent’s tasks to finish or stop them first.';

/** A temporary scheduling conflict, not a failed task or configuration. */
export class AgentBusyError extends Error {
  readonly code = 'agent_busy';
  constructor() { super(agentBusyMessage); }
}
