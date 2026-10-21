import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PluginHook, PluginHookContext, PluginHookEvent, PluginHookResult } from './pluginExtensions.js';

const contextEvents = new Set<PluginHookEvent>(['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const plainContextEvents = new Set<PluginHookEvent>(['SessionStart', 'SubagentStart', 'UserPromptSubmit']);
export async function interpretHookOutput(hook: PluginHook, context: PluginHookContext,
  output: { stdout: string; stderr: string; exitCode: number }, dataRoot: string): Promise<PluginHookResult> {
  const event = hook.event, result: PluginHookResult = { messages: [] };
  const text = output.stdout.trim();
  const parsed = text.startsWith('{') ? object(JSON.parse(text)) : {};
  const specific = object(parsed.hookSpecificOutput);
  if (specific.hookEventName && specific.hookEventName !== event) throw new Error('Hook output declares a different event.');
  if (output.exitCode !== 0 && output.exitCode !== 2) throw new Error(output.stderr || `Hook exited ${output.exitCode}.`);
  const legacy = hook.dialect === 'claude';
  const decision = specific.permissionDecision ?? parsed.decision;
  const reason = String(specific.permissionDecisionReason || parsed.reason || parsed.stopReason || output.stderr || 'Blocked by plugin hook.');
  const feedback = `${hook.pluginId}: ${reason}`;
  const background = hook.async && event !== 'SessionEnd' && hook.type !== 'mcp_tool';
  if (background) {
    // A background invocation has no control channel, including invalid control fields.
    // Its supported informational context is still delivered at the next safe request.
  } else if (event === 'PermissionRequest') {
    const permission = object(specific.decision);
    if (['updatedInput', 'updatedPermissions', 'interrupt'].some(key => key in permission || key in specific || key in parsed)) {
      result.permissionDecision = 'deny'; result.blocked = `${hook.pluginId}: Unsupported PermissionRequest output fields.`;
      return result;
    }
    if (['continue', 'stopReason', 'suppressOutput'].some(key => key in parsed)) throw new Error('Unsupported PermissionRequest output fields.');
    if (permission.behavior !== undefined && !['allow', 'deny'].includes(String(permission.behavior))) throw new Error('Invalid PermissionRequest decision.');
    result.permissionDecision = permission.behavior as 'allow' | 'deny' | undefined;
    if (result.permissionDecision === 'deny') result.blocked = `${hook.pluginId}: ${String(permission.message || reason)}`;
  } else if (event === 'PreToolUse') {
    if (!legacy && (['continue', 'stopReason', 'suppressOutput'].some(key => key in parsed) || decision === 'ask' || decision === 'approve' || decision === 'defer')) throw new Error('Unsupported PreToolUse output fields; the hook does not change the tool call.');
    if (specific.updatedInput !== undefined) {
      if (decision !== 'allow') throw new Error('updatedInput requires permissionDecision: allow.');
      const replacement = objectRequired(specific.updatedInput, 'updatedInput must be an object.');
      if (context.toolName === 'terminal_exec' || context.toolName === 'apply_patch') {
        if (typeof replacement.command !== 'string') throw new Error('updatedInput must contain a string command.');
        result.updatedInput = { ...object(context.input), ...replacement };
      } else result.updatedInput = legacy ? legacyInput(replacement, context.input) : replacement;
    }
    if (output.exitCode === 2 || decision === 'deny' || decision === 'block' || (legacy && parsed.continue === false)) result.blocked = feedback;
    if (legacy && decision === 'ask') result.ask = reason;
  } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    if (!legacy && ('updatedMCPToolOutput' in specific || 'updatedMCPToolOutput' in parsed || 'suppressOutput' in parsed)) throw new Error('Unsupported PostToolUse output fields; the original result remains valid.');
    if (output.exitCode === 2 || decision === 'block' || decision === 'deny' || parsed.continue === false) {
      result.toolFeedback = await limitMessage(feedback, 2500, context.request.sessionId, dataRoot);
      result.rejectToolResult = output.exitCode === 2 || decision === 'block' || decision === 'deny';
    }
  } else if (event === 'Stop' || event === 'SubagentStop') {
    if (output.exitCode === 0 && text && !text.startsWith('{')) throw new Error(`${event} output must be JSON.`);
    if (parsed.continue === false) result.stopTurn = feedback;
    else if (output.exitCode === 2 || decision === 'block') result.continueTurn = await limitMessage(feedback, 2500, context.request.sessionId, dataRoot);
  } else if (event === 'UserPromptSubmit') {
    if (output.exitCode === 2 || decision === 'block') result.blocked = feedback;
    if (parsed.continue === false) result.stopTurn = feedback;
  } else if (['SessionStart', 'PreCompact', 'PostCompact'].includes(event)) {
    if (parsed.continue === false) result.stopTurn = feedback;
  } else if (event === 'Interrupt' && text && !text.startsWith('{')) throw new Error('Interrupt output must be JSON.');
  // systemMessage is UI/event output, not hidden instructions to the model.
  if (output.exitCode === 0 && contextEvents.has(event)) {
    const contextText = typeof specific.additionalContext === 'string' ? specific.additionalContext
      : plainContextEvents.has(event) && !text.startsWith('{') ? text : '';
    if (contextText) result.messages.push(`${hook.pluginId} / ${event}: ${await limitMessage(contextText, hook.additionalContextLimit ?? 2500, context.request.sessionId, dataRoot)}`);
  }
  return result;
}

export function mergeHookResults(results: PluginHookResult[]): PluginHookResult {
  const merged: PluginHookResult = { messages: results.flatMap(result => result.messages) };
  for (const result of results) {
    if (result.blocked) merged.blocked ??= result.blocked;
    if (result.ask) merged.ask ??= result.ask;
    if (result.updatedInput !== undefined) merged.updatedInput = result.updatedInput;
    if (result.stopTurn !== undefined) merged.stopTurn ??= result.stopTurn;
    if (result.continueTurn !== undefined) merged.continueTurn ??= result.continueTurn;
    if (result.permissionDecision === 'deny' || (result.permissionDecision === 'allow' && !merged.permissionDecision)) merged.permissionDecision = result.permissionDecision;
    if (result.toolFeedback !== undefined && (!merged.toolFeedback || result.rejectToolResult)) merged.toolFeedback = result.toolFeedback;
    if (result.rejectToolResult) merged.rejectToolResult = true;
  }
  return merged;
}

async function limitMessage(text: string, tokens: number, sessionId: string, dataRoot: string) {
  const characters = tokens * 4;
  if (tokens === 0 || text.length <= characters) return text;
  const directory = join(dataRoot, 'hook-outputs', createHash('sha256').update(sessionId).digest('hex'));
  const file = join(directory, `${randomUUID()}.txt`);
  let location = '';
  try { await mkdir(directory, { recursive: true }); await writeFile(file, text, { mode: 0o600 }); location = `\nFull hook output: ${file}`; } catch { /* The preview still gives bounded feedback if storage is unavailable. */ }
  const half = Math.floor(characters / 2);
  return `${text.slice(0, half)}\n[… hook output truncated …]${location}\n${text.slice(-half)}`;
}
function objectRequired(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function legacyInput(input: Record<string, unknown>, original: unknown) {
  const result = { ...object(original), ...input };
  if (input.file_path !== undefined) { result.path = input.file_path; delete result.file_path; }
  if (input.old_string !== undefined) { result.old_text = input.old_string; delete result.old_string; }
  if (input.new_string !== undefined) { result.new_text = input.new_string; delete result.new_string; }
  return result;
}
