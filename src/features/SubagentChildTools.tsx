import type { AppLanguage, ChatToolExecution } from '../types';
import { displayToolName } from './toolExecutionState';
import { asRecord } from './toolPayload';

export function SubagentChildTools({
  executions,
  language,
  isFailed,
}: {
  executions: ChatToolExecution[];
  language: AppLanguage;
  isFailed: (execution: ChatToolExecution) => boolean;
}) {
  if (executions.length === 0) {
    return null;
  }
  return (
    <div className="subagent-child-tools">
      <strong>{language === 'zh' ? '子 Agent 工具' : 'Subagent tools'}</strong>
      <div>
        {executions.map((child, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={`${child.id}-${index}`}
            className={`subagent-child-tool ${isFailed(child) ? 'failed' : ''}`}
          >
            <span>{displayToolName(child.name)}</span>
            <em>{child.summary || child.output || child.state}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

export function subagentChildToolExecutions(
  execution: ChatToolExecution,
): ChatToolExecution[] {
  const metadata = execution.metadata;
  const kind = String(metadata.kind ?? metadata.type ?? '').trim();
  if (kind !== 'subagent_tool') {
    return [];
  }
  const rawExecutions =
    metadata.child_tool_executions ??
    metadata.childToolExecutions ??
    metadata.child_tools ??
    metadata.childTools ??
    asRecord(metadata.result).child_tool_executions ??
    asRecord(metadata.result).childToolExecutions;
  if (!Array.isArray(rawExecutions)) {
    return [];
  }
  return rawExecutions
    .map((item, index) => childToolExecutionFromPayload(item, index))
    .filter((item): item is ChatToolExecution => item != null)
    .sort(compareToolExecutionOrder);
}

function childToolExecutionFromPayload(
  item: unknown,
  index: number,
): ChatToolExecution | null {
  const value = asRecord(item);
  const metadata = asRecord(value.metadata);
  const id = String(
    value.id ??
      value.tool_call_id ??
      value.toolCallId ??
      metadata.tool_call_id ??
      `child-tool-${index}`,
  ).trim();
  if (!id) {
    return null;
  }
  const state = String(value.state ?? value.status ?? metadata.state ?? '').trim();
  const createdAt = String(value.created_at ?? value.createdAt ?? '').trim();
  return {
    id,
    name: String(value.name ?? value.tool_name ?? value.toolName ?? 'tool'),
    state,
    summary: String(value.summary ?? value.command ?? value.input ?? ''),
    output: String(value.output ?? value.result ?? ''),
    success: typeof value.success === 'boolean' ? value.success : state !== 'fail',
    durationMs: Number(value.duration_ms ?? value.durationMs ?? 0) || 0,
    createdAt: createdAt || new Date().toISOString(),
    contentOffset: 0,
    contentOffsetExplicit: false,
    sequence: Number.isFinite(Number(value.sequence)) ? Number(value.sequence) : undefined,
    loopIndex: Number.isFinite(Number(value.loop_index ?? value.loopIndex))
      ? Number(value.loop_index ?? value.loopIndex)
      : undefined,
    assistantMessageId: String(
      value.assistant_message_id ?? value.assistantMessageId ?? '',
    ).trim() || undefined,
    metadata,
  };
}

function compareToolExecutionOrder(
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
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
