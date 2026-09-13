import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { freemem, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
}

export function defaultProcessResourceLimits(physicalMemoryBytes = totalmem()): ProcessResourceLimits {
  return {
    taskMemoryBytes: Math.floor(physicalMemoryBytes * 0.25),
    totalMemoryBytes: Math.floor(physicalMemoryBytes * 0.5),
    memoryReserveBytes: Math.min(2 * GiB, Math.max(512 * MiB, Math.floor(physicalMemoryBytes * 0.1))),
    criticalMemoryBytes: Math.min(512 * MiB, Math.floor(physicalMemoryBytes * 0.025)),
    diskReserveBytes: 512 * MiB,
    cpuPercent: 80,
    taskProcessLimit: 64,
    totalProcessLimit: 256,
    maxConcurrentTasks: 8,
  };
}

export class ProcessResourceGovernor {
  readonly groupName = `Local\\CardBush-Tasks-${process.pid}-${randomUUID()}`;
  readonly limits: ProcessResourceLimits;
  readonly #availableMemory: () => number;
  #active = 0;
  #sharedMemoryBytes = 0;

  // Host configuration only: tool arguments cannot raise or disable these limits.
  constructor(options: { limits?: ProcessResourceLimits; availableMemory?: () => number } = {}) {
    this.limits = options.limits ?? defaultProcessResourceLimits();
    this.#availableMemory = options.availableMemory ?? freemem;
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid process resource limit: ${name}`);
    }
    if (this.limits.cpuPercent > 100 || this.limits.taskMemoryBytes > this.limits.totalMemoryBytes) {
      throw new Error("Invalid process resource budget.");
    }
  }

  acquire(): { taskMemoryBytes: number; totalMemoryBytes: number; release: () => void } {
    if (this.#active >= this.limits.maxConcurrentTasks) {
      throw resourceError("resource_capacity_busy", "The host's concurrent task budget is full. Wait for an existing terminal task to finish, or stop an unneeded task before starting another.");
    }
    const available = this.#availableMemory() - this.limits.memoryReserveBytes;
    if (available < Math.min(256 * MiB, this.limits.taskMemoryBytes)) {
      throw resourceError("resource_memory_pressure", "The host is low on available memory. No command was started. Wait for memory to be released before retrying; do not bypass the resource guard with another launcher.");
    }
    // Concurrent tasks reuse a ceiling based on free RAM at the start of this
    // group of work. It can recover a larger budget after the host becomes idle.
    if (this.#active === 0) this.#sharedMemoryBytes = Math.min(this.limits.totalMemoryBytes, Math.floor(available));
    this.#active++;
    let released = false;
    return {
      taskMemoryBytes: Math.min(this.limits.taskMemoryBytes, this.#sharedMemoryBytes, Math.floor(available)),
      totalMemoryBytes: this.#sharedMemoryBytes,
      release: () => {
        if (released) return;
        released = true;
        this.#active--;
      },
    };
  }
}

// Every Runtime session, fork and subagent in this host shares one admission
// budget and one native parent job, even when it has its own terminal manager.
const sharedGovernor = new ProcessResourceGovernor();

export interface ProcessResourceReport {
  phase: "finished";
  code: string;
  message: string;
  peakMemoryBytes: number;
  taskMemoryBytes: number;
  totalMemoryBytes: number;
  nativeErrorCode?: number;
}

export interface GuardedProcess {
  child: ChildProcessWithoutNullStreams;
  protected: boolean;
  complete: () => Promise<ProcessResourceReport | undefined>;
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

export async function spawnResourceManagedProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  governor?: ProcessResourceGovernor;
  hostPath?: string;
}): Promise<GuardedProcess> {
  const governor = input.governor ?? sharedGovernor;
  const lease = governor.acquire();
  let reportDirectory: string | undefined;
  try {
    if (process.platform !== "win32") {
      const child = spawn(input.executable, input.args, { cwd: input.cwd, detached: true, stdio: "pipe" });
      child.once("exit", lease.release);
      child.once("error", lease.release);
      return { child, protected: false, complete: async () => undefined };
    }
    const hostPath = input.hostPath ?? resolveProcessResourceHost();
    reportDirectory = await mkdtemp(join(tmpdir(), "cardbush-process-"));
    const reportPath = join(reportDirectory, "result.json");
    const limits = governor.limits;
    const child = spawn(hostPath, [
      governor.groupName,
      String(process.pid),
      String(lease.taskMemoryBytes),
      String(lease.totalMemoryBytes),
      String(limits.cpuPercent),
      String(limits.taskProcessLimit),
      String(limits.totalProcessLimit),
      String(limits.criticalMemoryBytes),
      String(limits.diskReserveBytes),
      reportPath,
      input.executable,
      ...input.args,
    ], { cwd: input.cwd, windowsHide: true, stdio: "pipe" });
    let completion: Promise<ProcessResourceReport | undefined> | undefined;
    const complete = () => completion ??= (async () => {
      try {
        const report = JSON.parse(await readFile(reportPath, "utf8")) as ProcessResourceReport;
        if (report.phase !== "finished") throw new Error("Resource host did not finish.");
        return report;
      } catch {
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
    child.once("exit", () => { void complete(); });
    child.once("error", () => { void complete(); });
    return { child, protected: true, complete };
  } catch (error) {
    lease.release();
    if (reportDirectory) await removeReceiptDirectory(reportDirectory);
    throw error;
  }
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
