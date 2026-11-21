import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { terminalInvocation } from '@cardbush/platform';
import type { ChatTerminal } from './agentChatCli.mjs';

/** Only explicit user input enters the local shell. Model output never does. */
export function chatShellCommand(text: string): string | undefined {
  const value = text.trim();
  if (value.startsWith('!')) return value.slice(1).trim();
  const match = /^\/shell(?:\s+([\s\S]*))?$/.exec(value);
  return match ? (match[1] ?? '').trim() : undefined;
}

export function chatShellInvocation(command: string, cwd: string, context?: Parameters<typeof terminalInvocation>[3]) {
  const invocation = terminalInvocation(undefined, cwd, command || undefined, context);
  if ((context?.platform ?? process.platform) === 'win32' && win32.basename(invocation.command).toLowerCase() === 'cmd.exe') {
    // cmd /s /c expects a single quoted command, not CRT-escaped arguments.
    return command ? { ...invocation, args: [...invocation.args.slice(0, -1), `"${command}"`], windowsVerbatimArguments: true } : invocation;
  }
  // Reuse platform shell discovery/quoting, but allow native interactive input.
  return { ...invocation, args: invocation.args.filter(argument => argument !== '-NonInteractive') };
}

export async function runChatShell(command: string, cwd: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const invocation = chatShellInvocation(command, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, stdio: 'inherit', windowsHide: true, signal,
      windowsVerbatimArguments: 'windowsVerbatimArguments' in invocation && invocation.windowsVerbatimArguments });
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    // Wait for terminal ownership to return, including failures and cancellation.
    child.once('close', code => failure ? reject(failure) : resolve(code ?? 130));
  });
}

export async function executeChatShell(io: ChatTerminal, command: string, cwd: string, signal: AbortSignal) {
  if (!io.runShell) { io.status('Native shell commands require an interactive terminal.\n'); return; }
  io.status(`\nLocal terminal · ${cwd}\n${command ? '$ ' + command : 'Type exit to return to CardBush.'}\n`);
  try {
    const code = await io.runShell(command, cwd, signal);
    if (code !== 0) io.status(`Command exited with code ${code}.\n`);
  } catch (error) {
    if (signal.aborted) throw error;
    io.status(`[Shell] ${error instanceof Error ? error.message : 'Could not start command'}\n`);
  }
}
