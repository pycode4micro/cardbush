import { spawn } from 'node:child_process';
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
  // Reuse platform shell discovery/quoting, but allow native interactive input.
  return { ...invocation, args: invocation.args.filter(argument => argument !== '-NonInteractive') };
}

export async function runChatShell(command: string, cwd: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const invocation = chatShellInvocation(command, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, stdio: 'inherit', windowsHide: true, signal });
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
