import type { MessageKey } from '../../i18n';
import { localizedContent } from '../../i18n';
import { uiText } from '../../i18n';
import type { AppLanguage, ChatToolExecution } from '../../types';
import { normalizeToolDisplay, selectToolActivity, terminalToolOutcome, terminalCommandOutcomeSchema } from '@cardbush/bush-protocol';

export function decodeToolExecutionState(value: unknown): ChatToolExecution['state'] {
  if (
    value === 'queued' || value === 'running' || value === 'awaiting_permission' || value === 'awaiting_solution' ||
    value === 'completed' || value === 'failed' || value === 'cancelled'
  ) return value;
  throw new Error(`Invalid tool execution state: ${String(value)}`);
}

export function isToolRunning(execution: ChatToolExecution) {
  return execution.state === 'running' ||
    execution.state === 'queued' ||
    execution.state === 'awaiting_permission' || execution.state === 'awaiting_solution';
}

export function isToolRunningInContext(
  execution: ChatToolExecution,
  active: boolean,
) {
  return active && isToolRunning(execution);
}

export function runningToolLabel(
  executions: ChatToolExecution[],
  language: AppLanguage,
) {
  const execution = selectToolActivityExecution(executions);
  return execution ? `${toolActionTitle(execution, language)} · ${toolActivityStatus(execution, language, true)}` : '';
}

// Titles describe an intended action; status always comes from runtime facts.
// Never use raw arguments, shell commands or error payloads as a fallback title.
export function toolActionTitle(execution: ChatToolExecution, language: AppLanguage): string {
  const display = normalizeToolDisplay(execution.metadata.displayTitles) ?? normalizeToolDisplay(execution.metadata.displayTitle);
  const localized = localizedContent(display?.titles, language);
  if (typeof localized === 'string' && localized.trim()) return compactActionTitle(localized);
  const supplied = display?.title;
  // Legacy receipts have one title only. Keep it in its own locale; otherwise
  // use the localized tool action without inventing a translation or exposing arguments.
  if (typeof supplied === 'string' && supplied.trim() &&
      (/[\p{Script=Han}]/u.test(supplied) ? language === 'zh' : language === 'en')) return compactActionTitle(supplied);
  const name = execution.name.toLowerCase();
  const labels: Record<string, MessageKey> = {
    terminal_exec: 'toolExecutionState.run_command' as const, shell_command: 'toolExecutionState.run_command' as const,
    open_external_url: 'toolExecutionState.open_webpage' as const,
    linux_computer_use: 'toolExecutionState.use_cloud_computer' as const,
    linux_browser_use: 'toolExecutionState.use_cloud_browser' as const,
    terminal_poll: 'toolExecutionState.check_command_progress' as const, terminal_write: 'toolExecutionState.write_to_terminal' as const,
    read_file: 'toolExecutionState.read_file' as const, read_files: 'toolExecutionState.read_files' as const,
    summary_for_user: 'toolExecutionState.prepare_final_reply' as const, check_habit: 'toolExecutionState.check_personalization' as const, revise_memory: 'toolExecutionState.correct_memory' as const,
    search_file_content: 'toolExecutionState.search_file_contents' as const, list_directory: 'toolExecutionState.list_directory' as const,
    apply_patch: 'toolExecutionState.edit_files' as const, edit_file: 'toolExecutionState.edit_file' as const, write_file: 'toolExecutionState.write_file' as const,
    terminal_stop: 'toolExecutionState.stop_command' as const, terminal_list: 'toolExecutionState.list_terminal_tasks' as const,
    search_skills: 'toolExecutionState.find_relevant_skills' as const, run_skill: 'toolExecutionState.use_skill' as const,
    mcp_search: 'toolExecutionState.find_available_tools' as const, call_tool: 'toolExecutionState.call_tool' as const,
    run_tools: 'toolExecutionState.run_tasks' as const, start_mcp_tool: 'toolExecutionState.start_background_task' as const,
    tasks: 'toolExecutionState.check_task_progress' as const,
    await_subagents: 'toolExecutionState.wait_task_results' as const,
    subagent: 'toolExecutionState.delegate_task' as const, update_task_plan: 'toolExecutionState.update_plan' as const,
    request_user_input_async: 'toolExecutionState.ask_user' as const,
    runtime_context_compaction: 'toolExecutionState.organize_context' as const,
  };
  return (labels[name] && uiText(language)(labels[name])) ?? displayToolName(execution.name, language);
}

function compactActionTitle(value: string) {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
}

export function selectToolActivityExecution(executions: ChatToolExecution[], preferredId?: string) {
  return selectToolActivity(executions, preferredId);
}

export function toolActivityStatus(execution: ChatToolExecution, language: AppLanguage, active: boolean): string {
  if (active && isToolRunning(execution)) return activeToolStatusLabel(execution, language)!;
  if (isToolRunning(execution) || execution.state === 'cancelled') return uiText(language)('toolExecutionBlock.stopped');
  if (execution.state === 'failed') return uiText(language)('automationPanel.failed');
  const terminal = toolTerminalOutcome(execution);
  if (terminal === 'failed') return uiText(language)('toolExecutionState.commandFailed');
  if (terminal === 'stopped') return uiText(language)('automationPanel.stopped');
  if (terminal === 'running') return uiText(language)('toolExecutionState.sentToBackground');
  if (terminal === 'succeeded') return uiText(language)('toolExecutionState.commandExited');
  // A returned tool receipt can represent a submitted/running remote job.
  return uiText(language)('toolExecutionState.returned');
}

export function toolTerminalOutcome(execution: ChatToolExecution) {
  if (execution.state !== 'completed') return undefined;
  const native = terminalToolOutcome(execution.name, execution.metadata.nativeResult);
  if (native) return native;
  const summary = terminalCommandOutcomeSchema.safeParse(execution.metadata.terminalOutcome);
  return summary.success ? summary.data : undefined;
}

export function activeToolStatusLabel(
  execution: ChatToolExecution,
  language: AppLanguage,
) {
  const state = execution.state;
  if (state === 'awaiting_solution') return uiText(language)('toolExecutionState.awaitingSolutionSelection');
  if (state === 'awaiting_permission') {
    return uiText(language)('toolExecutionState.awaitingPermission');
  }
  if (state === 'queued') {
    return uiText(language)('automationPanel.queued');
  }
  if (state === 'running') {
    return uiText(language)('cardlingWindow.running');
  }
  return undefined;
}

export function displayToolName(value: string, language?: AppLanguage) {
  let text = value.trim();
  if (!text) {
    return uiText(language)('toolExecutionState.tool');
  }
  const lowered = text.toLowerCase();
  if (lowered === 'request_user_input_async') return uiText(language)('toolExecutionState.ask_user');
  if (lowered === 'runtime_context_compaction') return uiText(language)('toolExecutionBlock.contextCompaction');
  if (lowered === 'workspace_checkpoint') return uiText(language)('toolExecutionState.workspace_changes');
  for (const separator of [':', '.', '/']) {
    if (text.includes(separator)) {
      text = text.split(separator).pop() ?? text;
    }
  }
  if (text === 'shell_command' || text === 'terminal_exec') {
    return uiText(language)('toolExecutionState.shell');
  }
  return text;
}

export function compareToolExecutionOrder(
  left: ChatToolExecution,
  right: ChatToolExecution,
) {
  const sequenceDelta = compareOptionalNumber(left.sequence, right.sequence);
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  const loopDelta = compareOptionalNumber(left.loopIndex, right.loopIndex);
  if (loopDelta !== 0) {
    return loopDelta;
  }
  const dateDelta = compareOptionalNumber(
    dateTimestamp(left.createdAt),
    dateTimestamp(right.createdAt),
  );
  if (dateDelta !== 0) {
    return dateDelta;
  }
  // Equal/missing ordering facts preserve delivery order. Sorting opaque IDs
  // alphabetically can put a newer call before an older one (e.g. 11 before 9).
  return 0;
}

export function toolExecutionFinishedAt(execution: ChatToolExecution) {
  const startedAt = parseTimestamp(execution.createdAt);
  if (startedAt == null) {
    return undefined;
  }
  return startedAt + Math.max(0, execution.durationMs);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined) {
  if (left == null || right == null) {
    return 0;
  }
  return left - right;
}

function dateTimestamp(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return parseTimestamp(value);
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
