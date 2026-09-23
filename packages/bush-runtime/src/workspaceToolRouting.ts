import { parseSshWorkspace, sshWorkspace } from '@cardbush/bush-protocol';
import { posix } from 'node:path';
import type { ToolAdmissionContext, ToolHandlerContext, ToolRegistration } from './toolRegistry.js';
import type { RemoteWorkspaceBridge, TerminalSessionManager } from './workspaceTools.js';
import { protectedPosixTerminalDeletion } from './terminalCommandSafety.js';
import { sandboxError } from './executionSandbox.js';
import { commandPermission, terminalInputPermission } from './commandPermission.js';

type Context<T> = ToolAdmissionContext<T> | ToolHandlerContext<T>;
type RoutedInput = Record<string, unknown> & { environment?: string };
const handleTools = new Set(['terminal_poll', 'terminal_write', 'terminal_stop']);

function environment(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) throw Error('environment must be workspace, local, or an ssh://saved-connection-id/absolute/directory URI.');
  const result = value.trim();
  if (result !== 'workspace' && result !== 'local' && !parseSshWorkspace(result)) throw Error('Unknown execution environment. Use workspace, local, or an SSH workspace URI.');
  return result;
}

function defaultRoot<T>(context: Context<T>): string | undefined {
  const metadata = context.turn?.request.metadata;
  const root = metadata?.workspaceDir || metadata?.projectDir || metadata?.sessionWorkspaceDir;
  return typeof root === 'string' ? root : undefined;
}

function chosenRemote<T>(context: Context<T>): string | undefined {
  const selected = (context.input as RoutedInput).environment;
  if (selected === 'local') return;
  const root = !selected || selected === 'workspace' ? defaultRoot(context) : selected;
  return parseSshWorkspace(root) ? root : undefined;
}

/** A local override cannot inherit a remote path as a local cwd or permission root. */
function localContext<T, C extends Context<T>>(context: C): C {
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

/** Route each call explicitly; process handles retain their original host. */
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
    if (handleTools.has(name)) {
      const local = terminals.list(context.sessionId).find(item => item.terminalSessionId === input.sessionId);
      const terminal = local ?? (await remoteTerminals(context.sessionId, context.signal)).find(item => item.terminalSessionId === input.sessionId);
      if (!terminal) throw Error('Terminal session is not available in this Runtime session. Use terminal_list; do not restart the command.');
      const uri: string | undefined = local ? undefined : terminal.uri;
      if (!local && !parseSshWorkspace(uri)) throw Error('Remote terminal has no valid host identity.');
      if (input.environment !== undefined) {
        const requested = chosenRemote(context);
        if (parseSshWorkspace(requested)?.connectionId !== parseSshWorkspace(uri)?.connectionId) throw Error('The terminal belongs to a different execution environment. Omit environment to use its original host.');
      }
      return uri;
    }
    const uri = chosenRemote(context);
    const path = input.path ?? input.cwd;
    if (!uri && typeof path === 'string' && path.startsWith('ssh:')) throw Error('An SSH path requires an explicit SSH environment; it cannot be used as a local path.');
    return uri;
  }
  return {
    ...registration,
    definition: {
      ...registration.definition,
      description: registration.definition.description + ' environment selects workspace (default), local (this Runtime host), or ssh://saved-connection-id/directory. Local access remains available in SSH workspaces; use absolute local paths there. Terminal handles always stay on their original host; terminal_list without environment lists all hosts.',
      inputSchema: { ...registration.definition.inputSchema, properties: {
        ...(registration.definition.inputSchema.properties as Record<string, unknown>),
        environment: { type: 'string', description: 'workspace (default), local, or ssh://saved-connection-id/absolute/directory. Omit for polling/writing/stopping a terminal to follow its original host. Does not change the conversation workspace or grant permissions.' },
      } },
    },
    decodeInput(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Tool arguments must be an object.');
      const decoded = registration.decodeInput(value);
      const selected = environment((value as Record<string, unknown>)?.environment);
      return { ...decoded, ...(selected === undefined ? {} : { environment: selected }) };
    },
    authorize: async context => {
      if (name === 'terminal_list') return { kind: 'allow' as const };
      const uri = await route(context);
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
      if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) throw Error('SSH tools require POSIX paths. To access a local file, use environment="local".');
      const path = reference ? value : sshWorkspace(target.connectionId, posix.resolve(target.path, value));
      // Only the user-selected workspace is an implicit permission root. A model-
      // supplied environment must not turn an arbitrary server directory into one.
      const selectedRoot = defaultRoot(context);
      const trusted = parseSshWorkspace(selectedRoot)?.connectionId === target.connectionId ? selectedRoot : undefined;
      const resolved = await remote.request('authorize', { uri: trusted ?? uri, path, write: name === 'write_file' }, context.signal);
      const access = name === 'read_file' || name === 'search_file_content' ? 'read' : name === 'terminal_exec' ? 'execute' : 'write';
      if (name === 'terminal_exec') {
        const extra = input.additionalPermissions as { readRoots: string[]; writeRoots: string[]; network: boolean } | undefined;
        if (extra && (extra.readRoots.length || extra.writeRoots.length || extra.network)) throw sandboxError('sandbox_remote_unavailable', 'Direct SSH cannot enforce sandbox extensions. Connect to a CardBush Agent with its own execution policy. No remote command was sent.');
        if (input.shell !== 'posix') throw Error('SSH remote terminals require shell="posix".');
        for (const root of [parseSshWorkspace(resolved.root)!.path, target.path]) {
          const denied = protectedPosixTerminalDeletion({ command: String(input.command), cwd: parseSshWorkspace(resolved.path)!.path, root, home: resolved.home ?? '/' });
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
        const selected = (context.input as RoutedInput).environment;
        const uri = chosenRemote(context);
        if (selected !== undefined && uri && !remote) throw Error('SSH execution is unavailable in this host.');
        const locals = selected === undefined || !uri ? terminals.list(context.sessionId).map(item => tagged(item)) : [];
        const remotes = selected === 'local' || (selected !== undefined && !uri) ? [] : await remoteTerminals(context.sessionId, context.signal);
        const connectionId = parseSshWorkspace(uri)?.connectionId;
        return { sessions: [...locals, ...remotes.filter(item => selected === undefined || parseSshWorkspace(item.uri)?.connectionId === connectionId).map(item => tagged(item, item.uri))] };
      }
      const uri = await route(context);
      if (!uri) return tagged(await registration.execute(localContext(context)), undefined);
      if (!remote) throw Error('SSH execution is unavailable in this host. No local operation was performed.');
      enforceRemoteSandbox();
      return tagged(await remote.request('execute', { uri, owner: context.sessionId, name, input: context.input }, context.signal), uri);
    },
  };
}
