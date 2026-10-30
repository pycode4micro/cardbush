import { parseSshWorkspace, sshWorkspace, windowsShellPath, workspaceChangeSchema } from '@cardbush/bush-protocol';
import { posix } from 'node:path';
import type { ToolAdmissionContext, ToolHandlerContext, ToolRegistration } from './toolRegistry.js';
import type { RemoteWorkspaceBridge, TerminalSessionManager } from './workspaceTools.js';
import { protectedPosixTerminalDeletion, protectedTerminalDeletion, type TerminalCommandShell } from './terminalCommandSafety.js';
import { resolveToolPath, normalizeIdentity } from './workspaceAccessPolicy.js';
import { sandboxError } from './executionSandbox.js';
import { commandPermission, terminalInputPermission } from './commandPermission.js';
import { uiText } from '@cardbush/platform/i18n';
import { executionWorkspace } from './workspaceExecutionMode.js';

type Context<T> = ToolAdmissionContext<T> | ToolHandlerContext<T>;
type RoutedInput = Record<string, unknown> & { environment?: string };
const handleTools = new Set(['terminal_poll', 'terminal_write', 'terminal_stop']);

function environment(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) throw Error(uiText()('workspace.executionEnvironmentMismatch'));
  const result = value.trim();
  if (result !== 'workspace' && result !== 'local' && !parseSshWorkspace(result)) throw Error(uiText()('workspace.executionEnvironmentMismatch'));
  return result;
}

function defaultRoot<T>(context: Context<T>): string | undefined {
  return executionWorkspace(context.turn?.request.metadata ?? {});
}

function chosenRemote<T>(context: Context<T>): string | undefined {
  const selected = (context.input as RoutedInput).environment;
  const workspace = defaultRoot(context);
  const root = !selected || selected === 'workspace' ? workspace : selected;
  if (parseSshWorkspace(root)?.connectionId !== parseSshWorkspace(workspace)?.connectionId) {
    throw Object.assign(new Error(uiText()('workspace.executionEnvironmentMismatch')), { code: 'workspace_environment_mismatch' });
  }
  return parseSshWorkspace(root) ? root : undefined;
}

export async function workspaceFileResources<T>(context: Context<T>, mutating: boolean) {
  const remote = parseSshWorkspace(chosenRemote(context));
  // Remote aliases/symlinks are resolved by that host. Serialize writes within
  // the connection until it can provide canonical resource keys, never guess.
  const key = remote ? `remote-files:${remote.connectionId}` : `file:${normalizeIdentity(await resolveToolPath(localContext(context), String((context.input as RoutedInput).path), mutating))}`;
  return [{ key, mode: mutating ? 'write' as const : 'read' as const }];
}

/** Keep remote references out of local permission roots. */
export function localContext<T, C extends Context<T>>(context: C): C {
  if (!context.turn) return context;
  const metadata = { ...context.turn.request.metadata };
  if (parseSshWorkspace(defaultRoot(context))) {
    delete metadata.workspaceDir; delete metadata.projectDir; delete metadata.sessionWorkspaceDir;
  }
  for (const key of ['taskRoots', 'userRoots']) {
    if (Array.isArray(metadata[key])) metadata[key] = metadata[key].filter(value => typeof value === 'string' && !value.startsWith('ssh:'));
  }
  return { ...context, turn: { ...context.turn, request: { ...context.turn.request, metadata } } };
}

function tag(uri?: string) {
  const remote = parseSshWorkspace(uri);
  return remote ? { kind: 'ssh', connectionId: remote.connectionId, workspaceDir: uri } : { kind: 'local' };
}

function tagged(result: unknown, uri?: string): unknown {
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, executionEnvironment: tag(uri) } : result;
}

/** The selected workspace determines the host, including access to old handles. */
export function routeWorkspaceTool<T>(registration: ToolRegistration<T>, terminals: TerminalSessionManager, remote?: RemoteWorkspaceBridge, requireCommandSandbox = false): ToolRegistration<T> {
  const name = registration.definition.name;
  function enforceRemoteSandbox() {
    if (requireCommandSandbox && (name === 'terminal_exec' || name === 'terminal_write')) {
      throw sandboxError('sandbox_remote_unavailable', 'This host requires command isolation, but the SSH workspace has no verified sandbox backend. Connect to a CardBush Agent with its own sandbox policy. No remote command was sent.');
    }
  }
  async function remoteTerminals(owner: string, signal?: AbortSignal): Promise<Array<Record<string, any>>> {
    return remote ? (await remote.request('terminals', { owner }, signal)).sessions : [];
  }
  async function route(context: Context<T>): Promise<string | undefined> {
    const input = context.input as RoutedInput;
    const selected = chosenRemote(context);
    if (handleTools.has(name)) {
      const connectionId = parseSshWorkspace(selected)?.connectionId;
      const local = selected ? undefined : terminals.list(context.sessionId).find(item => item.terminalSessionId === input.sessionId);
      const terminal = local ?? (selected ? (await remoteTerminals(context.sessionId, context.signal)).find(item =>
        item.terminalSessionId === input.sessionId && parseSshWorkspace(item.uri)?.connectionId === connectionId) : undefined);
      if (!terminal) throw Error('Terminal session is not available in this Runtime session. Use terminal_list; do not restart the command.');
      const uri: string | undefined = local ? undefined : terminal.uri;
      if (!local && !parseSshWorkspace(uri)) throw Error('Remote terminal has no valid host identity.');
      return uri;
    }
    const uri = selected;
    if (uri && name === 'terminal_exec' && (input.exclusiveResources as unknown[] | undefined)?.length) {
      throw Object.assign(new Error('Direct SSH does not support exclusive_resources. No command was sent. Use a CardBush Agent on that host for coordinated execution.'), { code: 'terminal_resource_coordination_unavailable' });
    }
    const path = input.path ?? input.cwd;
    if (!uri && typeof path === 'string' && path.startsWith('ssh:')) throw Error(uiText()('workspace.executionEnvironmentMismatch'));
    return uri;
  }
  return {
    ...registration,
    definition: {
      ...registration.definition,
      description: registration.definition.description + ' Runs only in the conversation\'s selected workspace environment. Terminal handles and terminal_list are restricted to that host. To change hosts, the user must switch the conversation workspace.',
    },
    decodeInput(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Tool arguments must be an object.');
      const decoded = registration.decodeInput(value);
      const selected = environment((value as Record<string, unknown>)?.environment);
      return { ...decoded, ...(selected === undefined ? {} : { environment: selected }),
        ...(name === 'terminal_exec' ? { shellSpecified: (value as Record<string, unknown>)?.shell !== undefined } : {}) };
    },
    authorize: async context => {
      const uri = await route(context);
      if (name === 'terminal_list') return { kind: 'allow' as const };
      if (!uri) {
        if (name === 'terminal_exec') {
          const shells = process.platform === 'win32' ? ['powershell', 'cmd'] : ['posix'];
          if (!shells.includes(String((context.input as RoutedInput).shell))) throw Error(`Local terminals require shell=${shells.join(' or ')} on ${process.platform}.`);
        }
        const decision = registration.authorize ? await registration.authorize(localContext(context)) : { kind: 'allow' as const };
        return decision.kind === 'ask' ? { ...decision, request: { ...decision.request, reason: `Local host: ${decision.request.reason}` } } : decision;
      }
      if (!remote) throw Error('SSH execution is unavailable in this host. No local operation was performed.');
      enforceRemoteSandbox();
      const input = context.input as RoutedInput;
      if (name === 'terminal_poll') return { kind: 'allow' as const };
      if (name === 'terminal_write') return terminalInputPermission({ sessionId: String(input.sessionId),
        chars: String(input.chars ?? ''), environment: uri });
      if (name === 'terminal_stop') return { kind: 'ask' as const, request: {
        reason: `SSH ${name}: ${uri}`, actions: ['stop'],
        targets: [{ kind: 'process' as const, value: String(input.sessionId), label: uri }],
        capabilityIds: [`ssh.${name}:${uri}:${input.sessionId}`],
      } };
      const target = parseSshWorkspace(uri)!;
      const value = String(input.path ?? input.cwd ?? '.');
      const reference = parseSshWorkspace(value);
      if (value.startsWith('ssh:') && !reference) throw Error('Invalid SSH path.');
      if (reference && reference.connectionId !== target.connectionId) throw Error('Path and execution environment refer to different SSH connections.');
      if (/^(?:\\\\|\/\/)/.test(value)) throw Error('UNC/device SSH paths are not supported; use an absolute drive path.');
      // The manager validates native paths against the detected remote OS. A
      // Windows-looking path must never cause a fallback to the local host.
      const path = reference || /^[A-Za-z]:/.test(value) ? value : sshWorkspace(target.connectionId, posix.resolve(target.path, value || '.'));
      // Only the user-selected workspace is an implicit permission root. A model-
      // supplied environment must not turn an arbitrary server directory into one.
      const selectedRoot = defaultRoot(context);
      const trusted = parseSshWorkspace(selectedRoot)?.connectionId === target.connectionId ? selectedRoot : undefined;
      const resolved = await remote.request('authorize', { uri: trusted ?? uri, path, write: name === 'write_file',
        ...(name === 'terminal_exec' ? { terminal: { ...(input.shellSpecified ? { shell: input.shell } : {}) } } : {}) }, context.signal);
      if (resolved.platform !== 'windows' && /^[a-z]:/i.test(value)) throw Error(uiText()('workspace.sshPosixPathRequired'));
      const access = name === 'read_file' || name === 'search_file_content' ? 'read' : name === 'terminal_exec' ? 'execute' : 'write';
      if (name === 'terminal_exec') {
        const extra = input.additionalPermissions as { readRoots: string[]; writeRoots: string[]; readFiles?: string[]; writeFiles?: string[]; network: boolean } | undefined;
        if (extra && (extra.readRoots.length || extra.writeRoots.length || extra.readFiles?.length || extra.writeFiles?.length || extra.network)) throw sandboxError('sandbox_remote_unavailable', 'Direct SSH cannot enforce sandbox extensions. Connect to a CardBush Agent with its own execution policy. No remote command was sent.');
        const windows = resolved.platform === 'windows';
        const shell = input.shellSpecified ? String(input.shell) : windows ? 'powershell' : 'posix';
        if (!(windows ? ['cmd', 'powershell'] : ['posix']).includes(shell)) throw Error(`SSH host is ${windows ? 'Windows; use shell="powershell" or shell="cmd"' : 'POSIX; use shell="posix"'}. No user command was sent.`);
        input.shell = shell;
        for (const root of [parseSshWorkspace(resolved.root)!.path, target.path]) {
          const denied = windows
            ? protectedTerminalDeletion({ command: String(input.command), cwd: windowsShellPath(parseSshWorkspace(resolved.path)!.path), shell: shell as TerminalCommandShell,
              projectRoots: root === '/' ? [] : [windowsShellPath(root)], remoteWindows: { home: windowsShellPath(resolved.home) } })
            : protectedPosixTerminalDeletion({ command: String(input.command), cwd: parseSshWorkspace(resolved.path)!.path, root, home: resolved.home ?? '/' });
          if (denied) return { kind: 'deny' as const, code: 'protected_path_delete_denied', message: denied.message, details: { protection: denied.protection, target: denied.target } };
        }
        return commandPermission({ command: String(input.command), cwd: resolved.path, shell: String(input.shell),
          scope: { mode: context.turn?.request.permissionMode === 'user_free' ? 'user_free' : 'task_free',
            roots: trusted ? [resolved.root] : [] } });
      }
      if (access === 'read' && trusted && resolved.inside) return { kind: 'allow' as const };
      return { kind: 'ask' as const, request: {
        reason: `SSH ${access}: ${resolved.path}`, actions: [access],
        targets: [{ kind: 'filesystem_path' as const, value: resolved.path }],
        capabilityIds: [`ssh.${access}:${resolved.path}`],
        scope: { mode: context.turn?.request.permissionMode === 'user_free' ? 'user_free' as const : 'task_free' as const, roots: trusted ? [resolved.root] : [] },
      } };
    },
    execute: async context => {
      if (name === 'terminal_list') {
        const uri = chosenRemote(context);
        if (uri && !remote) throw Error('SSH execution is unavailable in this host.');
        if (!uri) return { sessions: terminals.list(context.sessionId).map(item => tagged(item)) };
        const remotes = await remoteTerminals(context.sessionId, context.signal);
        const connectionId = parseSshWorkspace(uri)?.connectionId;
        return { sessions: remotes.filter(item => parseSshWorkspace(item.uri)?.connectionId === connectionId).map(item => tagged(item, item.uri)) };
      }
      const uri = await route(context);
      if (!uri) return tagged(await registration.execute(localContext(context)), undefined);
      if (!remote) throw Error('SSH execution is unavailable in this host. No local operation was performed.');
      enforceRemoteSandbox();
      const result = await remote.request('execute', { uri, owner: context.sessionId, name, input: context.input }, context.signal);
      if ((name === 'write_file' || name === 'edit_file') && result?.workspaceChange) {
        const change = workspaceChangeSchema.parse(result.workspaceChange);
        if (parseSshWorkspace(change.path)?.connectionId !== parseSshWorkspace(uri)?.connectionId) throw Error('SSH change belongs to another connection.');
        context.recordWorkspaceChange(change);
        const { workspaceChange: _change, ...receipt } = result;
        return tagged(receipt, uri);
      }
      return tagged(result, uri);
    },
  };
}
