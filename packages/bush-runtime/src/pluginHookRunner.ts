import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CLAUDE_TOOL_NAMES, type PluginHook, type PluginHookContext, type PluginHookEvent, type PluginHookResult } from './pluginExtensions.js';
import { executePluginProcess } from './pluginHookProcess.js';
import { interpretHookOutput, mergeHookResults } from './pluginHookOutput.js';
export { executePluginProcess, bashExecutable } from './pluginHookProcess.js';

export interface PluginHookObservation {
  id: string;
  hook: PluginHook;
  phase: 'queued' | 'running' | 'completed' | 'cancelled' | 'skipped';
  output?: string;
  error?: string;
  warning?: string;
}
export interface PluginHookRunnerOptions {
  callMcp?: (hook: PluginHook, input: Record<string, unknown>, context: PluginHookContext) => Promise<unknown>;
  validateToolInput?: (toolName: string, input: unknown) => void;
}
type Observer = (entry: PluginHookObservation) => void;
type BackgroundJob = { id: string; hook: PluginHook; context: PluginHookContext; observe?: Observer; controller: AbortController; promise?: Promise<void> };
type HookSession = { queue: BackgroundJob[]; active: Set<BackgroundJob>; ready: Array<{ id: string; messages: string[] }>; closed: boolean; hooks: PluginHook[]; context: PluginHookContext; observe?: Observer };

/** Owns hook invocations, bounded background work and delivery; the host owns turn facts. */
export class PluginHookRunner {
  private readonly once = new Set<string>();
  private readonly sessions = new Map<string, HookSession>();
  constructor(private readonly dataRoot: string, private readonly options: PluginHookRunnerOptions = {}) {}

  openSession(sessionId: string) {
    if (this.sessions.get(sessionId)?.closed) this.sessions.delete(sessionId);
  }
  takeMessages(sessionId: string) { return this.sessions.get(sessionId)?.ready.splice(0) ?? []; }
  async closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    for (const job of session.queue.splice(0)) job.observe?.({ id: job.id, hook: job.hook, phase: 'cancelled', error: 'Session ended before the background hook started.' });
    for (const job of session.active) job.controller.abort();
    await Promise.allSettled([...session.active].map(job => job.promise));
    session.ready = [];
    if (session.context.request.metadata.agentRole !== 'child') await this.run(session.hooks, 'SessionEnd', { ...session.context, signal: undefined, reason: 'other' }, session.observe);
    for (const key of this.once) if (key.startsWith(`${sessionId}\0`)) this.once.delete(key);
  }
  async close() { await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id))); }

  async run(hooks: PluginHook[], event: PluginHookEvent, context: PluginHookContext, observe?: Observer): Promise<PluginHookResult> {
    const sessionId = context.request.sessionId;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { queue: [], active: new Set(), ready: [], closed: false, hooks, context, observe };
      this.sessions.set(sessionId, session);
    }
    if (session.closed && event !== 'SessionEnd' && event !== 'Interrupt') return { messages: [] };
    session.hooks = hooks; session.context = context; session.observe = observe;
    const invocations: Promise<PluginHookResult>[] = [];
    for (const hook of hooks) {
      if (hook.event !== event || !matches(hook, context)) continue;
      const id = `plugin_hook_${randomUUID()}`;
      if (hook.trusted === false || hook.type === 'prompt' || hook.type === 'agent') {
        observe?.({ id, hook, phase: 'skipped', warning: hook.trusted === false ? 'Hook definition needs review and trust in plugin settings.' : `${hook.type} hooks are parsed but not executed.` });
        continue;
      }
      const onceId = `${sessionId}\0${hook.id}`;
      if (hook.once && this.once.has(onceId)) continue;
      if (hook.once) this.once.add(onceId);
      if (hook.async && event !== 'SessionEnd' && hook.type !== 'mcp_tool') {
        const job: BackgroundJob = { id, hook, context: { ...context, input: structuredClone(context.input), output: structuredClone(context.output), request: { ...context.request, metadata: structuredClone(context.request.metadata) }, signal: undefined }, observe, controller: new AbortController() };
        session.queue.push(job); observe?.({ id, hook, phase: 'queued' });
        this.pump(session);
      } else invocations.push(this.execute(id, hook, context, observe));
    }
    // Every invocation starts before waiting; a denial cannot suppress another matching hook.
    const settled = await Promise.allSettled(invocations);
    const rejected = settled.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return mergeHookResults(settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
  }

  private pump(session: HookSession) {
    while (!session.closed && session.active.size < 8 && session.queue.length) {
      const job = session.queue.shift()!;
      session.active.add(job);
      job.promise = this.execute(job.id, job.hook, { ...job.context, signal: job.controller.signal }, job.observe)
        .then(result => { if (!session.closed && result.messages.length) session.ready.push({ id: job.id, messages: result.messages }); })
        .catch(() => undefined)
        .finally(() => { session.active.delete(job); this.pump(session); });
    }
  }

  private async execute(id: string, hook: PluginHook, context: PluginHookContext, observe?: Observer): Promise<PluginHookResult> {
    observe?.({ id, hook, phase: 'running' });
    let recordedOutput: string | undefined;
    try {
      context.signal?.throwIfAborted();
      const cwd = String(context.request.metadata.workspaceDir || context.request.metadata.projectDir || process.cwd());
      const payload = hookPayload(hook, context, cwd);
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2 MiB.');
      let output: { stdout: string; stderr: string; exitCode: number };
      if (hook.type === 'mcp_tool') {
        if (!this.options.callMcp) throw new Error('MCP hook execution is unavailable.');
        const result = await this.options.callMcp(hook, object(expandHookInput(hook.input ?? {}, payload)), context);
        recordedOutput = JSON.stringify(result);
        const value = object(result);
        const text = Array.isArray(value.content) ? value.content.map(item => object(item)).filter(item => item.type === 'text').map(item => String(item.text ?? '')).join('\n') : '';
        if (value.isError === true) throw new Error(text || 'MCP hook returned an error.');
        output = { stdout: value.structuredContent ? JSON.stringify(value.structuredContent) : text || JSON.stringify(value), stderr: '', exitCode: 0 };
      } else {
        const pluginData = join(this.dataRoot, 'plugin-data', createHash('sha256').update(hook.pluginId).digest('hex').slice(0, 24));
        await mkdir(pluginData, { recursive: true });
        const env = { ...process.env, PLUGIN_ROOT: hook.root, PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_ROOT: hook.root, CODEX_PLUGIN_ROOT: hook.root,
          CARDBUSH_PLUGIN_ROOT: hook.root, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: pluginData };
        output = await executePluginProcess({ ...hook, command: process.platform === 'win32' && hook.commandWindows ? hook.commandWindows : hook.command }, serialized, cwd, env, context.signal, 8 * 1024 * 1024);
        recordedOutput = output.stdout;
      }
      const result = await interpretHookOutput(hook, context, output, this.dataRoot);
      if (result.updatedInput !== undefined && context.toolName) this.options.validateToolInput?.(context.toolName, result.updatedInput);
      const parsed = output.stdout.trim().startsWith('{') ? object(JSON.parse(output.stdout)) : {};
      observe?.({ id, hook, phase: 'completed', output: recordedOutput, warning: typeof parsed.systemMessage === 'string' ? parsed.systemMessage : undefined });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const cancelled = context.signal?.aborted === true;
      observe?.({ id, hook, phase: cancelled ? 'cancelled' : 'completed', output: recordedOutput, error: detail });
      if (cancelled) throw context.signal?.reason ?? error;
      return { messages: [] };
    }
  }
}

function matches(hook: PluginHook, context: PluginHookContext) {
  if (!hook.matcher || hook.matcher === '*' || ['Stop', 'Interrupt', 'UserPromptSubmit'].includes(hook.event)) return true;
  const actual = context.toolName ?? '';
  const candidates = hook.event === 'SessionStart' ? [context.source ?? 'startup']
    : hook.event === 'SessionEnd' ? [context.reason ?? 'other']
    : hook.event === 'PreCompact' || hook.event === 'PostCompact' ? [context.trigger ?? 'auto']
    : hook.event.startsWith('Subagent') ? [String(context.request.metadata.pluginAgentId || 'general-purpose')]
    : [actual, ...Object.entries(CLAUDE_TOOL_NAMES).filter(([, names]) => names.includes(actual)).map(([alias]) => alias)];
  return candidates.some(value => new RegExp(hook.matcher).test(value));
}
function hookPayload(hook: PluginHook, context: PluginHookContext, cwd: string) {
  const metadata = context.request.metadata, actual = context.toolName ?? '';
  const legacy = hook.dialect === 'claude', input = object(context.input);
  const alias = actual === 'terminal_exec' ? 'Bash' : legacy ? Object.entries(CLAUDE_TOOL_NAMES).find(([, names]) => names.includes(actual))?.[0] ?? actual : actual;
  return {
    session_id: metadata.agentRole === 'child' ? String(metadata.parentSessionId || context.request.sessionId) : context.request.sessionId,
    transcript_path: null, cwd, model: context.request.model, hook_event_name: hook.event,
    ...(hook.event !== 'SessionEnd' ? { permission_mode: context.request.permissionMode === 'all_free' ? 'bypassPermissions' : 'default', cardbush_permission_mode: context.request.permissionMode } : {}),
    ...(!['SessionStart', 'SessionEnd'].includes(hook.event) ? { turn_id: context.request.turnId } : {}),
    ...(hook.event === 'SessionStart' ? { source: context.source ?? 'startup' } : {}),
    ...(hook.event === 'SessionEnd' ? { reason: context.reason ?? 'other' } : {}),
    ...(hook.event === 'PreCompact' || hook.event === 'PostCompact' ? { trigger: context.trigger ?? 'auto' } : {}),
    ...(actual ? { tool_name: alias, cardbush_tool_name: actual, tool_use_id: context.toolCallId,
      tool_input: legacy ? { ...input, ...(typeof input.path === 'string' ? { file_path: resolve(cwd, input.path) } : {}), ...(input.old_text !== undefined ? { old_string: input.old_text, new_string: input.new_text } : {}) } : context.input } : {}),
    ...(context.output !== undefined ? { tool_response: context.output } : {}), ...(context.error !== undefined ? { error: context.error } : {}),
    ...(hook.event === 'UserPromptSubmit' ? { prompt: context.prompt ?? '' } : {}),
    ...(hook.event.startsWith('Subagent') ? { agent_id: context.request.sessionId, agent_type: metadata.pluginAgentId || 'general-purpose', agent_transcript_path: null } : {}),
    ...(hook.event === 'Stop' || hook.event === 'SubagentStop' ? { stop_hook_active: context.stopHookActive ?? false, last_assistant_message: context.lastAssistantMessage ?? null } : {}),
  };
}
export function expandHookInput(value: unknown, payload: Record<string, unknown>): unknown {
  const field = (path: string) => {
    let result: unknown = payload;
    for (const key of path.split('.')) {
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error(`Missing hook input field: ${path}`);
      result = (result as Record<string, unknown>)[key];
    }
    return structuredClone(result);
  };
  if (typeof value === 'string') {
    const full = value.match(/^\$\{([^}]+)\}$/);
    if (full) return field(full[1]!);
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => { const result = field(key); return typeof result === 'string' ? result : JSON.stringify(result); });
  }
  if (Array.isArray(value)) return value.map(item => expandHookInput(item, payload));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandHookInput(item, payload)]));
  return value;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
