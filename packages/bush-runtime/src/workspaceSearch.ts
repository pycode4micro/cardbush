import { decodeCommandOutput } from '@cardbush/platform';
import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { runtimeDistributionRoot } from './distributionRoot.js';
import { spawnResourceManagedProcess } from './processResourceGuard.js';
import { WorkspacePathGuard, pathChanged } from './workspacePathGuard.js';
import type { ExecutionSandboxPolicy, ExecutionSandboxStatus } from './executionSandbox.js';
import { workspaceAuthorizedIdentity, workspaceLinuxSandboxExecutable } from './workspaceFileAccess.js';
import { isWithin } from './workspaceAccessPolicy.js';
import { hostEnvironmentValue } from './hostEnvironment.js';
import { processExecutionDeadline } from './processExecutionDeadline.js';

export interface WorkspaceSearchInput {
  path: string;
  query: string;
  regex: boolean;
  globs: string[];
  contextBefore: number;
  contextAfter: number;
  outputMode: 'lines' | 'files';
  maxResults: number;
  maxOutputBytes: number;
  timeoutMs: number;
  includeDependencies: boolean;
}

type Limit = 'max_results' | 'max_output_bytes' | 'timeout' | 'max_files';
const excludedDirectories = ['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'];
/** Shared execution/output budget for native search and its portable fallback. */
export class WorkspaceSearchBudget {
  chunks: Buffer[] = [];
  bytes = 0;
  results = 0;
  limit?: Limit;
  warnings: string[] = [];
  warningCount = 0;
  readonly controller = new AbortController();
  readonly startedAt = Date.now();
  constructor(readonly input: WorkspaceSearchInput, readonly userSignal?: AbortSignal) {}
  get signal() { return this.userSignal ? AbortSignal.any([this.userSignal, this.controller.signal]) : this.controller.signal; }
  check() {
    this.userSignal?.throwIfAborted();
    if (Date.now() - this.startedAt >= this.input.timeoutMs) this.stop('timeout');
    return !this.limit;
  }
  stop(reason: Limit) { if (!this.limit) { this.limit = reason; this.controller.abort(); } }
  warn(error: unknown) {
    this.warningCount++;
    if (this.warnings.length < 32) this.warnings.push(String(error instanceof Error ? error.message : error).slice(0, 2048));
  }
  // Stream chunks, retaining at most maxResults complete lines and maxOutputBytes bytes.
  append(chunk: Buffer) {
    if (this.limit) return;
    let end = chunk.length;
    let lines = 0;
    let resultLimit = false;
    for (let index = 0; index < chunk.length; index++) {
      if (this.results + lines >= this.input.maxResults) { end = index; resultLimit = true; break; }
      if (chunk[index] === 10) lines++;
    }
    const remaining = this.input.maxOutputBytes - this.bytes;
    if (end > remaining) {
      end = remaining;
      lines = chunk.subarray(0, end).reduce((count, byte) => count + Number(byte === 10), 0);
      this.stop('max_output_bytes');
    } else if (resultLimit) this.stop('max_results');
    if (end) { this.chunks.push(Buffer.from(chunk.subarray(0, end))); this.bytes += end; this.results += lines; }
  }
  result(exitCode: number | null, scannedFiles?: number) {
    // rg and the fallback emit UTF-8. Drop an unfinished code point at a byte cap
    // rather than misdetecting a truncated UTF-8 stream as a legacy code page.
    const output = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(this.chunks), { stream: true });
    const limited = this.limit !== undefined;
    const warnings = [...this.warnings,
      this.warningCount > this.warnings.length ? `${this.warningCount - this.warnings.length} additional file access errors.` : '',
      limited ? `Search incomplete (${this.limit}); narrow path/globs or request a larger budget. Returned results are partial, not proof that other matches do not exist.` : '',
    ].filter(Boolean).join('\n');
    return { matched: output.length > 0, output, complete: !limited && !this.warningCount && (exitCode === 0 || exitCode === 1),
      exitCode: limited || this.warningCount ? 2 : exitCode, timedOut: this.limit === 'timeout', truncated: limited,
      returnedResults: this.results + Number(Boolean(output) && !output.endsWith('\n')),
      ...(this.limit ? { limitReason: this.limit } : {}), ...(scannedFiles !== undefined ? { scannedFiles } : {}),
      ...(warnings ? { warnings } : {}) };
  }
}

export async function searchWorkspaceContent(root: string, input: WorkspaceSearchInput, cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const guard = new WorkspacePathGuard();
  const budget = new WorkspaceSearchBudget(input, signal);
  try {
    root = await realpath(root);
    const info = await stat(root, { bigint: true });
    await guard.pin(info.isDirectory() ? root : dirname(root));
    const identity = `${info.dev}:${info.ino}`;
    const admitted = workspaceAuthorizedIdentity(root);
    if (admitted && admitted !== identity) throw pathChanged();
    const executable = await trustedSearchExecutable(root, cwd);
    if (!executable) throw Object.assign(Error('No trusted ripgrep executable is available. Configure CARDBUSH_RG_PATH to an absolute host-installed executable. Search was not run.'), { code: 'workspace_search_unavailable' });
    const sandbox: ExecutionSandboxPolicy = { readableRoots: info.isDirectory() ? [root] : [], writableRoots: [],
      readableFiles: [executable, ...(!info.isDirectory() ? [root] : [])], network: 'disabled',
      privateWorkingDirectory: !info.isDirectory(), requireCanonicalRoots: true, expectedIdentities: { [root]: identity }, linuxExecutable: workspaceLinuxSandboxExecutable() };
    const result = await runRipgrep(executable, workspaceSearchArguments(root, input), info.isDirectory() ? root : dirname(root), budget, sandbox);
    return { ...budget.result(result.code), sandbox: result.sandbox };
  } catch (error) {
    signal?.throwIfAborted();
    if (budget.limit) return budget.result(2);
    throw error;
  } finally { await guard.close(); }
}

/** Resolve host-owned candidates ourselves; never hand a bare name to Windows. */
export async function trustedSearchExecutable(root: string, cwd: string, configured = hostEnvironmentValue('CARDBUSH_RG_PATH')?.trim()) {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = configured !== undefined ? [configured] : [
    join(runtimeDistributionRoot(), 'assets', 'runtime-tools', 'ripgrep', `${process.platform}-${process.arch}`, name),
    ...(hostEnvironmentValue('PATH') ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, name)),
  ];
  const [searchRoot, workspace] = await Promise.all([realpath(root), realpath(cwd)]);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || process.platform === 'win32' && !/^[a-z]:[\\\\/]/i.test(candidate)) continue;
    try {
      const executable = await realpath(candidate);
      if (isWithin(searchRoot, executable) || isWithin(workspace, executable) || !(await stat(executable)).isFile()) continue;
      if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) continue;
      return executable;
    } catch { /* Try only the next explicit absolute host candidate. */ }
  }
}

/** The SSH host uses the same pruning and output contract, with its own process transport. */
export function workspaceSearchArguments(root: string, input: WorkspaceSearchInput) {
  const args = input.outputMode === 'files' ? ['--files-with-matches'] : ['--line-number', '--column', '--no-heading', '--no-context-separator'];
  args.push('--no-config', '--no-ignore-parent', '--no-ignore-global', '--color', 'never');
  if (input.contextBefore && input.outputMode === 'lines') args.push('--before-context', String(input.contextBefore));
  if (input.contextAfter && input.outputMode === 'lines') args.push('--after-context', String(input.contextAfter));
  if (!input.regex) args.push('--fixed-strings');
  for (const glob of input.globs) args.push('--glob', glob);
  // Prune directory entries before descending, including with positive file globs.
  if (input.includeDependencies) args.push('--hidden', '--no-ignore');
  else for (const directory of excludedDirectories) args.push('--glob', `!${directory}`);
  args.push('--', input.query, root);
  return args;
}

async function runRipgrep(executable: string, args: string[], cwd: string, budget: WorkspaceSearchBudget, sandbox: ExecutionSandboxPolicy): Promise<{ code: number | null; sandbox?: ExecutionSandboxStatus }> {
  budget.userSignal?.throwIfAborted();
  const guarded = await spawnResourceManagedProcess({ executable, args, cwd, sandbox, signal: budget.signal, lifetime: 'io' });
  const signal = budget.signal;
  return new Promise((resolveResult, reject) => {
    const child = guarded.child;
    let error: Error | undefined;
    const cancelDeadline = processExecutionDeadline(guarded, budget.input.timeoutMs, failure => {
      if (failure.code === 'process_timeout') budget.stop('timeout');
      else { error = failure; guarded.stop(); }
    });
    const stderr: Buffer[] = []; let stderrBytes = 0;
    const stop = () => guarded.stop();
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => budget.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 64 * 1024) { const kept = chunk.subarray(0, 64 * 1024 - stderrBytes); stderr.push(kept); stderrBytes += kept.length; }
    });
    child.on('error', value => { error = value; });
    child.on('close', async code => {
      cancelDeadline();
      signal.removeEventListener('abort', stop);
      try {
        const report = await guarded.complete();
        budget.userSignal?.throwIfAborted();
        if (error) throw error;
        if (report?.code === 'resource_spawn_failed') {
          const mapped = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 193: 'ENOEXEC' } as Record<number, string>)[report.nativeErrorCode ?? 0];
          if (mapped) throw Object.assign(new Error(report.message), { code: mapped });
        }
        const diagnostic = decodeCommandOutput(Buffer.concat(stderr));
        if (code === 78 || code === 79) throw Object.assign(Error(diagnostic || 'Sandbox startup failed.'), { code: code === 78 ? 'sandbox_approval_changed' : 'sandbox_spawn_failed' });
        if (diagnostic) budget.warn(diagnostic);
        if (report?.code && !budget.limit) throw Object.assign(Error(report.message), { code: report.code });
        resolveResult({ code, sandbox: guarded.sandbox });
      } catch (value) { reject(value); }
    });
  });
}
