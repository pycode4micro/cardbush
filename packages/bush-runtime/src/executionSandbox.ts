import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createPlatformContext, findExecutable } from '@cardbush/platform';
import { sandboxPowerShellArgs, type WindowsSandboxScopePool } from './windowsSandboxScope.js';
import { checkSandboxTree } from './sandboxTreeCheck.js';

const execFileAsync = promisify(execFile);
const windowsCapabilities = new Map<string, Promise<{ scopes: boolean; files: boolean }>>();
const linuxCapabilities = new Map<string, Promise<void>>();

/** Only for a host-selected interpreter, never model-supplied executable/PATH.
 * Public Windows install roots already allow AppContainer reads; a per-user
 * shell needs its own installation directory, not the user's whole profile.
 */
export function windowsInterpreterRoots(executable: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32' || !isAbsolute(executable)) return [];
  const publicRoots = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter((value): value is string => Boolean(value && isAbsolute(value)));
  return publicRoots.some(root => within(root, executable)) ? [] : [dirname(executable)];
}

// Runs inside bubblewrap before the requested executable. Mounts pin objects
// after setup; checking there closes the pathname-to-mount race on older bwrap.
const linuxSandboxVerifier = `
const fs = require('node:fs');
try {
  for (const grant of JSON.parse(process.argv[1])) {
    const info = fs.lstatSync(grant.path, { bigint: true });
    if (info.isSymbolicLink() || info.isDirectory() !== grant.directory ||
        String(info.dev) + ':' + String(info.ino) !== grant.identity ||
        info.isFile() && info.nlink !== 1n) throw Error('identity mismatch');
    if (grant.directory) {
      const pending = [grant.path];
      while (pending.length) {
        const path = pending.pop();
        const entry = fs.lstatSync(path, { bigint: true });
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile() && entry.nlink !== 1n) throw Error('hard-link alias');
        if (entry.isDirectory()) for (const name of fs.readdirSync(path)) pending.push(require('node:path').join(path, name));
      }
    }
  }
} catch { process.stderr.write('sandbox_approval_changed: a mounted object differs from the authorized object\\n'); process.exit(78); }
const child = require('node:child_process').spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.once('error', error => { process.stderr.write('sandbox_spawn_failed: ' + error.message + '\\n'); process.exitCode = 79; });
child.once('exit', (code, signal) => { process.exitCode = code ?? 128 + (require('node:os').constants.signals[signal] ?? 1); });
`;

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

async function requireWindowsSandbox(host: string) {
  let pending = windowsCapabilities.get(host);
  if (!pending) {
    pending = (async () => {
      try {
        const result = await execFileAsync(host, ['--capabilities'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
        const capabilities = JSON.parse(result.stdout);
        if (capabilities.protocol !== 'cardbush.process-host.v1' || capabilities.sandboxVersion !== 1) throw Error('Unsupported sandbox host.');
        if (capabilities.sandboxFileVersion !== 3) throw Error('Sandbox object guards require the current native host.');
        if (capabilities.sandboxScopeVersion !== 4) throw Error('Concurrent sandbox object guards require the current native host.');
        return { scopes: true, files: true };
      } catch {
        throw sandboxError('sandbox_unavailable', 'The Windows command sandbox is missing, incompatible, or blocked by application control. No command was started.');
      }
    })();
    windowsCapabilities.set(host, pending);
    void pending.catch(() => windowsCapabilities.delete(host));
  }
  return await pending;
}

/** Validate the shared backend before a file tool performs namespace changes. */
export async function verifyFileSandboxBackend(windowsHostPath?: string, linuxExecutable?: string) {
  if (process.platform === 'win32' && windowsHostPath) {
    if (!(await requireWindowsSandbox(windowsHostPath)).files)
      throw sandboxError('sandbox_unavailable', 'The installed sandbox host lacks exact-file support. Rebuild or reinstall it.');
  } else if (process.platform === 'linux') {
    const executable = await resolveLinuxSandboxExecutable(linuxExecutable);
    await requireLinuxSandbox(executable, 'disabled', sandboxEnvironment(process.env, tmpdir()));
  } else throw sandboxError('sandbox_unavailable', 'This platform has no supported file sandbox backend.');
}

/** Host-owned policy. Never decoded from a model's tool arguments. */
export interface ExecutionSandboxPolicy {
  writableRoots: readonly string[];
  readableRoots?: readonly string[];
  /** Exact existing objects, never their parent directories. */
  readableFiles?: readonly string[];
  writableFiles?: readonly string[];
  /** Internal checked deletion only; ordinary write_files never grants DELETE. */
  deletableFiles?: readonly string[];
  /** Internal helpers need no access to the caller's working directory. */
  privateWorkingDirectory?: boolean;
  expectedIdentities?: Readonly<Record<string, string>>;
  network: 'disabled' | 'enabled';
  linuxExecutable?: string;
  /** Granted scopes were already canonicalized; never silently retarget them. */
  requireCanonicalRoots?: boolean;
}

export interface ExecutionSandboxStatus {
  backend: 'windows-appcontainer' | 'linux-bubblewrap';
  network: 'disabled' | 'enabled';
  readableRoots?: readonly string[];
  writableRoots?: readonly string[];
  readableFiles?: readonly string[];
  writableFiles?: readonly string[];
}

export async function canonicalSandboxFiles(values: readonly string[]): Promise<string[]> {
  if (!Array.isArray(values) || values.length > 256) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox files.');
  return [...new Set(await Promise.all(values.map(async value => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.startsWith('\\\\'))
      throw sandboxError('sandbox_policy_invalid', 'Sandbox files must be absolute local paths.');
    const path = await realpath(value);
    if (!(await stat(path)).isFile()) throw sandboxError('sandbox_policy_invalid', 'Sandbox file grants require an existing regular file.');
    return path;
  })))];
}

export interface PreparedExecutionSandbox {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsPolicyPath?: string;
  status: ExecutionSandboxStatus;
  dispose: (nativeCleanupConfirmed?: boolean, scopeStale?: boolean) => Promise<void>;
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
  scopePool?: WindowsSandboxScopePool;
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
  const readableFileInput = [...(input.policy.readableFiles ?? [])];
  const writableFileInput = [...(input.policy.writableFiles ?? [])];
  const privateWorkingDirectory = input.policy.privateWorkingDirectory === true;
  const expectedIdentities = { ...input.policy.expectedIdentities };
  const linuxExecutable = input.policy.linuxExecutable ?? process.env.CARDBUSH_BWRAP_PATH?.trim();
  const requireCanonicalRoots = input.policy.requireCanonicalRoots === true;
  const [writableRoots, readableRoots, cwd] = await Promise.all([canonicalSandboxRoots(writableInput), canonicalSandboxRoots(readableInput), realpath(input.cwd)]);
  const [readableFiles, writableFiles] = await Promise.all([canonicalSandboxFiles(readableFileInput), canonicalSandboxFiles(writableFileInput)]);
  const deletableFiles = [...(input.policy.deletableFiles ?? [])];
  if (deletableFiles.some(path => !writableFiles.includes(path))) throw sandboxError('sandbox_policy_invalid', 'Deletion requires an exact writable file grant.');
  if (readableFiles.length + writableFiles.length > 256) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox files.');
  if (requireCanonicalRoots) {
    const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    for (const [requested, actual] of [[writableInput, writableRoots], [readableInput, readableRoots], [readableFileInput, readableFiles], [writableFileInput, writableFiles]]) {
      const expected = new Set(requested.map(identity));
      if (actual.some(path => !expected.has(identity(path))) || actual.length !== expected.size) {
        throw sandboxError('sandbox_approval_changed', 'An approved directory changed before sandbox setup. No command was started.');
      }
    }
  }
  if (writableRoots.length + readableRoots.length > 64) throw sandboxError('sandbox_policy_invalid', 'Too many sandbox roots.');
  if (!(await stat(cwd)).isDirectory()) throw sandboxError('sandbox_policy_invalid', 'The command working directory does not exist.');
  if (process.platform === 'win32' && !input.windowsHostPath) throw sandboxError('sandbox_unavailable', 'The Windows sandbox host is unavailable.');
  const capabilities = process.platform === 'win32' ? await requireWindowsSandbox(input.windowsHostPath!) : undefined;
  if (capabilities && (readableFiles.length || writableFiles.length) && !capabilities.files)
    throw sandboxError('sandbox_unavailable', 'The sandbox host does not support exact file grants. Rebuild or reinstall it; no command was started.');
  // Windows TEMP may use an 8.3 alias (for example RUNNER~1). The native
  // supervisor requires canonical roots, including its own private directory.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-sandbox-')));
  const privateRoot = join(directory, 'private');
  const windowsPolicyPath = process.platform === 'win32' ? join(directory, 'policy.json') : undefined;
  let prepared = false;
  const boundHandles: FileHandle[] = [];
  let scope: Awaited<ReturnType<WindowsSandboxScopePool['acquire']>> | undefined;
  try {
    if ([...writableRoots, ...readableRoots].some(root => within(root, directory))) {
      throw sandboxError('sandbox_policy_invalid', 'The writable scope would expose the sandbox supervisor state. Select a narrower project directory.');
    }
    if (!privateWorkingDirectory && ![...readableRoots, ...writableRoots].some(root => within(root, cwd))) {
      throw sandboxError('sandbox_policy_invalid', 'The working directory is outside the authorized sandbox roots.');
    }
    await checkSandboxTree([...readableRoots, ...writableRoots, ...readableFiles, ...writableFiles], input.signal);
    await mkdir(privateRoot);
    await Promise.all(['config', 'local', 'cache', 'tmp'].map(name => mkdir(join(privateRoot, name))));
    const env = sandboxEnvironment(input.env ?? process.env, privateRoot);
    let executable = input.executable, args = [...input.args];
    if (windowsPolicyPath) {
      args = sandboxPowerShellArgs(executable, args);
      if (capabilities?.scopes && input.scopePool) scope = await input.scopePool.acquire(input.windowsHostPath!, readableRoots, writableRoots, expectedIdentities);
      await writeFile(windowsPolicyPath, JSON.stringify({ version: 1,
        identity: `CardBush.Task.${randomUUID().replaceAll('-', '')}`, privateRoot,
        readableRoots, writableRoots, readableFiles, writableFiles, deletableFiles, expectedIdentities, network, ...(scope ? { scope: scope.reference } : {}),
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
      const verifyObjects = true;
      const verifier = verifyObjects ? await realpath(process.execPath) : undefined;
      if (verifier && (writableRoots.some(root => within(root, verifier)) || writableFiles.includes(verifier)))
        throw sandboxError('sandbox_policy_invalid', 'A writable grant cannot include the trusted sandbox runtime.');
      if (verifier && !readableFiles.includes(verifier)) readableFiles.push(verifier);
      const mounts: Array<{ path: string; identity: string; directory: boolean; write: boolean }> = [];
      // Retain metadata descriptors to prevent inode reuse. On older bubblewrap
      // versions, a trusted in-sandbox bootstrap verifies the mounted objects
      // before any requested program runs; it never accesses their content.
      for (const [paths, writable] of [[readableRoots, false], [writableRoots, true], [readableFiles, false], [writableFiles, true]] as const) {
        for (const path of paths) {
          if (verifyObjects) {
            const handle = await open(path, 0x200000 /* O_PATH */ | constants.O_NOFOLLOW);
            boundHandles.push(handle);
            const metadata = await handle.stat({ bigint: true });
            if (metadata.isSymbolicLink() || expectedIdentities[path] && expectedIdentities[path] !== `${metadata.dev}:${metadata.ino}` ||
                metadata.isFile() && metadata.nlink !== 1n)
              throw sandboxError('sandbox_approval_changed', 'An authorized filesystem object changed before sandbox setup.');
            mounts.push({ path, identity: `${metadata.dev}:${metadata.ino}`, directory: metadata.isDirectory(), write: writable });
          }
          args.push(writable ? '--bind' : '--ro-bind', path, path);
        }
      }
      // Synthetic mount-point parents are not part of an exact-file grant.
      // Keep them read-only; writable binds (including the private temp root)
      // remain separate mounts with their explicitly authorized access.
      args.push('--bind', privateRoot, privateRoot, '--remount-ro', '/',
        ...(privateWorkingDirectory ? ['--remount-ro', '/tmp'] : []),
        '--chdir', privateWorkingDirectory ? privateRoot : cwd, '--');
      if (verifier) args.push(verifier, '--input-type=commonjs', '-e', linuxSandboxVerifier, JSON.stringify(mounts), input.executable, ...input.args);
      else args.push(input.executable, ...input.args);
    }
    input.signal?.throwIfAborted();
    prepared = true;
    let disposal: Promise<void> | undefined;
    return {
      executable, args, cwd: privateWorkingDirectory ? privateRoot : cwd, env, windowsPolicyPath,
      status: { backend: windowsPolicyPath ? 'windows-appcontainer' : 'linux-bubblewrap', network, readableRoots, writableRoots,
        ...(readableFiles.length ? { readableFiles } : {}), ...(writableFiles.length ? { writableFiles } : {}) },
      dispose: (nativeCleanupConfirmed = false, scopeStale = false) => disposal ??= (async () => {
        if (scopeStale) scope?.invalidate();
        try {
          if (windowsPolicyPath && !nativeCleanupConfirmed) {
            // Also runs after supervisor termination, when native finally blocks
            // cannot execute. Keep the journal if cleanup fails; do not hide it.
            try { await execFileAsync(input.windowsHostPath!, ['--sandbox-cleanup', windowsPolicyPath], { windowsHide: true, timeout: 30_000, maxBuffer: 16_384 }); }
            catch { throw sandboxError('sandbox_cleanup_failed', `Sandbox cleanup could not finish. Recovery journal retained at ${windowsPolicyPath}.`); }
          }
          await removeSandboxDirectory(directory);
        } finally { scope?.release(); await Promise.all(boundHandles.map(handle => handle.close())); }
      })(),
    };
  } finally {
    if (!prepared) { scope?.release(); await Promise.all(boundHandles.map(handle => handle.close())); await removeSandboxDirectory(directory); }
  }
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value));
}

async function removeSandboxDirectory(directory: string) {
  if (dirname(resolve(directory)).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(directory).startsWith('cardbush-sandbox-')) {
    throw sandboxError('sandbox_cleanup_failed', 'Refusing to clean an unexpected sandbox directory.');
  }
  await rm(directory, { recursive: true, force: true });
}

export function sandboxError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
