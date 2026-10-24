import { commandInvocation, decodeCommandOutput as decodeProcessOutput } from '@cardbush/platform';
import { randomUUID } from 'node:crypto';
import { spawnResourceManagedProcess, reserveProcessResources, isResourceAdmissionError, type ProcessResourceGovernor, type GuardedProcess } from './processResourceGuard.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import { isWithin, normalizeIdentity } from './workspaceAccessPolicy.js';
import type { ExecutionSandboxPolicy } from './executionSandbox.js';
import { decodeExclusiveResources, runtimeExclusiveResources } from './exclusiveResources.js';
import { WindowsSandboxScopePool } from './windowsSandboxScope.js';
import { TerminalDiagnosticStream, type TerminalShellDiagnostic } from './terminalDiagnostics.js';

export type TerminalShell = 'cmd' | 'powershell' | 'posix';
interface TerminalPollInput { sessionId: string; yieldTimeMs: number }
interface TerminalWriteInput extends TerminalPollInput { chars: string }
const MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024;

type TerminalSessionState = "running" | "exited" | "failed" | "stopped";

interface ManagedTerminalSession {
  sessionId: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  shell: TerminalShell;
  shellExecutable: string;
  child: GuardedProcess['child'];
  guarded: GuardedProcess;
  pid: number | null;
  state: TerminalSessionState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string;
  errorCode?: string;
  commandStarted?: boolean;
  nativeErrorCode?: number;
  supervisorExitCode?: number;
  shellDiagnostic?: TerminalShellDiagnostic;
  startedAt: number;
  endedAt?: number;
  lastOutputAt?: number;
  revision: number;
  stopRequested: boolean;
  closed: boolean;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  waiters: Set<() => void>;
  exclusiveResources: string[];
}

export class TerminalSessionManager {
  readonly #sessions = new Map<string, ManagedTerminalSession>();
  // Reserve before the async spawn: simultaneous identical calls must not race.
  readonly #runningCommands = new Map<string, string>();
  readonly #resourceGovernor?: ProcessResourceGovernor;
  readonly #sandboxScopes = new WindowsSandboxScopePool();
  readonly #starting = new Set<Promise<void>>();
  #closing = false;

  constructor(options: { resourceGovernor?: ProcessResourceGovernor } = {}) {
    this.#resourceGovernor = options.resourceGovernor;
  }

  hasRunningWithin(root: string): boolean {
    return [...this.#sessions.values()].some(terminal => terminal.state === "running" && isWithin(root, terminal.cwd));
  }

  async stopWithin(root: string): Promise<void> {
    for (const terminal of [...this.#sessions.values()]) {
      if (terminal.state === "running" && isWithin(root, terminal.cwd)) {
        await this.stop(terminal.ownerSessionId, terminal.sessionId);
      }
    }
    await this.#sandboxScopes.releaseWithin(root);
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#starting]);
    for (const terminal of [...this.#sessions.values()]) {
      if (terminal.state === 'running') await this.stop(terminal.ownerSessionId, terminal.sessionId);
    }
    await this.#sandboxScopes.close();
  }

  async start(input: {
    ownerSessionId: string;
    command: string;
    cwd: string;
    yieldTimeMs: number;
    signal?: AbortSignal;
    shell: TerminalShell;
    sandbox?: ExecutionSandboxPolicy;
    exclusiveResources?: string[];
  }): Promise<Record<string, unknown>> {
    if (this.#closing) throw codedError('terminal_manager_closed', 'The terminal host is shutting down.');
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    this.#starting.add(pending);
    const ready = () => { started(); this.#starting.delete(pending); };
    try { return await this.#start(input, ready); }
    finally { ready(); }
  }

  async #start(input: Parameters<TerminalSessionManager['start']>[0], ready: () => void): Promise<Record<string, unknown>> {
    if (input.signal?.aborted) throw abortReason(input.signal);
    const diagnosticToken = input.shell === 'powershell' ? randomUUID().replaceAll('-', '') : undefined;
    const invocation = commandInvocation(input.shell, input.command, undefined, diagnosticToken);
    const sessionId = `terminal_${randomUUID()}`;
    const exclusiveResources = decodeExclusiveResources(input.exclusiveResources);
    const releaseResources = runtimeExclusiveResources.acquire(sessionId, input.cwd, exclusiveResources);
    const commandKey = JSON.stringify([input.ownerSessionId, normalizeIdentity(input.cwd), input.shell, input.command]);
    const existingId = this.#runningCommands.get(commandKey);
    if (existingId) {
      releaseResources();
      throw Object.assign(codedError('terminal_command_already_running', 'This exact command is already running in this session. Continue independent work; use its existing handle when the result is needed. Do not restart it.'), {
        details: { terminalSessionId: existingId, state: this.#sessions.get(existingId)?.state ?? 'starting' },
      });
    }
    this.#runningCommands.set(commandKey, sessionId);
    let guarded: GuardedProcess;
    let admitted = false;
    try {
      // Reserve through the existing governor before spawn, so an admission
      // rejection is distinguishable from a process that ran and then failed.
      const resourceLease = this.#resourceGovernor
        ? this.#resourceGovernor.acquire('task') : await reserveProcessResources('task', input.signal);
      admitted = true;
      guarded = await spawnResourceManagedProcess({
        executable: invocation.executable,
        args: invocation.args,
        cwd: input.cwd,
        resourceLease,
        sandbox: input.sandbox,
        sandboxScopePool: this.#sandboxScopes,
      });
    } catch (error) {
      this.#runningCommands.delete(commandKey); releaseResources();
      if (!admitted) throw withToolFailureFacts(error instanceof Error ? error : new Error(String(error)), {
        dispatch: 'not_started', effects: 'none', result: 'known',
        recovery: isResourceAdmissionError(error) ? 'retry' : 'correct_input',
      });
      throw error;
    }
    const child = guarded.child;
    const terminal: ManagedTerminalSession = {
      sessionId,
      ownerSessionId: input.ownerSessionId,
      command: input.command,
      cwd: input.cwd,
      shell: input.shell,
      shellExecutable: invocation.executable,
      child,
      guarded,
      pid: child.pid ?? null,
      state: "running",
      exitCode: null,
      signal: null,
      error: "",
      startedAt: Date.now(),
      revision: 0,
      stopRequested: false,
      closed: false,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      waiters: new Set(),
      exclusiveResources,
    };
    this.#sessions.set(terminal.sessionId, terminal);
    child.stdout?.on("data", (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stdout", chunk);
      this.#notify(terminal);
    });
    const appendError = (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stderr", chunk);
      this.#notify(terminal);
    };
    const diagnostics = diagnosticToken ? new TerminalDiagnosticStream(diagnosticToken, appendError,
      value => { terminal.shellDiagnostic = value; }) : undefined;
    child.stderr?.on("data", (chunk: Buffer) => diagnostics ? diagnostics.write(chunk) : appendError(chunk));
    let finishing = false;
    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finishing) return;
      finishing = true;
      let report;
      try { report = await guarded.complete(); }
      catch (error) {
        terminal.error = error instanceof Error ? error.message : String(error);
        terminal.errorCode = 'terminal_cleanup_failed';
      }
      finally { this.#runningCommands.delete(commandKey); releaseResources(); }
      if (report?.code && (!terminal.stopRequested || report.code === 'sandbox_cleanup_failed')) {
        terminal.error = report.message;
        terminal.errorCode = report.code;
      }
      terminal.commandStarted = report?.commandStarted;
      terminal.nativeErrorCode = report?.nativeErrorCode || undefined;
      terminal.state = terminal.stopRequested ? "stopped" : terminal.error || terminal.errorCode ? "failed" : "exited";
      terminal.exitCode = report?.commandStarted === false ? null : exitCode;
      if (report?.commandStarted === false && exitCode !== null) terminal.supervisorExitCode = exitCode;
      terminal.signal = signal;
      terminal.endedAt = Date.now();
      this.#notify(terminal);
      const releaseStreams = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 100);
      releaseStreams.unref?.();
    };
    child.on("error", error => {
      terminal.error = error.message;
      // Node emits close after a failed spawn as well; drain diagnostics first.
    });
    child.on("close", (exitCode, signal) => {
      diagnostics?.flush();
      terminal.closed = true;
      void finish(exitCode, signal);
    });

    ready();
    await this.#waitForExit(terminal, input.yieldTimeMs, input.signal);
    const result = this.#consume(terminal);
    if (terminal.state !== "running") this.#sessions.delete(terminal.sessionId);
    return result;
  }

  async poll(
    ownerSessionId: string,
    input: TerminalPollInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, input.sessionId);
    if (
      terminal.state === "running" &&
      terminal.stdoutBytes === 0 &&
      terminal.stderrBytes === 0
    ) {
      await this.#waitForRevision(terminal, terminal.revision, input.yieldTimeMs, signal);
    }
    const result = this.#consume(terminal);
    if (terminal.state !== "running") this.#sessions.delete(terminal.sessionId);
    return result;
  }

  /** Observe exit without draining stdout/stderr or taking ownership from manual poll. */
  async waitForCompletion(ownerSessionId: string, sessionId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, sessionId);
    await this.#wait(terminal, 3_600_000, signal, () => terminal.closed && terminal.state !== 'running');
    signal?.throwIfAborted();
    return this.#consume(terminal, false);
  }

  async write(
    ownerSessionId: string,
    input: TerminalWriteInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, input.sessionId);
    if (terminal.state !== "running" || !terminal.child.stdin?.writable) {
      throw codedError("terminal_session_not_writable", `Terminal session ${input.sessionId} is not writable.`);
    }
    await new Promise<void>((resolvePromise, reject) => {
      terminal.child.stdin!.write(input.chars, (error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    return this.poll(ownerSessionId, input, signal);
  }

  async stop(ownerSessionId: string, sessionId: string): Promise<Record<string, unknown>> {
    const terminal = this.#owned(ownerSessionId, sessionId);
    terminal.stopRequested = true;
    await terminateProcessTree(terminal);
    // `taskkill` completion and ChildProcess `exit` do not guarantee that the
    // inherited stdio handles have closed. Wait for the bounded `close` fact so
    // callers can safely reuse or delete the terminal working directory.
    await this.#waitForClose(terminal, 1_000);
    if (terminal.state === "running") {
      throw codedError("terminal_stop_unconfirmed", "The terminal has not confirmed exit. Its process and session remain tracked; wait or retry stopping it.");
    }
    const result = this.#consume(terminal);
    this.#sessions.delete(terminal.sessionId);
    terminal.child.stdout?.destroy();
    terminal.child.stderr?.destroy();
    terminal.child.stdin?.destroy();
    return result;
  }

  describe(ownerSessionId: string, sessionId: string) {
    const terminal = this.#owned(ownerSessionId, sessionId);
    return {
      sessionId: terminal.sessionId,
      command: terminal.command,
      pid: terminal.pid,
      state: terminal.state,
      cwd: terminal.cwd,
      sandbox: terminal.guarded.sandbox ?? null,
      exclusiveResources: terminal.exclusiveResources,
    };
  }

  /** Non-consuming status for local UI observers. */
  status(ownerSessionId: string, sessionId: string): Record<string, unknown> {
    const terminal = this.#owned(ownerSessionId, sessionId);
    return { terminalSessionId: terminal.sessionId, state: terminal.state, pid: terminal.pid,
      exitCode: terminal.exitCode, ...terminalTiming(terminal) };
  }

  list(ownerSessionId: string): Array<Record<string, unknown>> {
    return [...this.#sessions.values()]
      .filter((terminal) => terminal.ownerSessionId === ownerSessionId)
      .map((terminal) => ({
        terminalSessionId: terminal.sessionId,
        pid: terminal.pid,
        state: terminal.state,
        command: terminal.command,
        cwd: terminal.cwd,
        shell: terminal.shell,
        exclusiveResources: terminal.exclusiveResources,
        sandbox: terminal.guarded.sandbox ?? null,
        ...terminalTiming(terminal),
        pendingOutput: terminal.stdoutBytes + terminal.stderrBytes > 0,
      }));
  }

  #owned(ownerSessionId: string, sessionId: string): ManagedTerminalSession {
    const terminal = this.#sessions.get(sessionId);
    if (!terminal || terminal.ownerSessionId !== ownerSessionId) {
      throw codedError("terminal_session_not_found", `Terminal session ${sessionId} is not available in this Runtime session.`);
    }
    return terminal;
  }

  #consume(terminal: ManagedTerminalSession, consume = true): Record<string, unknown> {
    const stdout = decodeProcessOutput(Buffer.concat(terminal.stdout));
    const stderr = decodeProcessOutput(Buffer.concat(terminal.stderr));
    const stdoutTruncated = terminal.stdoutTruncated;
    const stderrTruncated = terminal.stderrTruncated;
    if (consume) {
      terminal.stdout = []; terminal.stderr = [];
      terminal.stdoutBytes = 0; terminal.stderrBytes = 0;
      terminal.stdoutTruncated = false; terminal.stderrTruncated = false;
    }
    return {
      terminalSessionId: terminal.sessionId,
      pid: terminal.pid,
      state: terminal.state,
      cwd: terminal.cwd,
      shellExecutable: terminal.shellExecutable,
      ...(terminal.exclusiveResources.length ? { exclusiveResources: terminal.exclusiveResources } : {}),
      sandbox: terminal.guarded.sandbox ?? null,
      ...terminalTiming(terminal),
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(terminal.error ? { error: terminal.error } : {}),
      ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
      ...(terminal.commandStarted === undefined ? {} : { commandStarted: terminal.commandStarted }),
      ...(terminal.nativeErrorCode === undefined ? {} : { nativeErrorCode: terminal.nativeErrorCode }),
      ...(terminal.supervisorExitCode === undefined ? {} : { supervisorExitCode: terminal.supervisorExitCode }),
      ...(terminal.shellDiagnostic ? { shellDiagnostic: terminal.shellDiagnostic } : {}),
    };
  }

  #notify(terminal: ManagedTerminalSession): void {
    terminal.revision += 1;
    for (const waiter of [...terminal.waiters]) waiter();
  }

  #waitForExit(
    terminal: ManagedTerminalSession,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (terminal.state !== "running") return Promise.resolve();
    return this.#wait(terminal, yieldTimeMs, signal, () => terminal.state !== "running");
  }

  #waitForClose(
    terminal: ManagedTerminalSession,
    yieldTimeMs: number,
  ): Promise<void> {
    if (terminal.closed && terminal.state !== "running") return Promise.resolve();
    return this.#wait(terminal, yieldTimeMs, undefined, () => terminal.closed && terminal.state !== "running");
  }

  #waitForRevision(
    terminal: ManagedTerminalSession,
    revision: number,
    yieldTimeMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (terminal.revision !== revision || terminal.state !== "running") return Promise.resolve();
    return this.#wait(
      terminal,
      yieldTimeMs,
      signal,
      () => terminal.revision !== revision || terminal.state !== "running",
    );
  }

  #wait(
    terminal: ManagedTerminalSession,
    yieldTimeMs: number,
    signal: AbortSignal | undefined,
    completed: () => boolean,
  ): Promise<void> {
    if (completed()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminal.waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise();
      };
      const onChange = () => {
        if (completed()) finish();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminal.waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal!));
      };
      const timer = setTimeout(finish, yieldTimeMs);
      terminal.waiters.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function appendTerminalOutput(
  terminal: ManagedTerminalSession,
  channel: "stdout" | "stderr",
  chunk: Buffer,
): void {
  if (chunk.length) terminal.lastOutputAt = Date.now();
  const chunks = terminal[channel];
  const byteKey = channel === "stdout" ? "stdoutBytes" : "stderrBytes";
  const truncatedKey = channel === "stdout" ? "stdoutTruncated" : "stderrTruncated";
  chunks.push(Buffer.from(chunk));
  terminal[byteKey] += chunk.length;
  while (terminal[byteKey] > MAX_TERMINAL_OUTPUT_BYTES && chunks.length > 0) {
    const overflow = terminal[byteKey] - MAX_TERMINAL_OUTPUT_BYTES;
    const first = chunks[0]!;
    if (first.length <= overflow) {
      chunks.shift();
      terminal[byteKey] -= first.length;
    } else {
      chunks[0] = first.subarray(overflow);
      terminal[byteKey] -= overflow;
    }
    terminal[truncatedKey] = true;
  }
}

function terminalTiming(terminal: ManagedTerminalSession) {
  const observedAt = terminal.endedAt ?? Date.now();
  return { phase: terminal.state === 'running' ? terminal.guarded.phase?.() ?? 'executing' : 'finished',
    startedAt: new Date(terminal.startedAt).toISOString(), durationMs: observedAt - terminal.startedAt,
    lastOutputAt: terminal.lastOutputAt ? new Date(terminal.lastOutputAt).toISOString() : null,
    outputIdleMs: observedAt - (terminal.lastOutputAt ?? terminal.startedAt) };
}

async function terminateProcessTree(terminal: ManagedTerminalSession): Promise<void> {
  terminal.guarded.stop();
  await terminal.guarded.complete();
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Terminal wait was cancelled; the terminal session remains available.");
  error.name = "AbortError";
  return error;
}

function codedError(code: string, message: string) { return Object.assign(new Error(message), { code }); }
