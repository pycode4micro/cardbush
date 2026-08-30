import type { AppLanguage, ChatMessage } from '../../types';

export interface WorkSummaryHistoryTurn {
  id: string;
  turnId: string;
  turnSequence?: number;
  message: ChatMessage;
  history: ChatMessage[];
  prompt: string;
  toolCount: number;
  order: number;
}

interface PendingHistoryTurn {
  id: string;
  turnId: string;
  assistants: Array<{ message: ChatMessage; order: number }>;
  prompt: string;
}

/**
 * Projects both live collapsed messages and raw persisted Runtime messages into
 * the same replay model. Persisted sessions intentionally remain append-only,
 * so they do not carry the renderer-only `loopHistory` field after a restart.
 */
export function groupWorkSummaryHistoryByTurn(
  messages: ChatMessage[],
): WorkSummaryHistoryTurn[] {
  const promptsByTurn = new Map<string, string>();
  for (const message of messages) {
    if (!isHistoryUserInstruction(message)) continue;
    const prompt = historyPromptPreview(message.content);
    const turnId = message.turnId?.trim();
    if (turnId && prompt && !promptsByTurn.has(turnId)) {
      promptsByTurn.set(turnId, prompt);
    }
  }

  const pending = new Map<string, PendingHistoryTurn>();
  let nearbyPrompt = '';
  messages.forEach((message, order) => {
    if (message.role === 'user') {
      if (isHistoryUserInstruction(message)) {
        nearbyPrompt = historyPromptPreview(message.content) || nearbyPrompt;
      }
      return;
    }
    if (message.role !== 'assistant') return;
    const turnId = message.turnId?.trim() ?? '';
    const id = turnId || message.id;
    const existing = pending.get(id);
    if (existing) {
      existing.assistants.push({ message, order });
      return;
    }
    pending.set(id, {
      id,
      turnId,
      assistants: [{ message, order }],
      prompt: (turnId && promptsByTurn.get(turnId)) || nearbyPrompt,
    });
  });

  return [...pending.values()]
    .map(projectHistoryTurn)
    .filter((group): group is WorkSummaryHistoryTurn => group !== null)
    .sort((left, right) => {
      const leftSequence = left.turnSequence ?? left.order;
      const rightSequence = right.turnSequence ?? right.order;
      return rightSequence - leftSequence || right.order - left.order;
    });
}

function projectHistoryTurn(
  pending: PendingHistoryTurn,
): WorkSummaryHistoryTurn | null {
  const finalEntry = pending.assistants.at(-1);
  if (!finalEntry) return null;

  const rawIntermediate = pending.assistants
    .slice(0, -1)
    .map(({ message }) => replayMessage(message));
  const collapsedHistory = pending.assistants.flatMap(({ message }) =>
    (message.loopHistory ?? []).map(replayMessage));
  let history = mergeHistoryMessages(rawIntermediate, collapsedHistory);

  // Older persisted records could only associate a tool with the last
  // assistant message in a Turn. Preserve those receipts without duplicating
  // the final answer text in the execution replay.
  const representedToolIds = new Set(
    history.flatMap((message) =>
      (message.toolExecutions ?? []).map((execution) => execution.id)),
  );
  const trailingExecutions = (finalEntry.message.toolExecutions ?? []).filter(
    (execution) => !representedToolIds.has(execution.id),
  );
  if (trailingExecutions.length > 0) {
    const finalHasToolCalls = Array.isArray(finalEntry.message.metadata?.toolCalls) &&
      finalEntry.message.metadata.toolCalls.length > 0;
    history = mergeHistoryMessages(history, [{
      ...replayMessage(finalEntry.message),
      content: finalHasToolCalls ? finalEntry.message.content : '',
      toolExecutions: trailingExecutions,
    }]);
  }

  if (history.length === 0) return null;
  const finalMessage = finalEntry.message;
  return {
    id: pending.id,
    turnId: pending.turnId,
    turnSequence: historyTurnSequence(finalMessage),
    message: finalMessage,
    history,
    prompt: pending.prompt,
    toolCount: history.reduce(
      (total, item) => total + (item.toolExecutions?.length ?? 0),
      0,
    ),
    order: finalEntry.order,
  };
}

function replayMessage(message: ChatMessage): ChatMessage {
  if (!message.loopHistory) return message;
  const { loopHistory: _loopHistory, ...replay } = message;
  return replay;
}

function mergeHistoryMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((message, index) => {
    const key = message.messageId?.trim() || message.id.trim() || `${message.turnId ?? ''}:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyPromptPreview(content: string) {
  return content
    .replace(/Attached files \(absolute paths\):[\s\S]*$/i, '')
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

function isHistoryUserInstruction(message: ChatMessage) {
  if (message.role !== 'user') return false;
  const metadata = message.metadata ?? {};
  if (
    String(metadata.name ?? '').trim().toLowerCase() === 'turn_guidance' ||
    metadata.turn_guidance === true ||
    metadata.goal_auto_continuation === true ||
    metadata.goalAutoContinuation === true
  ) {
    return false;
  }
  const runtime = metadata.runtime && typeof metadata.runtime === 'object'
    ? metadata.runtime as Record<string, unknown>
    : {};
  const runtimeLabel = String(
    metadata.runtime_user_label ??
      metadata.runtimeUserLabel ??
      runtime.user_label ??
      runtime.userLabel ??
      '',
  ).trim().toLowerCase();
  return runtimeLabel !== 'goal_self_check';
}

function historyTurnSequence(message: ChatMessage) {
  const value = Number(
    message.turnSequence ??
      message.metadata?.turn_sequence ??
      message.metadata?.turnSequence,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function historyTurnLabel(
  group: WorkSummaryHistoryTurn | undefined,
  language: AppLanguage,
) {
  if (!group) return language === 'zh' ? '回合详情' : 'Turn details';
  return group.prompt || (language === 'zh' ? '未命名指令' : 'Untitled instruction');
}

export function historyTurnTimestamp(message: ChatMessage, language: AppLanguage) {
  const source = message.createdAt || String(
    message.metadata?.cardbush_turn_completed_at ??
      message.metadata?.turn_completed_at ??
      '',
  );
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}
