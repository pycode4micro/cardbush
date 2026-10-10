export const imagePath = '/data/workspaces/generated/grey-knit.png';
export const createdAt = '2026-10-10T06:00:00.000Z';
export const completedAt = '2026-10-10T06:00:35.000Z';
export const sessions = ['a','b'].map((id, index) => ({ id: 'web-' + id.repeat(40), title: index ? '流式回复验收' : '灰色针织衫 · 渲染验收', pinned: false, archived: false, created_at: createdAt, updated_at: completedAt }));
export const job = { id: 'fixture-job', turnId: 'fixture-turn', text: '帮我生成一张灰色的', status: 'completed', modelId: 'fixture', createdAt, completedAt };
const call = (id, name) => ({ id, name, arguments: {} });
const result = (path) => JSON.stringify({ content: [{ type: 'text', text: '图片已生成' }], structuredContent: { artifacts: [{ type: 'image', path, name: '灰色针织衫', mimeType: 'image/png' }] } });
export function fixtureTurn(status = 'completed') {
  const row = (id, role, content, extra = {}, metadata) => ({ messageId: id, turnId: job.turnId, createdAt, message: { role, content, ...extra }, metadata });
  return { turnId: job.turnId, turnSequence: 0, createdAt, completedAt, status, reason: status,
    messages: [
      row('user-1', 'user', job.text),
      row('assistant-1', 'assistant', '我基于同款针织开衫版型，生成灰色混纺版本，保持版型、肌理和风格一致。', { toolCalls: [call('tool-1','mcp__plugin_volcengine_images_images__seedream_create_task')] }),
      row('result-1', 'tool', JSON.stringify({ task_id: 'fixture-image', status: 'queued' }), { toolCallId: 'tool-1' }),
      row('assistant-2', 'assistant', '图片还在生成中，我再等待片刻。', { toolCalls: [call('tool-2','mcp__plugin_volcengine_images_images__generation_wait_tasks')] }),
      row('result-2', 'tool', result(imagePath), { toolCallId: 'tool-2' }),
      row('assistant-3', 'assistant', `已经为您生成同版型灰色混纺针织开衫：\n\n![灰色针织衫](${imagePath})`),
    ] };
}
export function fixtureState(session = sessions[0]) { return { conversation: session, jobs: [job], solutions: [], snapshot: { turns: [fixtureTurn()], supersededMessageIds: [] } }; }
export function fixtureRecords(sessionId = sessions[0].id, summary = false) {
  const turn = fixtureTurn();
  return turn.messages.flatMap((message, index) => (message.message.toolCalls ?? []).map(call => {
    const response = turn.messages.find(item => item.message.toolCallId === call.id);
    return { protocol: summary ? 'bush.tool_execution_summary.v1' : 'bush.tool.execution_record.v2',
      requestId: 'fixture-request', sessionId, turnId: job.turnId, round: index + 1, ordinal: index, recordedAt: completedAt,
      toolCall: { ...call, protocol: 'bush.tool_call.v1', argumentsText: '{}' }, outcome: 'returned', workspaceChanges: [],
      ...(summary ? { resultAvailable: true } : { result: JSON.parse(response.message.content) }),
    };
  }));
}
export function conversationFixtureState(session = sessions[0]) {
  const state = fixtureState(session);
  state.snapshot.turns[0].messages = state.snapshot.turns[0].messages.filter(item => item.message.role !== 'tool');
  return { ...state, toolExecutions: fixtureRecords(session.id, true) };
}
export const initialEvents = [
  { kind: 'assistant_segment_started', payload: { messageId:'assistant-1',segmentId:'segment-1',ordinal:0 } },
  { kind: 'assistant_segment_delta', payload: { messageId:'assistant-1',segmentId:'segment-1',ordinal:0,delta:'我基于同款针织开衫版型，生成灰色混纺版本，保持版型、肌理和风格一致。' } },
  { kind: 'assistant_segment_completed', payload: { messageId:'assistant-1',segmentId:'segment-1',ordinal:0,content:'我基于同款针织开衫版型，生成灰色混纺版本，保持版型、肌理和风格一致。' } },
  { kind:'tool_running',payload:{toolCallId:'tool-1',toolName:'mcp__plugin_volcengine_images_images__seedream_create_task',assistantMessageId:'assistant-1',ordinal:0,display:{title:'生成灰色针织衫图片'}} },
];
export const finalEvents = [
  { kind:'tool_returned',payload:{toolCallId:'tool-1',toolName:'mcp__plugin_volcengine_images_images__seedream_create_task',assistantMessageId:'assistant-1',ordinal:0,display:{title:'生成灰色针织衫图片'}} },
  { kind:'assistant_segment_started',payload:{messageId:'assistant-2',segmentId:'segment-2',ordinal:1} },
  { kind:'assistant_segment_completed',payload:{messageId:'assistant-2',segmentId:'segment-2',ordinal:1,content:'图片还在生成中，我再等待片刻。'} },
  { kind:'tool_returned',payload:{toolCallId:'tool-2',toolName:'mcp__plugin_volcengine_images_images__generation_wait_tasks',assistantMessageId:'assistant-2',ordinal:1} },
  { kind:'assistant_segment_started',payload:{messageId:'assistant-3',segmentId:'segment-3',ordinal:2,finalResponse:true} },
  { kind:'assistant_segment_completed',payload:{messageId:'assistant-3',segmentId:'segment-3',ordinal:2,finalResponse:true,content:fixtureTurn().messages.at(-1).message.content} },
];
