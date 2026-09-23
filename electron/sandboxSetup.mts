import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { createPlatformContext, findExecutable } from '@cardbush/platform';
import { loadCommandSandboxConfiguration, resolveLinuxSandboxExecutable, resolveProcessResourceHost, spawnResourceManagedProcess } from '@cardbush/bush-runtime';
import type { SandboxSetupStatus } from './sandboxTypes.js';

const exec = promisify(execFile);
type Probe = Pick<SandboxSetupStatus, 'state' | 'installed' | 'detail'>;
type Installer = { executable: string; args: string[]; name: string };
export type SandboxSetupOptions = {
  path: string; env?: NodeJS.ProcessEnv; windowsHostDirectory?: string; interactive?: boolean;
  // Host-owned test seams; no renderer or tool payload can supply these.
  platform?: NodeJS.Platform; probe?: () => Promise<Probe>; installer?: () => Promise<Installer | undefined>;
  install?: (plan: Installer) => Promise<void>;
};

/** Detect trusted package-manager capabilities, including derivatives, without a distribution-name allowlist. */
export async function sandboxInstaller(env: NodeJS.ProcessEnv, discovery = { find: findExecutable, validate: resolveLinuxSandboxExecutable }): Promise<Installer | undefined> {
  const context = createPlatformContext({ platform: 'linux', env: { PATH: (env.PATH ?? '').split(':').filter(isAbsolute).join(':') } });
  const plans: Array<[string, string[]]> = [
    ['apt-get', ['install', '-y', 'bubblewrap']], ['dnf', ['install', '-y', 'bubblewrap']],
    ['dnf5', ['install', '-y', 'bubblewrap']],
    ['yum', ['install', '-y', 'bubblewrap']], ['pacman', ['-S', '--needed', '--noconfirm', 'bubblewrap']],
    ['zypper', ['--non-interactive', 'install', 'bubblewrap']], ['apk', ['add', 'bubblewrap']],
  ];
  for (const [name, args] of plans) {
    const path = discovery.find(name, context);
    if (!path) continue;
    // Apply the same root ownership/ancestor checks used for the sandbox backend.
    try {
      const executable = await discovery.validate(path);
      return { executable, args, name };
    } catch { /* Missing or untrusted installers are unavailable, not install targets. */ }
  }
}

export class SandboxSetup {
  readonly #options: SandboxSetupOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(options: SandboxSetupOptions) {
    this.#options = options; this.#env = { ...process.env, ...options.env }; this.#platform = options.platform ?? process.platform;
  }
  get(): Promise<SandboxSetupStatus> { return this.#serial(() => this.#status()); }
  update(enabled: boolean): Promise<SandboxSetupStatus> {
    return this.#serial(async () => {
      if (typeof enabled !== 'boolean') throw Error('enabled must be a boolean.');
      const before = await this.#status();
      if (before.managed) throw Error('Sandbox is controlled by the host administrator.');
      if (enabled && before.state !== 'ready') throw Error('Sandbox is unavailable. Install or repair it in Runtime settings first.');
      await this.#save(enabled); return { ...before, enabled };
    });
  }
  install(): Promise<SandboxSetupStatus> {
    return this.#serial(async () => {
      const before = await this.#status();
      if (before.managed) throw Error('Sandbox is controlled by the host administrator.');
      if (before.state !== 'ready') {
        const plan = this.#platform === 'linux' && !before.installed ? await this.#installer() : undefined;
        if (!plan) throw Error(this.#platform === 'linux' && !before.installed
          ? 'No supported sandbox installer was detected. Installation is unavailable on this host.'
          : before.detail || 'Reinstall CardBush to restore its bundled sandbox component.');
        if (this.#options.install) await this.#options.install(plan); else await this.#install(plan);
      }
      const probe = await this.#probe();
      if (probe.state !== 'ready') throw Error(probe.detail || 'Sandbox installation did not pass the environment check.');
      await this.#save(true);
      return this.#status();
    });
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn); this.#queue = result.catch(() => undefined); return result;
  }
  async #save(enabled: boolean) {
    await mkdir(dirname(this.#options.path), { recursive: true });
    const temp = `${this.#options.path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify({ version: 1, enabled }), { mode: 0o600, flag: 'wx' }); await rename(temp, this.#options.path); }
    finally { await rm(temp, { force: true }); }
  }
  async #status(): Promise<SandboxSetupStatus> {
    const probe = await this.#probe();
    const managed = ['required', 'off'].includes(this.#env.CARDBUSH_EXECUTION_SANDBOX?.trim() ?? '');
    const exists = await stat(this.#options.path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
    // An installed component is enabled by default, but an explicit opt-out survives every check/restart.
    if (!exists && probe.state === 'ready' && !managed) await this.#save(true);
    const policy = await loadCommandSandboxConfiguration(this.#env, this.#options.path);
    const plan = this.#platform === 'linux' && !probe.installed && !managed ? await this.#installer() : undefined;
    return { platform: this.#platform, ...probe, enabled: policy.mode !== 'off', managed, canInstall: Boolean(plan),
      ...(plan ? { installer: plan.name, manualCommand: `sudo ${plan.executable} ${plan.args.join(' ')}` } : {}) };
  }
  #installer() { return this.#options.installer ? this.#options.installer() : sandboxInstaller(this.#env); }
  async #probe(): Promise<Probe> {
    if (this.#options.probe) return this.#options.probe();
    if (!['win32', 'linux'].includes(this.#platform)) return { state: 'unsupported', installed: false };
    let hostPath: string | undefined, linuxExecutable: string | undefined;
    try {
      if (this.#platform === 'win32') {
        const directory = this.#options.windowsHostDirectory;
        if (directory) {
          const manifest = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
          if (!/^CardBushProcessHost-[a-f0-9]{16}\.exe$/.test(manifest.fileName)) throw Error('Invalid sandbox component manifest.');
          hostPath = join(directory, manifest.fileName); await stat(hostPath);
        } else hostPath = resolveProcessResourceHost();
      } else linuxExecutable = await resolveLinuxSandboxExecutable(this.#env.CARDBUSH_BWRAP_PATH, this.#env.PATH);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const missing = /missing|not.*found|ENOENT|No bubblewrap/i.test(detail);
      return { state: missing ? 'missing' : 'blocked', installed: !missing, detail };
    }
    const directory = await mkdtemp(join(tmpdir(), 'cardbush-sandbox-check-'));
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
    try {
      const executable = this.#platform === 'win32' ? join(this.#env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
      const managed = await spawnResourceManagedProcess({ executable, args: this.#platform === 'win32' ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'],
        cwd: directory, env: this.#env, hostPath, signal: abort.signal,
        sandbox: { writableRoots: [directory], network: 'disabled', linuxExecutable } });
      let stderr = ''; managed.child.stdout.resume(); managed.child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      let code: number | null;
      try { code = await new Promise<number | null>((resolve, reject) => { managed.child.once('error', reject); managed.child.once('exit', resolve); }); }
      catch (error) { await managed.complete(); throw error; }
      const report = await managed.complete();
      if (report?.code || code !== 0) throw Error(report?.message || stderr || `Sandbox check exited with ${code}.`);
      return { state: 'ready', installed: true };
    } catch (error) { return { state: 'blocked', installed: true, detail: error instanceof Error ? error.message : String(error) }; }
    finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }); }
  }
  async #install(plan: Installer) {
    let executable = plan.executable, args = plan.args;
    if (process.getuid?.() !== 0) {
      const context = createPlatformContext({ platform: 'linux', env: this.#env });
      const broker = this.#options.interactive ? findExecutable('pkexec', context) : undefined;
      const sudo = broker ? undefined : findExecutable('sudo', context);
      if (!broker && !sudo) throw Error('Administrator access is required. Run the installation command shown in Runtime settings.');
      executable = await resolveLinuxSandboxExecutable((broker ?? sudo)!);
      args = [...(broker ? [] : ['-n']), plan.executable, ...plan.args];
    }
    // Only this explicit UI action can reach the package manager. Never forward arbitrary arguments or environment hooks.
    try { await exec(executable, args, { timeout: 240000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', ...(this.#env.DISPLAY ? { DISPLAY: this.#env.DISPLAY } : {}), ...(this.#env.XAUTHORITY ? { XAUTHORITY: this.#env.XAUTHORITY } : {}) } }); }
    catch (error) { throw Error(`Sandbox installation failed. Administrator access may be required; use the command in Runtime settings. ${String((error as { stderr?: unknown }).stderr || (error as Error).message).slice(-2000)}`); }
  }
}
