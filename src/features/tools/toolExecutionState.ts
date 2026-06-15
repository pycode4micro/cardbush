import type { AppLanguage, ChatToolExecution } from '../../types';

export function isToolRunning(execution: ChatToolExecution) {
  const normalized = execution.state.trim().toLowerCase();
  return ['using', 'running', 'pending', 'started'].includes(normalized);
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
  if (!summary) {
    return language === 'zh' ? `正在运行 ${toolNameText}` : `Running ${toolNameText}`;
  }
  return language === 'zh'
    ? `正在运行 ${toolNameText} ${summary}`
    : `Running ${toolNameText} ${summary}`;
}

export function displayToolName(value: string) {
  let text = value.trim();
  if (!text) {
    return 'Tool';
  }
  const lowered = text.toLowerCase();
  if (lowered === 'ked' || lowered === 'lem') {
    return lowered.toUpperCase();
  }
  if (lowered.startsWith('ked_') || lowered.startsWith('lem_')) {
    const [service, ...actionParts] = lowered.split('_');
    return `${service.toUpperCase()} ${actionParts.join('_') || 'tool'}`;
  }
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
