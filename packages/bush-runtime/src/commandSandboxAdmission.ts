import { commandInvocation } from '@cardbush/platform';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimePermissionTarget } from '@cardbush/bush-protocol';
import type { ToolAdmissionContext, ToolAdmissionDecision } from './toolRegistry.js';
import { commandSandboxPolicy, type CommandSandboxConfiguration } from './commandSandboxPolicy.js';
import { canonicalSandboxRoots, sandboxError, type ExecutionSandboxPolicy } from './executionSandbox.js';
import { commandPermission } from './commandPermission.js';
import { allowedRoots, isWithin, normalizeIdentity, permissionBoundaryMode, resolveToolPath, workspaceRoot } from './workspaceAccessPolicy.js';

export interface AdditionalCommandPermissions {
  readRoots: string[];
  writeRoots: string[];
  network: boolean;
}
interface CommandInput {
  command: string; shell: 'cmd' | 'powershell' | 'posix';
  additionalPermissions?: AdditionalCommandPermissions;
  justification?: string;
}

export function decodeAdditionalCommandPermissions(value: unknown): AdditionalCommandPermissions | undefined {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('additional_permissions must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['read_roots', 'write_roots', 'network'].includes(key))) throw Error('Unknown additional_permissions field.');
  const paths = (key: string) => {
    const items = input[key];
    if (items == null) return [];
    if (!Array.isArray(items) || items.length > 32 || items.some(item => typeof item !== 'string' || !item.trim())) throw Error(`${key} must contain at most 32 directory paths.`);
    return [...new Set(items as string[])];
  };
  if (input.network != null && typeof input.network !== 'boolean') throw Error('additional_permissions.network must be a boolean.');
  return { readRoots: paths('read_roots'), writeRoots: paths('write_roots'), network: input.network === true };
}

/** Requested extensions never become execution policy without an exact grant. */
export async function commandSandboxPlan(configuration: CommandSandboxConfiguration,
  context: ToolAdmissionContext<CommandInput>, cwd: string,
): Promise<{ admission: ToolAdmissionDecision; policy?: ExecutionSandboxPolicy; requiredGrant?: string }> {
  const base = commandSandboxPolicy(configuration, context);
  if (!base) {
    const mode = permissionBoundaryMode(context);
    return { admission: commandPermission({ ...context.input, cwd, scope: { mode, roots: allowedRoots(context, mode) } }) };
  }
  // The selected host interpreter must be readable, including user-installed
  // PowerShell. No model-supplied executable or PATH entry is trusted here.
  const executable = commandInvocation(context.input.shell, context.input.command).executable;
  // Windows' public application/system directories already grant AppContainer
  // read access. Do not edit their protected ACLs or walk System32 per command.
  const systemRoots = [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value && isAbsolute(value)));
  const interpreterRoots = configuration.mode === 'auto' && process.platform === 'win32' && isAbsolute(executable) && !systemRoots.some(root => isWithin(root, executable))
    ? [dirname(executable)] : [];
  const [baseWritableRoots, readableRoots, configuredWriteRoots, cwdRoots] = await Promise.all([
    canonicalSandboxRoots(base.writableRoots), canonicalSandboxRoots([...(base.readableRoots ?? []), ...interpreterRoots]),
    canonicalSandboxRoots(configuration.writableRoots), canonicalSandboxRoots([cwd]),
  ]);
  const privateArea = await resolveToolPath(context, tmpdir());
  const workspace = workspaceRoot(context);
  const [workspacePath] = workspace ? await canonicalSandboxRoots([workspace]) : [];
  const commandDirectory = cwdRoots[0]!;
  cwd = commandDirectory;
  // A broad implicit workspace (notably a Windows home directory) can contain
  // the supervisor's TEMP directory. A narrower cwd must actually narrow this
  // grant. Explicit host roots and requested extensions are never dropped.
  let narrowed = false;
  const writableRoots = baseWritableRoots.map(root => {
    if (workspacePath && normalizeIdentity(root) === normalizeIdentity(workspacePath) &&
        !configuredWriteRoots.some(configured => normalizeIdentity(configured) === normalizeIdentity(root)) && isWithin(root, privateArea) &&
        isWithin(root, commandDirectory) && !isWithin(commandDirectory, privateArea)) {
      narrowed = true;
      return commandDirectory;
    }
    return root;
  });
  const requested = context.input.additionalPermissions;
  const [read, write] = await Promise.all([
    canonicalSandboxRoots(requested?.readRoots ?? []), canonicalSandboxRoots(requested?.writeRoots ?? []),
  ]);
  const covered = (path: string, roots: readonly string[]) => roots.some(root => isWithin(root, path));
  const extraWrite = write.filter(path => !covered(path, writableRoots));
  if (!covered(cwd, [...writableRoots, ...readableRoots, ...read, ...write])) extraWrite.push(cwd);
  const extraRead = read.filter(path => !covered(path, [...writableRoots, ...readableRoots, ...extraWrite]));
  const network = requested?.network === true && base.network !== 'enabled';
  const expanded = extraRead.length > 0 || extraWrite.length > 0 || network;
  if (expanded && configuration.mode === 'required') return { admission: { kind: 'deny', code: 'sandbox_host_limit',
    message: 'The requested directory or network access exceeds the host-enforced sandbox. A user approval cannot override this deployment policy.' } };
  const policy: ExecutionSandboxPolicy = { ...base, network: network ? 'enabled' : base.network,
    readableRoots: [...new Set([...readableRoots, ...extraRead])].sort(), writableRoots: [...new Set([...writableRoots, ...extraWrite])].sort(),
    ...(expanded || narrowed ? { requireCanonicalRoots: true } : {}) };
  if (policy.writableRoots.length + policy.readableRoots!.length > 64) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox roots.');
  if ([...policy.writableRoots, ...policy.readableRoots!].some(root => isWithin(root, privateArea))) {
    throw sandboxError('sandbox_policy_invalid', 'The selected workspace or access roots contain the sandbox supervisor directory. Use a dedicated workspace subdirectory as cwd (not the home or TEMP directory); the implicit workspace grant will be narrowed to that directory. Broad host-configured or additional roots must also be narrowed. No command was started.');
  }
  if (!expanded) return { admission: { kind: 'allow' }, policy };
  const invocation = JSON.stringify([context.input.shell, cwd, context.input.command, policy]);
  const requiredGrant = `command.sandbox:${createHash('sha256').update(invocation).digest('hex')}`;
  const targets: RuntimePermissionTarget[] = [
    { kind: 'process', value: invocation, label: `${context.input.shell}: ${context.input.command}` },
    { kind: 'filesystem_path', value: cwd, label: `cwd: ${cwd}` },
    ...extraRead.map(value => ({ kind: 'filesystem_path' as const, value, label: `Read: ${value}` })),
    ...extraWrite.map(value => ({ kind: 'filesystem_path' as const, value, label: `Write: ${value}` })),
    ...(network ? [{ kind: 'opaque' as const, value: 'sandbox:network:enabled', label: 'Network access (all destinations)' }] : []),
  ];
  return { policy, requiredGrant, admission: { kind: 'ask', request: {
    reason: `Additional sandbox access for this command and its child processes only. Isolation remains enabled.${context.input.justification ? ` Reason: ${context.input.justification}` : ''}`,
    actions: ['execute', ...extraRead.map(() => 'read'), ...extraWrite.map(() => 'write'), ...(network ? ['network'] : [])],
    targets, capabilityIds: [requiredGrant], scope: { mode: 'task_free', roots: writableRoots },
  } } };
}

export function authorizedCommandSandbox(plan: Awaited<ReturnType<typeof commandSandboxPlan>>, capabilityIds: readonly string[] = []): ExecutionSandboxPolicy | undefined {
  if (plan.admission.kind === 'deny') throw sandboxError(plan.admission.code, plan.admission.message);
  if (plan.requiredGrant && !capabilityIds.includes(plan.requiredGrant)) {
    throw sandboxError('sandbox_approval_changed', 'The command or its resolved access scope changed after approval. No command was started; request approval for the current scope.');
  }
  return plan.policy;
}
