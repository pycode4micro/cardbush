import { decodeCommandOutput } from '@cardbush/platform';
import { lstat, opendir } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { spawnResourceManagedProcess } from './processResourceGuard.js';
import { readFileBounded } from './workspaceFileRead.js';

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
const unavailable = (error: unknown) => ['EACCES', 'EINVAL', 'ENOENT', 'ENOEXEC'].includes(String((error as NodeJS.ErrnoException)?.code));
const inaccessible = (error: unknown) => ['EACCES', 'ENOENT', 'EPERM', 'EBUSY', 'file_resource_limit'].includes(String((error as NodeJS.ErrnoException)?.code));

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
  const budget = new WorkspaceSearchBudget(input, signal);
  const timer = setTimeout(() => budget.stop('timeout'), input.timeoutMs);
  try {
    const args = workspaceSearchArguments(root, input);
    for (const executable of new Set([process.env.CARDBUSH_RG_PATH?.trim(), 'rg'].filter((value): value is string => Boolean(value)))) {
      if (!budget.check()) return budget.result(2);
      try { return budget.result(await runRipgrep(executable, args, cwd, budget)); }
      catch (error) { if (!unavailable(error)) throw error; }
    }
    return await searchWithNode(root, budget);
  } finally { clearTimeout(timer); }
}

/** The SSH host uses the same pruning and output contract, with its own process transport. */
export function workspaceSearchArguments(root: string, input: WorkspaceSearchInput) {
  const args = input.outputMode === 'files' ? ['--files-with-matches'] : ['--line-number', '--column', '--no-heading', '--no-context-separator'];
  args.push('--color', 'never');
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

async function runRipgrep(executable: string, args: string[], cwd: string, budget: WorkspaceSearchBudget): Promise<number | null> {
  budget.userSignal?.throwIfAborted();
  const guarded = await spawnResourceManagedProcess({ executable, args, cwd });
  const signal = budget.signal;
  return new Promise((resolveResult, reject) => {
    const child = guarded.child;
    let error: Error | undefined;
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
        if (diagnostic) budget.warn(diagnostic);
        if (report?.code && !budget.limit) budget.warn(report.message);
        resolveResult(report?.code && !budget.limit ? 2 : code);
      } catch (value) { reject(value); }
    });
  });
}

async function searchWithNode(root: string, budget: WorkspaceSearchBudget) {
  const { input } = budget;
  const signal = budget.signal;
  const positive = input.globs.filter(glob => !glob.startsWith('!')).map(globToRegExp);
  const negative = input.globs.filter(glob => glob.startsWith('!')).map(glob => globToRegExp(glob.slice(1)));
  const expression = input.regex ? new RegExp(input.query) : undefined;
  let scanned = 0;
  const allowed = (path: string, directory: boolean) => {
    const rel = (relative(root, path) || (directory ? '' : basename(path))).replaceAll('\\', '/');
    if (!rel) return true; // Explicit roots are always eligible, even a dependency directory.
    if (!input.includeDependencies && directory && excludedDirectories.includes(basename(path))) return false;
    if (!input.includeDependencies && !positive.length && basename(path).startsWith('.')) return false;
    if (negative.some(glob => glob.test(rel) || directory && glob.test(`${rel}/`))) return false;
    return directory || !positive.length || positive.some(glob => glob.test(rel));
  };
  const search = async (file: string) => {
    if (++scanned > 25_000) { budget.stop('max_files'); return; }
    const bytes = await readFileBounded(file, signal);
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined;
    if (!utf16 && bytes.subarray(0, 8192).includes(0)) return;
    let text;
    try { text = utf16 ? new TextDecoder(utf16, { fatal: true }).decode(bytes) : bytes.toString('utf8').replace(/^\ufeff/, ''); }
    catch { return; }
    if (text.includes('\0')) return;
    const lines = text ? text.split(/\r\n|\r|\n/) : [];
    if (/[\r\n]$/.test(text)) lines.pop();
    const column = (line: string) => expression ? expression.exec(line)?.index ?? -1 : line.indexOf(input.query);
    let emittedUntil = -1;
    let contextUntil = -1;
    for (let index = 0; index < lines.length && budget.check(); index++) {
      const position = column(lines[index]!);
      if (position >= 0) {
        if (input.outputMode === 'files') { budget.append(Buffer.from(`${file}\n`)); return; }
        contextUntil = Math.min(lines.length - 1, index + input.contextAfter);
        for (let before = Math.max(emittedUntil + 1, index - input.contextBefore); before < index && budget.check(); before++) {
          budget.append(Buffer.from(`${file}-${before + 1}-${lines[before]}\n`)); emittedUntil = before;
        }
      }
      if (position >= 0 || index <= contextUntil) {
        budget.append(Buffer.from(position >= 0 ? `${file}:${index + 1}:${position + 1}:${lines[index]}\n` : `${file}-${index + 1}-${lines[index]}\n`));
        emittedUntil = index;
      }
    }
  };
  const visit = async (path: string, kind?: 'file' | 'directory') => {
    if (!budget.check()) return;
    if (!kind) { const info = await lstat(path); if (info.isSymbolicLink()) return; kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : undefined; }
    if (!kind || !allowed(path, kind === 'directory')) return;
    try {
      if (kind === 'file') { await search(path); return; }
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (!budget.check()) break;
        if (entry.isFile() || entry.isDirectory()) await visit(resolve(path, entry.name), entry.isDirectory() ? 'directory' : 'file');
      }
    } catch (error) { if (inaccessible(error)) budget.warn(error); else throw error; }
  };
  try { await visit(root); }
  catch (error) { budget.userSignal?.throwIfAborted(); if (!budget.limit) throw error; }
  return budget.result(budget.bytes ? 0 : 1, scanned);
}

function globToRegExp(value: string): RegExp {
  const normalized = value.replaceAll('\\', '/');
  let source = normalized.includes('/') ? '^' : '^(?:.*/)?';
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]!;
    if (character === '*' && normalized[index + 1] === '*') {
      const slash = normalized[index + 2] === '/'; source += slash ? '(?:.*/)?' : '.*'; index += slash ? 2 : 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}
