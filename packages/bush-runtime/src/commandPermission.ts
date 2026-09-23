import { createHash } from 'node:crypto';
import type { RuntimePermissionScope } from '@cardbush/bush-protocol';
import type { ToolAdmissionDecision } from './toolRegistry.js';

/** A cwd grant is not authorization to run arbitrary commands in that directory. */
export function commandPermission(input: {
  command: string; cwd: string; shell: string; scope?: RuntimePermissionScope;
}): ToolAdmissionDecision {
  const invocation = JSON.stringify([input.shell, input.cwd, input.command]);
  return { kind: 'ask', request: {
    reason: 'This command requires approval outside an enforced command sandbox. Approval covers only this command, shell and working directory.',
    actions: ['execute'],
    targets: [
      { kind: 'filesystem_path', value: input.cwd },
      { kind: 'process', value: invocation, label: `${input.shell}: ${input.command}` },
    ],
    capabilityIds: [capability('execute', invocation)],
    ...(input.scope ? { scope: input.scope } : {}),
  } };
}

/** Interactive interpreters can execute new code supplied through stdin. */
export function terminalInputPermission(input: {
  sessionId: string; chars: string; environment: string;
}): ToolAdmissionDecision {
  if (!input.chars) return { kind: 'allow' };
  const invocation = JSON.stringify([input.environment, input.sessionId, input.chars]);
  return { kind: 'ask', request: {
    reason: 'Sending input to an unsandboxed process can execute another operation. Approval covers only this process and exact input.',
    actions: ['terminal.input'],
    targets: [{ kind: 'process', value: invocation,
      label: `${input.environment} · ${input.sessionId}\n${JSON.stringify(input.chars)}` }],
    capabilityIds: [capability('input', invocation)],
  } };
}

function capability(operation: string, invocation: string): string {
  return `command.${operation}:${createHash('sha256').update(invocation).digest('hex')}`;
}
