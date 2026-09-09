import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CLAUDE_TOOL_NAMES, type PluginHook, type PluginHookContext, type PluginHookEvent, type PluginHookResult } from './pluginExtensions.js';

export interface PluginHookObservation {
  id: string;
  hook: PluginHook;
  phase: 'running' | 'completed' | 'cancelled';
  output?: string;
  error?: string;
}

/** Runs only installed, enabled plugin declarations supplied by the desktop host. */
export class PluginHookRunner {
  private readonly once = new Set<string>();
  constructor(private readonly dataRoot: string) {}

  async run(hooks: PluginHook[], event: PluginHookEvent, context: PluginHookContext,
    observe?: (entry: PluginHookObservation) => void): Promise<PluginHookResult> {
    const result: PluginHookResult = { messages: [] };
    const cwd = String(context.request.metadata.workspaceDir || context.request.metadata.projectDir || process.cwd());
    const actualName = context.toolName ?? '';
    const aliases = Object.entries(CLAUDE_TOOL_NAMES).filter(([, names]) => names.includes(actualName)).map(([name]) => name);
    let activeInput = context.input;
    for (const hook of hooks) {
      if (context.signal?.aborted) throw context.signal.reason ?? new DOMException('Hook cancelled.', 'AbortError');
      if (hook.event !== event) continue;
      const alias = aliases.find(name => !hook.matcher || hook.matcher === '*' || new RegExp(hook.matcher).test(name)) ?? actualName;
      const matchValue = event === 'SessionStart' ? 'startup' : event.startsWith('Subagent') ? String(context.request.metadata.pluginAgentId || 'general-purpose') : alias;
      if (hook.matcher && hook.matcher !== '*' && !new RegExp(hook.matcher).test(matchValue) && !(actualName && new RegExp(hook.matcher).test(actualName))) continue;
      const onceId = `${context.request.sessionId}:${hook.id}`;
      if (hook.once && this.once.has(onceId)) continue;
      if (hook.once) this.once.add(onceId);
      const id = `plugin_hook_${randomUUID()}`;
      const payload = { session_id: context.request.sessionId, cwd, permission_mode: context.request.permissionMode,
        hook_event_name: event, tool_name: alias, cardbush_tool_name: actualName, tool_input: claudeInput(activeInput, cwd),
        tool_use_id: context.toolCallId, tool_response: context.output, error: context.error,
        prompt: context.prompt, last_assistant_message: context.lastAssistantMessage,
        stop_hook_active: context.stopHookActive ?? false, agent_id: context.request.sessionId,
        agent_type: context.request.metadata.pluginAgentId || 'general-purpose' };
      observe?.({ id, hook, phase: 'running' });
      try {
        const rootId = createHash('sha256').update(hook.pluginId).digest('hex').slice(0, 24);
        const pluginData = join(this.dataRoot, 'plugin-data', rootId);
        await mkdir(pluginData, { recursive: true });
        const env = { ...process.env, CLAUDE_PLUGIN_ROOT: hook.root, CODEX_PLUGIN_ROOT: hook.root,
          CARDBUSH_PLUGIN_ROOT: hook.root, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: pluginData };
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2 MiB.');
        const output = await executePluginProcess(hook, serialized, cwd, env, context.signal);
        const text = output.stdout.trim();
        let parsed: Record<string, unknown> = {};
        if (text.startsWith('{')) parsed = JSON.parse(text);
        const specific = object(parsed.hookSpecificOutput);
        if (specific.hookEventName && specific.hookEventName !== event) throw new Error('Hook output declares a different event.');
        const feedback = String(specific.additionalContext || parsed.systemMessage || '');
        if (specific.additionalContext && (event === 'Stop' || event === 'SubagentStop')) result.shouldContinue = true;
        if (feedback) result.messages.push(`${hook.pluginId} / ${event}: ${feedback}`);
        if (!text.startsWith('{') && text && (event === 'SessionStart' || event === 'UserPromptSubmit')) result.messages.push(`${hook.pluginId} / ${event}: ${text}`);
        const decision = specific.permissionDecision ?? parsed.decision;
        if (output.exitCode === 2 || decision === 'deny' || decision === 'block' || parsed.continue === false) {
          const reason = String(specific.permissionDecisionReason || parsed.reason || parsed.stopReason || output.stderr || 'Blocked by plugin hook.');
          if (['PreToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop'].includes(event)) result.blocked = `${hook.pluginId}: ${reason}`;
          else result.messages.push(`${hook.pluginId} / ${event}: ${reason}`);
        } else if (output.exitCode !== 0) result.messages.push(`${hook.pluginId} / ${event}: ${output.stderr || `Hook exited ${output.exitCode}`}`);
        if (event === 'PreToolUse') {
          if (specific.updatedInput !== undefined) {
            // Preserve CardBush's execution fields (cwd, shell, yield time), but map Claude's edited fields back.
            result.updatedInput = cardbushInput(specific.updatedInput, activeInput);
            activeInput = result.updatedInput;
          }
          if (decision === 'ask') result.ask = String(specific.permissionDecisionReason || `Plugin ${hook.pluginId} requests confirmation.`);
          // An "allow" never bypasses CardBush's own admission and permission decisions.
          if (decision === 'defer') result.blocked = `${hook.pluginId}: deferred tool calls are not supported.`;
        }
        if (specific.updatedToolOutput !== undefined) result.messages.push(`${hook.pluginId}: Hook supplied an alternative result: ${JSON.stringify(specific.updatedToolOutput).slice(0, 8000)}`);
        observe?.({ id, hook, phase: 'completed', output: output.stdout, error: output.exitCode === 0 ? undefined : output.stderr || `Exit ${output.exitCode}` });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (context.signal?.aborted) {
          observe?.({ id, hook, phase: 'cancelled', error: detail });
          throw context.signal.reason ?? error;
        }
        observe?.({ id, hook, phase: 'completed', error: detail });
        // A failed precondition cannot silently authorize the original action.
        if (event === 'PreToolUse') result.blocked = `${hook.pluginId}: ${detail}`;
        else result.messages.push(`${hook.pluginId} / ${event}: ${detail}`);
      }
      if (result.blocked) break;
    }
    result.messages = result.messages.map(message => message.slice(0, 8000)).slice(0, 20);
    return result;
  }
}

/** Shared bounded process execution; event parsing remains in the Hook/Command caller. */
export async function executePluginProcess(hook: Pick<PluginHook, 'command' | 'args' | 'shell' | 'timeout'>, input: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const expand = (value: string) => value.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, (_, key) => env[key] ?? '');
  let command: string, args: string[];
  if (hook.args) { command = expand(hook.command); args = hook.args.map(expand); }
  else if (hook.shell === 'powershell') {
    command = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hook.command.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '$env:$1')];
  } else if (hook.shell === 'cmd') { command = 'cmd.exe'; args = ['/d', '/s', '/c', hook.command.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CARDBUSH_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, '%$1%')]; }
  else { command = await bashExecutable(); args = ['-c', hook.command]; }
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((fulfill, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', size = 0, ended = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => { if (ended) return; ended = true; cleanup(); void killTree(child.pid).finally(() => reject(error)); };
    const abort = () => fail(new DOMException('Plugin hook cancelled.', 'AbortError'));
    const timer = setTimeout(() => fail(new Error(`Plugin hook timed out after ${hook.timeout}s.`)), hook.timeout * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, channel] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) { fail(new Error('Plugin hook output exceeded 256 KiB.')); return; }
      if (channel === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', code => { if (ended) return; ended = true; cleanup(); fulfill({ stdout, stderr, exitCode: code ?? 1 }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
export async function bashExecutable() {
  if (process.platform !== 'win32') return '/bin/bash';
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    const candidate = join(base, 'Git', 'bin', 'bash.exe');
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('This hook requires Git Bash. Install Git for Windows or use a PowerShell/exec-form hook.');
}
async function killTree(pid?: number) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(fulfill => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(fulfill, 2000);
      const done = () => { clearTimeout(timer); fulfill(); };
      killer.on('error', done); killer.on('close', done);
    });
  } else { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ } }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function claudeInput(value: unknown, cwd: string) {
  const input = object(value);
  return { ...input, ...(typeof input.path === 'string' ? { file_path: resolve(cwd, input.path) } : {}),
    ...(input.old_text !== undefined ? { old_string: input.old_text, new_string: input.new_text } : {}) };
}
function cardbushInput(value: unknown, original: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hook updatedInput must be an object.');
  const input = object(value), result = { ...object(original), ...input };
  if (input.file_path !== undefined) { result.path = input.file_path; delete result.file_path; }
  if (input.old_string !== undefined) { result.old_text = input.old_string; delete result.old_string; }
  if (input.new_string !== undefined) { result.new_text = input.new_string; delete result.new_string; }
  return result;
}
