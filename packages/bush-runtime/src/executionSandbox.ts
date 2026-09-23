import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createPlatformContext, findExecutable } from '@cardbush/platform';

const execFileAsync = promisify(execFile);
const windowsCapabilities = new Map<string, Promise<void>>();
const linuxCapabilities = new Map<string, Promise<void>>();

/** Resolve only host configuration/PATH, never a command's environment or cwd. */
export async function resolveLinuxSandboxExecutable(configured?: string, hostPath = process.env.PATH ?? ''): Promise<string> {
  const candidate = configured ?? findExecutable('bwrap', createPlatformContext({
    platform: 'linux', env: { PATH: hostPath.split(':').filter(path => isAbsolute(path)).join(':') },
  }));
  if (!candidate || !isAbsolute(candidate)) throw sandboxError('sandbox_unavailable', 'No bubblewrap executable was found in the host PATH. Install it using the host distribution or set CARDBUSH_BWRAP_PATH. No command was started.');
  let executable: string;
  try { executable = await realpath(candidate); }
  catch { throw sandboxError('sandbox_unavailable', 'The configured bubblewrap executable is missing. No command was started.'); }
  // Discovery must not select a backend that a workspace command can replace.
  for (let current = executable; ; current = dirname(current)) {
    const metadata = await stat(current);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || (current === executable && !metadata.isFile())) {
      throw sandboxError('sandbox_unavailable', 'Bubblewrap and its resolved parent directories must be root-owned and not writable by group or others. Use an administrator-managed installation.');
    }
    if (dirname(current) === current) break;
  }
  return executable;
}

async function requireLinuxSandbox(executable: string, network: ExecutionSandboxPolicy['network'], env: NodeJS.ProcessEnv): Promise<void> {
  const metadata = await stat(executable);
  const key = JSON.stringify([executable, metadata.ino, metadata.mtimeMs, network]);
  let pending = linuxCapabilities.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        // Fixed, inert host code: test the current service account's namespaces
        // before launching any user command. No distro/version assumptions.
        await execFileAsync(executable, [...linuxNamespaceArgs(network), '--ro-bind', '/', '/',
          '--proc', '/proc', '--dev', '/dev', '--', process.execPath, '-e', 'process.exit(0)'],
        { env, timeout: 10_000, maxBuffer: 4096 });
      } catch (error) {
        const detail = String((error as { stderr?: unknown }).stderr ?? (error as Error).message).trim().slice(0, 1200);
        throw sandboxError('sandbox_unavailable', `This account cannot create the requested Linux sandbox. Check kernel user namespaces, container policy and any active LSM (AppArmor/SELinux). No user command was started. Backend: ${detail}`);
      }
    })();
    linuxCapabilities.set(key, pending);
    void pending.catch(() => linuxCapabilities.delete(key));
  }
  await pending;
}

function linuxNamespaceArgs(network: ExecutionSandboxPolicy['network']): string[] {
  return ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc',
    '--cap-drop', 'ALL', ...(network === 'disabled' ? ['--unshare-net'] : [])];
}

async function requireWindowsSandbox(host: string): Promise<void> {
  let pending = windowsCapabilities.get(host);
  if (!pending) {
    pending = (async () => {
      try {
        const result = await execFileAsync(host, ['--capabilities'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
        const capabilities = JSON.parse(result.stdout);
        if (capabilities.protocol !== 'cardbush.process-host.v1' || capabilities.sandboxVersion !== 1) throw Error('Unsupported sandbox host.');
      } catch {
        throw sandboxError('sandbox_unavailable', 'The Windows command sandbox is missing, incompatible, or blocked by application control. No command was started.');
      }
    })();
    windowsCapabilities.set(host, pending);
    void pending.catch(() => windowsCapabilities.delete(host));
  }
  await pending;
}

/** Host-owned policy. Never decoded from a model's tool arguments. */
export interface ExecutionSandboxPolicy {
  writableRoots: readonly string[];
  readableRoots?: readonly string[];
  network: 'disabled' | 'enabled';
  linuxExecutable?: string;
  /** Granted scopes were already canonicalized; never silently retarget them. */
  requireCanonicalRoots?: boolean;
}

export interface ExecutionSandboxStatus {
  backend: 'windows-appcontainer' | 'linux-bubblewrap';
  network: 'disabled' | 'enabled';
}

export interface PreparedExecutionSandbox {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsPolicyPath?: string;
  status: ExecutionSandboxStatus;
  dispose: (nativeCleanupConfirmed?: boolean) => Promise<void>;
}

/** No host tokens, private RPC addresses, preload scripts or shell profiles. */
export function sandboxEnvironment(source: NodeJS.ProcessEnv, privateRoot: string): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_[A-Z_]+|TERM|COLORTERM)$/i;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (allowed.test(key) && value !== undefined) environment[key] = value;
  return Object.assign(environment, {
    HOME: privateRoot, USERPROFILE: privateRoot,
    APPDATA: join(privateRoot, 'config'), LOCALAPPDATA: join(privateRoot, 'local'),
    XDG_CONFIG_HOME: join(privateRoot, 'config'), XDG_CACHE_HOME: join(privateRoot, 'cache'),
    TMPDIR: join(privateRoot, 'tmp'), TEMP: join(privateRoot, 'tmp'), TMP: join(privateRoot, 'tmp'),
  });
}

export async function canonicalSandboxRoots(values: readonly string[]): Promise<string[]> {
  if (!Array.isArray(values) || values.length > 64) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox roots.');
  return [...new Set(await Promise.all(values.map(async value => {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.includes('\0')) {
      throw sandboxError('sandbox_policy_invalid', 'Sandbox roots must be absolute directories.');
    }
    const path = await realpath(value);
    if (path === parse(path).root || path.startsWith('\\\\') || !(await stat(path)).isDirectory()) {
      throw sandboxError('sandbox_policy_invalid', 'A volume root, network share or file cannot be a sandbox root.');
    }
    return path;
  })))];
}

export async function prepareExecutionSandbox(input: {
  executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv;
  policy: ExecutionSandboxPolicy; windowsHostPath?: string; signal?: AbortSignal;
}): Promise<PreparedExecutionSandbox> {
  input.signal?.throwIfAborted();
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw sandboxError('sandbox_unavailable', 'This host has no supported command sandbox. No command was started.');
  }
  const network = input.policy.network;
  if (network !== 'disabled' && network !== 'enabled') throw sandboxError('sandbox_policy_invalid', 'Invalid sandbox network policy.');
  // Snapshot every field before asynchronous setup; callers cannot broaden a live policy.
  const writableInput = [...input.policy.writableRoots];
  const readableInput = [...(input.policy.readableRoots ?? [])];
  const linuxExecutable = input.policy.linuxExecutable;
  const requireCanonicalRoots = input.policy.requireCanonicalRoots === true;
  const [writableRoots, readableRoots, cwd] = await Promise.all([canonicalSandboxRoots(writableInput), canonicalSandboxRoots(readableInput), realpath(input.cwd)]);
  if (requireCanonicalRoots) {
    const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    for (const [requested, actual] of [[writableInput, writableRoots], [readableInput, readableRoots]]) {
      const expected = new Set(requested.map(identity));
      if (actual.some(path => !expected.has(identity(path))) || actual.length !== expected.size) {
        throw sandboxError('sandbox_approval_changed', 'An approved directory changed before sandbox setup. No command was started.');
      }
    }
  }
  if (writableRoots.length + readableRoots.length > 64) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox roots.');
  if (!(await stat(cwd)).isDirectory()) throw sandboxError('sandbox_policy_invalid', 'The command working directory does not exist.');
  if (process.platform === 'win32' && !input.windowsHostPath) throw sandboxError('sandbox_unavailable', 'The Windows sandbox host is unavailable.');
  if (process.platform === 'win32') await requireWindowsSandbox(input.windowsHostPath!);
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-sandbox-'));
  const privateRoot = join(directory, 'private');
  const windowsPolicyPath = process.platform === 'win32' ? join(directory, 'policy.json') : undefined;
  let prepared = false;
  try {
    if ([...writableRoots, ...readableRoots].some(root => within(root, directory))) {
      throw sandboxError('sandbox_policy_invalid', 'The writable scope would expose the sandbox supervisor state. Select a narrower project directory.');
    }
    if (![...readableRoots, ...writableRoots].some(root => within(root, cwd))) {
      throw sandboxError('sandbox_policy_invalid', 'The working directory is outside the authorized sandbox roots.');
    }
    await mkdir(privateRoot);
    await Promise.all(['config', 'local', 'cache', 'tmp'].map(name => mkdir(join(privateRoot, name))));
    const env = sandboxEnvironment(input.env ?? process.env, privateRoot);
    let executable = input.executable, args = [...input.args];
    if (windowsPolicyPath) {
      await writeFile(windowsPolicyPath, JSON.stringify({ version: 1,
        identity: `CardBush.Task.${randomUUID().replaceAll('-', '')}`, privateRoot,
        readableRoots, writableRoots, network,
      }), { mode: 0o600, flag: 'wx' });
    } else {
      executable = await resolveLinuxSandboxExecutable(linuxExecutable);
      await requireLinuxSandbox(executable, network, env);
      args = [...linuxNamespaceArgs(network), '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
      // Read-only base tooling. No bind of / or the real user home, host state,
      // IPC sockets, or /run. Explicit roots are mounted at their original paths.
      for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/ld.so.conf',
        '/etc/ld.so.conf.d', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/ssl/certs', '/etc/localtime',
        ...(network === 'enabled' ? ['/etc/resolv.conf', '/etc/hosts'] : [])]) {
        try { await stat(path); args.push('--ro-bind', path, path); } catch { /* Distribution-specific optional path. */ }
      }
      for (const path of readableRoots) args.push('--ro-bind', path, path);
      for (const path of writableRoots) args.push('--bind', path, path);
      args.push('--bind', privateRoot, privateRoot, '--chdir', cwd, '--', input.executable, ...input.args);
    }
    input.signal?.throwIfAborted();
    prepared = true;
    let disposal: Promise<void> | undefined;
    return {
      executable, args, cwd, env, windowsPolicyPath,
      status: { backend: windowsPolicyPath ? 'windows-appcontainer' : 'linux-bubblewrap', network },
      dispose: (nativeCleanupConfirmed = false) => disposal ??= (async () => {
        if (windowsPolicyPath && !nativeCleanupConfirmed) {
          // Also runs after supervisor termination, when native finally blocks
          // cannot execute. Keep the journal if cleanup fails; do not hide it.
          try { await execFileAsync(input.windowsHostPath!, ['--sandbox-cleanup', windowsPolicyPath], { windowsHide: true, timeout: 30_000, maxBuffer: 16_384 }); }
          catch { throw sandboxError('sandbox_cleanup_failed', `Sandbox cleanup could not finish. Recovery journal retained at ${windowsPolicyPath}.`); }
        }
        await removeSandboxDirectory(directory);
      })(),
    };
  } finally {
    if (!prepared) await removeSandboxDirectory(directory);
  }
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value));
}

async function removeSandboxDirectory(directory: string) {
  if (dirname(resolve(directory)).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(directory).startsWith('cardbush-sandbox-')) {
    throw sandboxError('sandbox_cleanup_failed', 'Refusing to clean an unexpected sandbox directory.');
  }
  await rm(directory, { recursive: true, force: true });
}

export function sandboxError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
