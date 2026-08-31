import type { AppLanguage, ChatToolExecution } from '../../types';

export function isToolRunning(execution: ChatToolExecution) {
  const normalized = execution.state.trim().toLowerCase();
  return [
    'using',
    'running',
    'pending',
    'started',
    'queued',
    'awaiting_permission',
  ].includes(normalized);
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
  const running =
    executions.find((item) => isToolRunning(item)) ?? executions[executions.length - 1];
  const summary = running?.summary.trim();
  const toolNameText = displayToolName(running?.name ?? '');
  const state = running?.state.trim().toLowerCase() ?? '';
  if (state === 'awaiting_permission') {
    return language === 'zh'
      ? `${toolNameText} 等待授权`
      : `${toolNameText} awaiting permission`;
  }
  if (state === 'queued') {
    return language === 'zh'
      ? `${toolNameText} 排队中`
      : `${toolNameText} queued`;
  }
  if (state === 'pending') {
    return language === 'zh'
      ? `${toolNameText} 等待中`
      : `${toolNameText} pending`;
  }
  if (!summary) {
    return language === 'zh' ? `正在运行 ${toolNameText}` : `Running ${toolNameText}`;
  }
  return language === 'zh'
    ? `正在运行 ${toolNameText} ${summary}`
    : `Running ${toolNameText} ${summary}`;
}

export function activeToolStatusLabel(
  execution: ChatToolExecution,
  language: AppLanguage,
) {
  const state = execution.state.trim().toLowerCase();
  if (state === 'awaiting_permission') {
    return language === 'zh' ? '等待授权' : 'Awaiting permission';
  }
  if (state === 'queued') {
    return language === 'zh' ? '排队中' : 'Queued';
  }
  if (state === 'pending') {
    return language === 'zh' ? '等待中' : 'Pending';
  }
  if (['using', 'running', 'started'].includes(state)) {
    return language === 'zh' ? '运行中' : 'Running';
  }
  return undefined;
}

export function isToolCancelled(execution: ChatToolExecution) {
  return ['cancelled', 'canceled', 'stopped'].includes(
    execution.state.trim().toLowerCase(),
  );
}

export function displayToolName(value: string) {
  let text = value.trim();
  if (!text) {
    return 'Tool';
  }
  const lowered = text.toLowerCase();
  if (lowered === 'consult_logic') return 'LEM Consult';
  if (lowered === 'learn_logic') return 'LEM Learn';
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
  return left.id.localeCompare(right.id);
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
