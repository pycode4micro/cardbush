import assert from 'node:assert/strict';

export function testLoopTranscript(api) {
  const turnId = 'loop-turn';
  const fallback = 'optimistic';
  const tool = (id, assistantMessageId, overrides = {}) => ({
    id, assistantMessageId, turnId, name: 'terminal_exec', state: 'running',
    summary: 'Read fixture', output: '', metadata: {}, durationMs: 0,
    success: false, contentOffset: 0, createdAt: '2026-09-08T00:00:00Z', ...overrides,
  });
  const identity = message => message.assistantMessageId ?? message.messageId ?? message.id;
  const flatten = messages => messages.flatMap(message => [...(message.loopHistory ?? []), message]);
  let state = { s: [{ id: fallback, role: 'assistant', content: '', turnId }] };
  state = api.appendToolExecution(state, 's', fallback, tool('first-tool', 'msg_first'));
  assert.equal(identity(state.s[0]), 'msg_first', 'A tool-only first round binds the optimistic placeholder');
  state = api.appendToolExecution(state, 's', fallback, tool('next-tool', 'msg_next'));
  assert.equal(state.s.length, 2, 'A tool-only next round owns a new assistant message');
  assert.equal(identity(state.s[1]), 'msg_next');
  state = api.appendAssistantDelta(state, 's', fallback, '同一轮补充说明', { messageId: 'msg_next', turnId });
  assert.equal(state.s[1].content, '同一轮补充说明');
  assert.equal(state.s[1].toolExecutions[0].contentOffset, 0, 'Text arriving after a tool cannot move that tool');
  state = api.appendAssistantDelta(state, 's', fallback, '结论', { messageId: 'msg_final', turnId });
  state.s = api.normalizeActiveTurnTranscriptForDisplay(api.normalizeChatMessagesForDisplay(state.s), turnId);
  assert.equal(state.s.length, 1);
  state = api.appendToolExecution(state, 's', fallback, tool('first-tool', 'msg_first', {
    state: 'completed', success: true, output: 'enriched result',
  }));
  const historical = flatten(state.s).filter(message => message.toolExecutions?.some(execution => execution.id === 'first-tool'));
  assert.equal(historical.length, 1, 'Late enrichment updates the original history entry without duplicating it');
  assert.equal(historical[0].toolExecutions[0].output, 'enriched result');
  assert.equal(state.s[0].content, '结论');
  state = api.appendToolExecution(state, 's', fallback, tool('first-tool', undefined, { state: 'completed', output: 'identity-free enrichment' }));
  assert.equal(flatten(state.s)[0].toolExecutions[0].output, 'identity-free enrichment', 'A tool ID locates its owner even when enrichment omits the route');

  // No text-based deduplication between distinct runtime messages, even when
  // a model repeats exactly the same narration in several rounds.
  const repeated = ['msg_repeat_1', 'msg_repeat_2'].map(id => ({ id, messageId: id, role: 'assistant', status: 'streaming', turnId, content: '继续检查' }));
  assert.equal(api.normalizeChatMessagesForDisplay(repeated).length, 2);

  const older = { id: 'msg_history', messageId: 'msg_history', role: 'assistant', turnId, content: '过程',
    toolExecutions: [tool('history-tool', 'msg_history')] };
  const newer = { ...older, toolExecutions: [tool('history-tool', 'msg_history', { state: 'completed', success: true, output: 'result' })] };
  const history = api.mergeLoopHistoryMessages([older], [newer]);
  assert.equal(history.length, 1, 'Tool state changes must not create another history child with the same React key');
  assert.equal(history[0].toolExecutions[0].state, 'completed');
  assert.equal(older.toolExecutions[0].state, 'running', 'History merge is immutable');
  const legacyVersion = api.localLoopHistorySnapshot(newer);
  assert.equal(api.mergeLoopHistoryMessages([newer], [legacyVersion]).length, 2, 'Explicit local revisions keep separate identities');

  const partial = { id: 'msg_partial', messageId: 'msg_partial', role: 'assistant', turnId, content: '已读', toolExecutions: [tool('partial-tool', 'msg_partial')] };
  const completed = { ...partial, content: '已读取完整内容。' };
  const reconciled = api.mergeMessages({ s: [partial] }, 's', [completed]);
  const projected = api.normalizeActiveTurnTranscriptForDisplay(api.normalizeChatMessagesForDisplay(reconciled.s), turnId);
  assert.equal(flatten(projected).length, 1, 'A newer snapshot of the same runtime message replaces its partial text');
  assert.equal(projected[0].content, completed.content);
  assert.equal(projected[0].toolExecutions.length, 1);

  // Legacy loop indexes are only meaningful inside their own turn.
  const legacy = { s: [
    { id: 'old-turn', role: 'assistant', turnId: 'previous', content: '旧轮', loopIndex: 1 },
    { id: fallback, role: 'assistant', turnId, content: '当前轮', loopIndex: 1 },
  ] };
  const routed = api.appendToolExecution(legacy, 's', fallback, tool('legacy-tool', undefined, { loopIndex: 1 }));
  assert.equal(routed.s[0].toolExecutions, undefined);
  assert.equal(routed.s[1].toolExecutions[0].id, 'legacy-tool');

  // UI reveal/enrichment callbacks can settle out of order. Millisecond wall
  // clocks may be equal; the runtime event sequence supplies the stable order.
  const createdAt = '2026-09-08T00:00:00Z';
  let reordered = { s: [{ id: fallback, role: 'assistant', content: '', turnId }] };
  reordered = api.appendAssistantDelta(reordered, 's', fallback, '第一段', { messageId: 'msg_order_first', turnId, createdAt, sequence: 10 });
  reordered = api.appendAssistantDelta(reordered, 's', fallback, '最后一段', { messageId: 'msg_order_last', turnId, createdAt, sequence: 30 });
  reordered = api.appendToolExecution(reordered, 's', fallback, tool('ordered-tool', 'msg_order_middle', { createdAt, sequence: 20 }));
  const ordered = api.normalizeActiveTurnTranscriptForDisplay(api.normalizeChatMessagesForDisplay(reordered.s), turnId);
  assert.deepEqual(JSON.parse(JSON.stringify(flatten(ordered).map(identity))), ['msg_order_first', 'msg_order_middle', 'msg_order_last']);
  assert.ok(api.compareTranscriptOrder(
    { id: 'old', role: 'assistant', turnId: 'older', sequence: 500, createdAt },
    { id: 'new', role: 'assistant', turnId: 'newer', sequence: 1, createdAt: '2026-09-08T00:01:00Z' },
  ) < 0, 'Runtime event sequences restart in each Turn');
}
