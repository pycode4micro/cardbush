import type { AppLanguage, ChatToolExecution } from '../../types';
import { asRecord, parseToolOutputJson } from './toolPayload';

export function terminalExecutionNotice(execution: ChatToolExecution, language: AppLanguage) {
  if (execution.state !== 'completed' ||
    !['terminal_exec', 'terminal_poll', 'terminal_write', 'terminal_stop', 'shell_command'].includes(execution.name)) return undefined;
  const result = execution.metadata.nativeResult == null
    ? parseToolOutputJson(execution.output)
    : asRecord(execution.metadata.nativeResult);
  const exitCode = typeof result.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : undefined;
  if (result.state === 'failed' || (exitCode !== undefined && exitCode !== 0)) {
    return {
      failed: true,
      label: exitCode !== undefined && exitCode !== 0
        ? language === 'zh' ? `退出码 ${exitCode}` : `Exit code ${exitCode}`
        : language === 'zh' ? '命令失败' : 'Command failed',
      detail: language === 'zh'
        ? '命令未成功。请查看原始输出；重试前需确认已经完成的操作。'
        : 'The command failed. Inspect the original output and check for partial effects before retrying.',
    };
  }
  if (typeof result.stderr === 'string' && result.stderr.trim()) {
    return {
      failed: false,
      label: language === 'zh' ? '有诊断输出' : 'Diagnostic output',
      detail: language === 'zh'
        ? '标准错误流包含诊断信息，可能是警告或未中止执行的错误。即使退出码为 0，也需核对输出和预期产物。'
        : 'stderr contains diagnostics, possibly warnings or non-terminating errors. Check the output and expected artifacts even if the exit code is 0.',
    };
  }
  return undefined;
}

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
  const supplied = execution.metadata.displayTitle;
  if (typeof supplied === 'string' && supplied.trim()) return Array.from(supplied.replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
  const name = execution.name.toLowerCase();
  const labels: Record<string, [string, string]> = {
    terminal_exec: ['执行命令', 'Run command'], shell_command: ['执行命令', 'Run command'],
    terminal_poll: ['查看命令进度', 'Check command progress'], terminal_write: ['向终端输入', 'Write to terminal'],
    read_file: ['读取文件', 'Read file'], read_files: ['读取文件', 'Read files'],
    search_file_content: ['检索文件内容', 'Search file contents'], list_directory: ['查看目录', 'List directory'],
    apply_patch: ['修改文件', 'Edit files'], edit_file: ['修改文件', 'Edit file'], write_file: ['写入文件', 'Write file'],
    terminal_stop: ['停止命令', 'Stop command'], terminal_list: ['查看终端任务', 'List terminal tasks'],
    search_skills: ['查找相关技能', 'Find relevant skills'], run_skill: ['使用技能', 'Use skill'],
    mcp_search: ['查找可用工具', 'Find available tools'], mcp_call: ['调用插件', 'Call plugin'],
    parallel_tools: ['执行任务', 'Run tasks'], start_mcp_tool: ['启动后台任务', 'Start background task'],
    manage_tool_calls: ['查看任务进度', 'Check task progress'], await_subagents: ['等待任务结果', 'Wait for task results'],
    subagent: ['分配任务', 'Delegate task'], update_task_plan: ['更新计划', 'Update plan'],
    request_permission: ['申请授权', 'Request permission'], solution_selection: ['确认方案', 'Select solution'],
    runtime_context_compaction: ['整理上下文', 'Organize context'],
  };
  return labels[name]?.[language === 'zh' ? 0 : 1] ?? displayToolName(execution.name);
}

export function selectToolActivityExecution(executions: ChatToolExecution[], preferredId?: string) {
  const preferred = executions.find(item => item.id === preferredId);
  // Keep the current parallel operation until it settles. In particular,
  // completion events must not reorder the title back to a previous operation.
  return executions.find(item => item.state === 'awaiting_permission' || item.state === 'awaiting_solution')
    ?? (preferred && isToolRunning(preferred) ? preferred : undefined)
    ?? executions.find(item => item.state === 'running')
    ?? executions.find(item => item.state === 'queued')
    ?? preferred ?? executions[executions.length - 1];
}

export function toolActivityStatus(execution: ChatToolExecution, language: AppLanguage, active: boolean): string {
  if (active && isToolRunning(execution)) return activeToolStatusLabel(execution, language)!;
  if (isToolRunning(execution) || execution.state === 'cancelled') return language === 'zh' ? '已中止' : 'Stopped';
  if (execution.state === 'failed' || terminalExecutionNotice(execution, language)?.failed) return language === 'zh' ? '失败' : 'Failed';
  // A returned tool receipt can represent a submitted/running remote job.
  return language === 'zh' ? '已返回' : 'Returned';
}

export function activeToolStatusLabel(
  execution: ChatToolExecution,
  language: AppLanguage,
) {
  const state = execution.state;
  if (state === 'awaiting_solution') return language === 'zh' ? '等待方案选择' : 'Awaiting solution selection';
  if (state === 'awaiting_permission') {
    return language === 'zh' ? '等待授权' : 'Awaiting permission';
  }
  if (state === 'queued') {
    return language === 'zh' ? '排队中' : 'Queued';
  }
  if (state === 'running') {
    return language === 'zh' ? '运行中' : 'Running';
  }
  return undefined;
}

export function isToolCancelled(execution: ChatToolExecution) {
  return execution.state === 'cancelled';
}

export function displayToolName(value: string) {
  let text = value.trim();
  if (!text) {
    return 'Tool';
  }
  const lowered = text.toLowerCase();
  if (lowered === 'solution_selection') return 'Solution Selection';
  if (lowered === 'runtime_context_compaction') return 'Context compaction';
  if (lowered === 'workspace_checkpoint') return 'Workspace changes';
  for (const separator of [':', '.', '/']) {
    if (text.includes(separator)) {
      text = text.split(separator).pop() ?? text;
    }
  }
  if (text === 'shell_command' || text === 'terminal_exec') {
    return 'Shell';
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
