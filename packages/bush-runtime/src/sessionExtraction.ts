import type { SessionSnapshot, ConversationExtractSource, ConversationExtractUnit, SessionMessage } from '@cardbush/bush-protocol';
const legacyInternalNames = new Set(['runtime_context', 'tool_image_observation', 'task_plan_continuation', 'empty_stop_recovery', 'subagent_result']);

function userText(item: SessionMessage): string {
  const text = typeof item.metadata?.composerReferenceContent === 'string' ? item.metadata.composerReferenceContent : item.message.content;
  const attachments = Array.isArray(item.metadata?.attachments) ? item.metadata.attachments : [];
  return [text, ...attachments.flatMap(item => item && typeof item === 'object' && typeof item.path === 'string'
    ? [`附件：${item.path}`] : [])].filter(Boolean).join('\n\n');
}

/** Read the canonical checkpoint receipts; never use hidden model reasoning. */
export function extractSessionSource(session: SessionSnapshot, keys?: string[]): ConversationExtractSource {
  const superseded = new Set(session.supersededMessageIds);
  const summaries = new Map<string, string>();
  const completeSummaries = new Set<string>();
  const activeBoundaries = new Map<string, string>();
  for (const turn of session.turns) {
    if (turn.messages.some(item => superseded.has(item.messageId))) continue;
    if (turn.contextSummary) { summaries.set(turn.turnId, turn.contextSummary); completeSummaries.add(turn.turnId); }
    const checkpoint = turn.contextCheckpoint;
    if (!checkpoint) continue;
    activeBoundaries.set(turn.turnId, checkpoint.throughMessageId);
    if (checkpoint.projectionVersion !== 'exchange_v1') {
      if (!turn.contextSummary) summaries.set(turn.turnId, checkpoint.summary);
      continue;
    }
    const receipt = turn.messages.find(item => item.messageId === checkpoint.exchangeMessageIds[1]);
    if (receipt?.message.role !== 'tool') continue;
    try {
      const result = JSON.parse(receipt.message.content);
      // Incremental checkpoints include the accepted per-source summaries.
      for (const entry of Array.isArray(result.summaries) ? result.summaries : []) {
        if (typeof entry?.turn_id === 'string' && typeof entry.summary === 'string') {
          summaries.set(entry.turn_id, entry.summary);
          if (entry.turn_id !== turn.turnId) completeSummaries.add(entry.turn_id);
        }
      }
      const caller = turn.messages.find(item => item.messageId === checkpoint.exchangeMessageIds[0]);
      if (caller?.message.role !== 'assistant') continue;
      const call = caller.message.toolCalls.find(call => call.name === 'checkpoint_context');
      if (!call) continue;
      const args = JSON.parse(call.argumentsText);
      const ids: string[] = Array.isArray(result.summarized_turns) ? result.summarized_turns : [];
      const entries = Array.isArray(args.summaries) ? args.summaries : [];
      entries.forEach((entry: unknown, index: number) => {
        if (typeof entry === 'string' && ids[index]) { summaries.set(ids[index]!, entry); completeSummaries.add(ids[index]!); }
        else if (entry && typeof entry === 'object' && 'turn_id' in entry && 'summary' in entry &&
          typeof entry.turn_id === 'string' && typeof entry.summary === 'string') { summaries.set(entry.turn_id, entry.summary); completeSummaries.add(entry.turn_id); }
      });
      const active = typeof args.active_summary === 'string' ? args.active_summary : args.active_turn?.summary ??
        (entries.length > ids.length ? entries.at(-1) : undefined);
      if (typeof active === 'string' && active.trim() && !turn.contextSummary) summaries.set(turn.turnId, active);
    } catch { /* An unknown legacy receipt cannot stand in for a verified summary. */ }
  }
  const units: ConversationExtractUnit[] = [];
  for (const turn of session.turns) {
    const messages = turn.messages.filter(item => !superseded.has(item.messageId));
    for (const item of messages) {
      if (item.message.role !== 'user' || item.message.visibility === 'internal' || legacyInternalNames.has(item.message.name ?? '')) continue;
      const text = userText(item).trim();
      if (text) units.push({ key: `user:${item.messageId}`, turnId: turn.turnId, role: 'user',
        messageIds: [item.messageId], createdAt: item.createdAt, text, summarized: false });
    }
    const assistant = messages.filter(item => item.message.role === 'assistant' && !item.metadata?.runtimeMaintenance);
    const intact = messages.length === turn.messages.length;
    const summary = intact ? summaries.get(turn.turnId) : undefined;
    const boundary = summary && !completeSummaries.has(turn.turnId) ? messages.findIndex(item => item.messageId === activeBoundaries.get(turn.turnId)) : -1;
    // A checkpoint only covers its boundary. Include subsequent visible replies,
    // while a completed-turn summary takes precedence over even a final answer.
    const tail = summary ? (boundary >= 0 ? messages.slice(boundary + 1).filter(item =>
      item.message.role === 'assistant' && !item.metadata?.runtimeMaintenance) : []) : assistant;
    const text = [summary, ...tail.map(item => item.message.content.trim()).filter(Boolean)].filter(Boolean).join('\n\n');
    if (text) units.push({ key: `assistant:${turn.turnId}`, turnId: turn.turnId, role: 'assistant',
      messageIds: assistant.map(item => item.messageId), createdAt: turn.completedAt, text, summarized: Boolean(summary) });
  }
  const recent = new Set([...new Set(units.map(unit => unit.turnId))].slice(-5));
  const selected = keys ? new Set(keys) : undefined;
  if (selected && [...selected].some(key => !units.some(unit => unit.key === key))) throw new Error('提取来源已变更或不存在，请重新选择。');
  return { sessionId: session.sessionId, revision: session.revision, title: String(session.metadata?.title ?? '会话提取'),
    defaultKeys: units.filter(unit => recent.has(unit.turnId)).map(unit => unit.key),
    units: selected ? units.filter(unit => selected.has(unit.key)) : units };
}
