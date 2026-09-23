import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessResourceObserver, type ResourceSample } from './processResourceObserver.js';
import { windowsProcessFailure } from './windowsProcessFailure.js';
import { prepareExecutionSandbox, type ExecutionSandboxPolicy, type ExecutionSandboxStatus, type PreparedExecutionSandbox } from './executionSandbox.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export interface ProcessResourceLimits {
  taskMemoryBytes: number;
  totalMemoryBytes: number;
  memoryReserveBytes: number;
  criticalMemoryBytes: number;
  diskReserveBytes: number;
  cpuPercent: number;
  taskProcessLimit: number;
  totalProcessLimit: number;
  maxConcurrentTasks: number;
  maxConcurrentServices?: number;
  startupMemoryBytes?: number;
  serviceStartupMemoryBytes?: number;
}

export function defaultProcessResourceLimits(physicalMemoryBytes = totalmem()): ProcessResourceLimits {
  return {
    taskMemoryBytes: Math.floor(physicalMemoryBytes * 0.25),
    totalMemoryBytes: Math.floor(physicalMemoryBytes * 0.5),
    memoryReserveBytes: Math.min(1 * GiB, Math.max(512 * MiB, Math.floor(physicalMemoryBytes * 0.1))),
    criticalMemoryBytes: Math.min(512 * MiB, Math.floor(physicalMemoryBytes * 0.025)),
    diskReserveBytes: 512 * MiB,
    cpuPercent: 80,
    taskProcessLimit: 64,
    totalProcessLimit: 256,
    maxConcurrentTasks: 8,
    maxConcurrentServices: 32,
    startupMemoryBytes: 256 * MiB,
    serviceStartupMemoryBytes: 128 * MiB,
  };
}

export class ProcessResourceGovernor {
  readonly groupName = `Local\\CardBush-Tasks-${process.pid}-${randomUUID()}`;
  readonly limits: ProcessResourceLimits;
  readonly #availableMemory: () => number;
  readonly #leases = new Map<string, { lifetime: 'task' | 'service'; reservation: number; replaces?: string }>();
  readonly #observer?: ProcessResourceObserver;
  #sample?: ResourceSample;
  #sampleAt = 0;
  #startedAt = 0;
  #applicationMemory = () => 0;
  #applicationRelief = () => false;
  #pressureSamples = 0;
  #reliefAt = 0;

  // Host configuration only: tool arguments cannot raise or disable these limits.
  constructor(options: { limits?: ProcessResourceLimits; availableMemory?: () => number; observe?: boolean } = {}) {
    this.limits = options.limits ?? defaultProcessResourceLimits();
    this.#availableMemory = options.availableMemory ?? freemem;
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid process resource limit: ${name}`);
    }
    if (this.limits.cpuPercent > 100 || this.limits.taskMemoryBytes > this.limits.totalMemoryBytes) {
      throw new Error("Invalid process resource budget.");
    }
    if (process.platform === 'win32' && (options.observe ?? !options.availableMemory)) {
      this.#observer = new ProcessResourceObserver(this.groupName, resolveProcessResourceHost, sample => this.observe(sample));
    }
  }

  /** Native measurements are transient accounting, never a second plugin/configuration store. */
  observe(sample: ResourceSample): void {
    this.#sample = sample;
    this.#sampleAt = Date.now();
    const critical = Math.min(this.#availableMemory(), sample.availableMemoryBytes, sample.availableCommitBytes) < this.limits.criticalMemoryBytes;
    this.#pressureSamples = critical ? this.#pressureSamples + 1 : 0;
    if (this.#pressureSamples < 2 || Date.now() - this.#reliefAt < 6_000) return;
    if (this.#applicationRelief()) { this.#reliefAt = Date.now(); return; }
    // Release one substantial consumer, then remeasure. Small idle MCP services
    // must not all be killed because an unrelated application is using RAM.
    const candidates = sample.jobs.filter(job => this.#leases.has(job.id) && job.memoryBytes >= 256 * MiB)
      .sort((a, b) => Number(this.#leases.get(a.id)!.lifetime === 'service') - Number(this.#leases.get(b.id)!.lifetime === 'service') || b.memoryBytes - a.memoryBytes);
    if (candidates[0] && this.#observer?.relieve(candidates[0].id)) this.#reliefAt = Date.now();
  }

  /** Main/renderer/Runtime memory is measured by Electron; managed trees by Windows. */
  setApplicationMemoryProvider(provider: () => number, relieve = () => false): void {
    this.#applicationMemory = provider; this.#applicationRelief = relieve;
  }

  acquire(lifetime: 'task' | 'service' = 'task', replace?: string): ProcessResourceLease {
    const records = [...this.#leases.values()];
    const services = records.filter(lease => lease.lifetime === 'service').length;
    const transitions = records.filter(lease => lease.replaces && this.#leases.has(lease.replaces)).length;
    const replaces = lifetime === 'service' && replace && this.#leases.get(replace)?.lifetime === 'service'
      && !records.some(lease => lease.replaces === replace) ? replace : undefined;
    if (lifetime === 'service' && services - transitions >= (this.limits.maxConcurrentServices ?? 32) && !replaces) {
      throw resourceError('resource_service_capacity_busy', "The host's managed service budget is full. Disable an unneeded plugin service before starting another.");
    }
    if (lifetime === 'task' && this.#leases.size - services >= this.limits.maxConcurrentTasks) {
      throw resourceError("resource_capacity_busy", "The host's concurrent task budget is full. Wait for an existing terminal task to finish, or stop an unneeded task before starting another.");
    }
    const sample = Date.now() - this.#sampleAt < 5_000 ? this.#sample : undefined;
    if (this.#observer && this.#leases.size > 0 && !sample && Date.now() - this.#startedAt > 5_000) {
      throw resourceError('resource_monitor_pending', 'Resource measurements are recovering. No command was started.');
    }
    const reservation = Math.min(this.limits.taskMemoryBytes, lifetime === 'service'
      ? this.limits.serviceStartupMemoryBytes ?? 128 * MiB : this.limits.startupMemoryBytes ?? 256 * MiB);
    let pendingMemory = 0;
    for (const [id, lease] of this.#leases) {
      pendingMemory += Math.max(0, lease.reservation - (sample?.jobs.find(job => job.id === id)?.memoryBytes ?? 0));
    }
    const available = Math.min(this.#availableMemory(), sample?.availableCommitBytes ?? Infinity)
      - this.limits.memoryReserveBytes - pendingMemory;
    const sharedAvailable = this.limits.totalMemoryBytes - (sample?.totalMemoryBytes ?? 0) - pendingMemory - this.#applicationMemory();
    if (Math.min(available, sharedAvailable) < reservation) {
      throw resourceError("resource_memory_pressure", "The host is low on available memory. No command was started. Wait for memory to be released before retrying; do not bypass the resource guard with another launcher.");
    }
    const id = randomUUID();
    if (!this.#leases.size) this.#startedAt = Date.now();
    this.#leases.set(id, { lifetime, reservation, replaces });
    this.#observer?.track([...this.#leases.keys()]);
    let released = false;
    return {
      id, groupName: this.groupName, limits: this.limits,
      taskMemoryBytes: Math.min(this.limits.taskMemoryBytes, Math.floor(available), Math.floor(sharedAvailable)),
      // A persistent service cannot freeze the shared ceiling at yesterday's
      // free-memory low point. Admission uses live usage; Windows caps the group.
      totalMemoryBytes: this.limits.totalMemoryBytes,
      release: () => {
        if (released) return;
        released = true;
        this.#leases.delete(id);
        this.#observer?.track([...this.#leases.keys()]);
        if (!this.#leases.size) { this.#sample = undefined; this.#sampleAt = 0; }
      },
    };
  }
}

export interface ProcessResourceLease {
  id: string;
  groupName: string;
  limits: ProcessResourceLimits;
  taskMemoryBytes: number;
  totalMemoryBytes: number;
  release: () => void;
}
export type ProcessResourceGrant = Omit<ProcessResourceLease, 'release'>;
export interface ProcessResourceClient {
  acquire(lifetime: 'task' | 'service', signal?: AbortSignal, replace?: string): Promise<ProcessResourceLease>;
}
// The desktop Runtime installs a private RPC client to the main process's
// governor. Standalone/CLI runtimes use their own single governor.
const sharedGovernor = new ProcessResourceGovernor();
let resourceClient: ProcessResourceClient | undefined;
export function configureProcessResourceClient(client?: ProcessResourceClient): void { resourceClient = client; }
export function getProcessResourceGovernor(): ProcessResourceGovernor { return sharedGovernor; }
export function reserveProcessResources(lifetime: 'task' | 'service' = 'task', signal?: AbortSignal, replace?: string): Promise<ProcessResourceLease> {
  signal?.throwIfAborted();
  return resourceClient ? resourceClient.acquire(lifetime, signal, replace) : Promise.resolve(sharedGovernor.acquire(lifetime, replace));
}
export function isResourceAdmissionError(error: unknown): boolean {
  return ['resource_memory_pressure', 'resource_capacity_busy', 'resource_service_capacity_busy', 'resource_monitor_pending']
    .includes(String((error as { code?: unknown })?.code));
}

export interface ProcessResourceReport {
  phase: "finished";
  code: string;
  message: string;
  peakMemoryBytes: number;
  taskMemoryBytes: number;
  totalMemoryBytes: number;
  nativeErrorCode?: number;
  blockedExecutable?: string;
  sandboxCleaned?: boolean;
}

export interface GuardedProcess {
  resourceId: string;
  child: ChildProcessWithoutNullStreams;
  protected: boolean;
  sandbox?: ExecutionSandboxStatus;
  stop: () => void;
  complete: () => Promise<ProcessResourceReport | undefined>;
}

export interface ManagedProcessOptions {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  governor?: ProcessResourceGovernor;
  hostPath?: string;
  /** Host-owned persistent services have separate slots, but share the RAM/CPU/process budget. */
  lifetime?: 'task' | 'service';
  /** An admission acquired before replacing a service; consumed by this spawn. */
  resourceLease?: ProcessResourceLease;
  /** Host-owned preview/helper ceiling. It can only narrow the granted limit. */
  memoryCeilingBytes?: number;
  /** Host-owned access isolation; independent of resource protection. */
  sandbox?: ExecutionSandboxPolicy;
}

/** A lifetime owned by a host, window or operation, never by an unrelated turn. */
export class ManagedProcessScope {
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();

  spawn(input: ManagedProcessOptions): Promise<GuardedProcess> {
    const signal = input.signal
      ? AbortSignal.any([this.#controller.signal, input.signal]) : this.#controller.signal;
    const started = spawnResourceManagedProcess({ ...input, signal });
    const lifetime = started.then(managed => managed.complete(), () => undefined);
    this.#pending.add(lifetime);
    void lifetime.finally(() => this.#pending.delete(lifetime));
    return started;
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await Promise.allSettled(this.#pending);
  }
}

let pinnedProcessHost: string | undefined;
export function resolveProcessResourceHost(): string {
  const supplied = process.env.CARDBUSH_PROCESS_HOST_PATH;
  if (pinnedProcessHost && !supplied) return pinnedProcessHost;
  const directory = process.env.CARDBUSH_PROCESS_HOST_DIRECTORY
    || fileURLToPath(new URL("../../../dist-native/process-guard", import.meta.url));
  let fileName = "";
  if (!supplied) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "current.json"), "utf8"));
      if (/^CardBushProcessHost-[a-f0-9]{16}\.exe$/.test(manifest.fileName)) fileName = manifest.fileName;
    } catch { /* Refuse execution below if the complete native asset is unavailable. */ }
  }
  const candidate = supplied || (fileName ? join(directory, fileName) : "");
  if (!existsSync(candidate)) {
    throw resourceError("resource_protection_unavailable", "The Windows process resource host is missing. Rebuild or reinstall CardBush. The command was not started without protection.");
  }
  if (!supplied) pinnedProcessHost = candidate;
  return candidate;
}

// Pin a complete native version when Runtime loads, so a later in-place build
// cannot pair an already-running JS host with a different native argument ABI.
// Missing assets do not prevent app startup; execution still fails closed.
if (process.platform === "win32") {
  try { resolveProcessResourceHost(); } catch { /* Resolved again at execution. */ }
}

export async function spawnResourceManagedProcess(input: ManagedProcessOptions): Promise<GuardedProcess> {
  if (input.signal?.aborted) input.resourceLease?.release();
  input.signal?.throwIfAborted();
  const lease = input.resourceLease ?? (input.governor
    ? input.governor.acquire(input.lifetime) : await reserveProcessResources(input.lifetime, input.signal));
  let reportDirectory: string | undefined;
  let sandbox: PreparedExecutionSandbox | undefined;
  let nativeStarted = false;
  try {
    input.signal?.throwIfAborted();
    if (input.memoryCeilingBytes !== undefined) {
      if (!Number.isSafeInteger(input.memoryCeilingBytes) || input.memoryCeilingBytes <= 0) throw new Error('Invalid process memory ceiling.');
      lease.taskMemoryBytes = Math.min(lease.taskMemoryBytes, input.memoryCeilingBytes);
    }
    const hostPath = process.platform === 'win32' ? input.hostPath ?? resolveProcessResourceHost() : undefined;
    if (input.sandbox) {
      sandbox = await prepareExecutionSandbox({ ...input, policy: input.sandbox, windowsHostPath: hostPath });
      input = { ...input, executable: sandbox.executable, args: sandbox.args, cwd: sandbox.cwd, env: sandbox.env };
    }
    if (process.platform !== "win32") {
      const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, detached: true, stdio: "pipe" });
      const lifecycle = manageLifecycle(child, false, input.signal);
      const completion = lifecycle.exited.then(async () => { lease.release(); return cleanupSandbox(sandbox, lease); });
      return { child, resourceId: lease.id, protected: false, sandbox: sandbox?.status, stop: lifecycle.stop, complete: () => completion };
    }
    reportDirectory = await mkdtemp(join(tmpdir(), "cardbush-process-"));
    // Cancellation can arrive while the receipt directory is being created.
    input.signal?.throwIfAborted();
    const reportPath = join(reportDirectory, "result.json");
    const limits = lease.limits;
    const child = spawn(hostPath!, [
      lease.groupName,
      String(process.pid),
      String(lease.taskMemoryBytes),
      String(lease.totalMemoryBytes),
      String(limits.cpuPercent),
      String(limits.taskProcessLimit),
      String(limits.totalProcessLimit),
      String(limits.criticalMemoryBytes),
      String(limits.diskReserveBytes),
      reportPath,
      '--lease', lease.id,
      ...(sandbox?.windowsPolicyPath ? ['--sandbox', sandbox.windowsPolicyPath] : []),
      input.executable,
      ...input.args,
    ], { cwd: input.cwd, env: input.env, windowsHide: true, stdio: "pipe" });
    nativeStarted = Boolean(child.pid);
    const lifecycle = manageLifecycle(child, true, input.signal);
    let completion: Promise<ProcessResourceReport | undefined> | undefined;
    const complete = () => completion ??= (async () => {
      // A caller may wait immediately after spawn; never read an unfinished receipt.
      await lifecycle.exited;
      try {
        const report = JSON.parse(await readFile(reportPath, "utf8")) as ProcessResourceReport;
        if (report.phase !== "finished") throw new Error("Resource host did not finish.");
        const cleanupFailure = await cleanupSandbox(sandbox, lease, report.sandboxCleaned === true);
        const policyFailure = report.code === 'resource_spawn_failed'
          ? windowsProcessFailure(report.nativeErrorCode, input.executable) : undefined;
        const result = policyFailure ? { ...report, ...policyFailure } : report;
        return cleanupFailure ? { ...cleanupFailure, message: [result.message, cleanupFailure.message].filter(Boolean).join(' ') } : result;
      } catch {
        const cleanupFailure = await cleanupSandbox(sandbox, lease, !child.pid);
        if (cleanupFailure) return cleanupFailure;
        return {
          phase: "finished" as const,
          code: "resource_host_interrupted",
          message: "The resource host exited before confirming completion. Its managed task tree has been terminated.",
          peakMemoryBytes: 0,
          taskMemoryBytes: lease.taskMemoryBytes,
          totalMemoryBytes: lease.totalMemoryBytes,
        };
      } finally {
        lease.release();
        // This directory contains only our receipt, never task input/output.
        await removeReceiptDirectory(reportDirectory!);
      }
    })();
    void complete();
    return { child, resourceId: lease.id, protected: true, sandbox: sandbox?.status, stop: lifecycle.stop, complete };
  } catch (error) {
    lease.release();
    await sandbox?.dispose(!nativeStarted);
    if (reportDirectory) await removeReceiptDirectory(reportDirectory);
    throw error;
  }
}

async function cleanupSandbox(sandbox: PreparedExecutionSandbox | undefined, lease: ProcessResourceLease, nativeCleanupConfirmed = false): Promise<ProcessResourceReport | undefined> {
  try { await sandbox?.dispose(nativeCleanupConfirmed); return undefined; }
  catch (error) {
    return { phase: 'finished', code: 'sandbox_cleanup_failed', message: error instanceof Error ? error.message : String(error),
      peakMemoryBytes: 0, taskMemoryBytes: lease.taskMemoryBytes, totalMemoryBytes: lease.totalMemoryBytes };
  }
}

function manageLifecycle(child: ChildProcessWithoutNullStreams, protectedTree: boolean, signal?: AbortSignal) {
  let ended = false;
  const killGroup = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* Already exited. */ }
    }
    child.kill("SIGKILL");
  };
  const stop = () => {
    if (ended) return;
    if (protectedTree) child.kill(); // Closing the supervisor closes its kill-on-close job.
    else killGroup();
  };
  const exited = new Promise<void>(resolveExit => {
    const finish = () => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", stop);
      if (!protectedTree) killGroup();
      resolveExit();
    };
    child.once("exit", finish);
    child.once("error", finish);
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  return { stop, exited };
}

function resourceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function removeReceiptDirectory(directory: string): Promise<void> {
  const target = resolve(directory);
  if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith("cardbush-process-")) {
    throw new Error("Refusing to remove a directory outside the process receipt root.");
  }
  await rm(target, { recursive: true, force: true }).catch(() => {});
}
