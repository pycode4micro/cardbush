import { commandInvocation, decodeCommandOutput as decodeProcessOutput } from '@cardbush/platform';
import { randomUUID } from 'node:crypto';
import { spawnResourceManagedProcess, type ProcessResourceGovernor, type GuardedProcess } from './processResourceGuard.js';
import { isWithin } from './workspaceAccessPolicy.js';
import type { ExecutionSandboxPolicy } from './executionSandbox.js';

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
  startedAt: number;
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
}

export class TerminalSessionManager {
  readonly #sessions = new Map<string, ManagedTerminalSession>();
  readonly #resourceGovernor?: ProcessResourceGovernor;

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
  }

  async start(input: {
    ownerSessionId: string;
    command: string;
    cwd: string;
    yieldTimeMs: number;
    signal?: AbortSignal;
    shell: TerminalShell;
    sandbox?: ExecutionSandboxPolicy;
  }): Promise<Record<string, unknown>> {
    if (input.signal?.aborted) throw abortReason(input.signal);
    const invocation = commandInvocation(input.shell, input.command);
    const guarded = await spawnResourceManagedProcess({
      executable: invocation.executable,
      args: invocation.args,
      cwd: input.cwd,
      governor: this.#resourceGovernor,
      sandbox: input.sandbox,
    });
    const child = guarded.child;
    const terminal: ManagedTerminalSession = {
      sessionId: `terminal_${randomUUID()}`,
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
    };
    this.#sessions.set(terminal.sessionId, terminal);
    child.stdout?.on("data", (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stdout", chunk);
      this.#notify(terminal);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendTerminalOutput(terminal, "stderr", chunk);
      this.#notify(terminal);
    });
    child.on("error", (error) => {
      terminal.state = "failed";
      terminal.error = error.message;
      this.#notify(terminal);
    });
    child.on("exit", async (exitCode, signal) => {
      const report = await guarded.complete();
      if (report?.code && (!terminal.stopRequested || report.code === 'sandbox_cleanup_failed')) {
        terminal.error = report.message;
        terminal.errorCode = report.code;
      }
      terminal.state = terminal.stopRequested ? "stopped" : terminal.errorCode ? "failed" : "exited";
      terminal.exitCode = exitCode;
      terminal.signal = signal;
      this.#notify(terminal);
      const releaseStreams = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 100);
      releaseStreams.unref?.();
    });
    child.on("close", () => {
      terminal.closed = true;
      // The exit receipt may still be loading. Do not wake a poll with an empty
      // "running" result between native close and the final terminal state.
      if (terminal.state !== "running") this.#notify(terminal);
    });

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
      sandbox: terminal.guarded.sandbox ?? null,
    };
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
        sandbox: terminal.guarded.sandbox ?? null,
        startedAt: new Date(terminal.startedAt).toISOString(),
        durationMs: Date.now() - terminal.startedAt,
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
      shellExecutable: terminal.shellExecutable,
      sandbox: terminal.guarded.sandbox ?? null,
      durationMs: Date.now() - terminal.startedAt,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(terminal.error ? { error: terminal.error } : {}),
      ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
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
