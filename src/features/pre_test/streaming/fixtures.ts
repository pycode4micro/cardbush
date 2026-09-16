import type { ChatMessage, ChatToolExecution } from '../../../types';
import type { AssistantStreamRoute } from '../../chatMessages/transcript/assistantStreamBuffer';
import { replaySession, replayTurn, type ReplayEvent } from './streamingReplay';

export type Scenario = 'complete' | 'guidance' | 'stop' | 'failed' | 'long';
export const scenarios: Record<Scenario, string> = {
  complete: '正常完成与最终快照', guidance: '引导 / 子任务 / 查看图像',
  stop: 'Stop 保留已收到的文字', failed: '失败收尾', long: '长 Markdown 与滚动跟随',
};
const at = new Date().toISOString();
export const labRoute = (id: string, sequence = 1): AssistantStreamRoute => ({
  messageId: id, turnId: replayTurn, segmentId: `${id}-text`, segmentOrdinal: 0,
  sequence, createdAt: at,
});
const message = (id: string, content: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({
  id, messageId: id, role, content, turnId: replayTurn, conversationId: replaySession,
  createdAt: at, status: role === 'user' ? 'sent' : 'streaming',
});
export const labTool = (name: string, owner = 'lab-first', state: ChatToolExecution['state'] = 'completed'): ChatToolExecution => ({
  id: `tool-${name}`, name, assistantMessageId: owner, turnId: replayTurn, state,
  summary: name === 'subagent' ? '检查边界兼容性' : name === 'view_image' ? '查看图像' : '读取测试文件',
  output: state === 'running' ? '' : '执行完成', success: state === 'completed', durationMs: 100,
  contentOffset: 0, createdAt: at, sequence: 100,
  metadata: name === 'apply_patch' ? { kind: 'file_change', files: [{
    path: 'streaming-demo.ts', diff: '@@ -1 +1 @@\n-old\n+new', lines: ['-old', '+new'],
  }] } : {},
});

export function streamingFixture(scenario: Scenario) {
  const user = message('lab-user', '检查流式显示、工具状态与收尾是否兼容。', 'user');
  const history = scenario === 'long' ? Array.from({ length: 18 }, (_, index) => ({
    ...message(`history-${index}`, `历史消息 ${index + 1}\n\n${'这段内容用于验证阅读位置保持。'.repeat(12)}`, index % 2 ? 'assistant' : 'user'),
    turnId: `history-turn-${index}`, status: 'completed',
  })) : [];
  const initial = [...history, user, message('lab-first', '')];
  const events: Array<{ at: number; event: ReplayEvent }> = [];
  let time = 0;
  let sequence = 1;
  const add = (event: ReplayEvent, delay = 80) => { events.push({ at: time, event }); time += delay; };
  const text = (content: string, route: AssistantStreamRoute, complete = true) => {
    const chars = Array.from(content);
    for (let index = 0; index < chars.length; index += 18) {
      add({ kind: 'delta', content: chars.slice(index, index + 18).join(''), route: { ...route, eventId: `delta-${sequence++}` } }, 45);
    }
    if (complete) add({ kind: 'segment', content, route });
  };
  const preamble = '流式探针：我先检查现有的显示规则。文字应该持续出现，工具开始后能及时看到状态，引导只改变后续执行方向。\n\n这段是过程说明，随后会出现工具执行预览。';
  text(preamble, labRoute('lab-first'));
  const edit = labTool('apply_patch');
  add({ kind: 'tool', execution: { ...edit, state: 'running', success: false } }, 120);
  add({ kind: 'tool', execution: edit });
  const first = { ...message('lab-first', preamble), sequence: 1, toolExecutions: [edit],
    metadata: { transcript_kind: 'assistant_segment', segment_complete: true } };
  const canonical: ChatMessage[] = [...history, user, first];
  if (scenario === 'guidance') {
    const guidance = { ...message('lab-guidance', '先验证边界，不要提前收尾。', 'user'), sequence: 110,
      metadata: { turn_guidance: true, guidance_delivery: 'sent', name: 'turn_guidance' } };
    add({ kind: 'guidance', message: guidance, update: {
      ...labRoute('lab-next', 111), kind: 'loop_transition', reason: 'turn_guidance_applied',
      guidanceMessageId: guidance.id, previousAssistantMessageId: 'lab-first',
      previousAssistantSegmentIndex: 1, nextAssistantSegmentIndex: 2,
    } });
    canonical[canonical.length - 1] = { ...first, status: 'completed',
      metadata: { ...first.metadata, segment_boundary: 'turn_guidance' } };
    canonical.push(guidance);
    for (const name of ['subagent', 'view_image']) add({ kind: 'tool', execution: labTool(name, 'lab-next') });
  }
  const owner = scenario === 'guidance' ? 'lab-next' : 'lab-final';
  const finalText = scenario === 'long'
    ? '# 流式 Markdown 检查\n\n' + Array.from({ length: 30 }, (_, index) =>
      `## 指标 ${index + 1}\n\n这段检查增量更新时的阅读位置。**粗体**、[本地文件](./streaming-demo.ts)、中文与 emoji 🧪。\n\n| 项目 | 结果 |\n|---|---|\n| 增量 | 保留 |\n\n\`\`\`ts\nconst value = ${index};\n\`\`\`\n\n`).join('')
    : '检查结果：\n\n- 引导不会触发改动总结。\n- 工具预览保持独立。\n- 最终快照不会重复文字。\n\n**边界验证完成。** 🧪';
  text(finalText, labRoute(owner, 120), scenario !== 'stop' && scenario !== 'failed');
  const status = scenario === 'stop' ? 'stopped' : scenario === 'failed' ? 'failed' : 'completed';
  canonical.push({ ...message(owner, finalText), sequence: 120, status,
    toolExecutions: scenario === 'guidance' ? ['subagent', 'view_image'].map(name => labTool(name, owner)) : undefined,
    metadata: { transcript_kind: 'assistant_final' } });
  add({ kind: 'terminal', terminal: { turnId: replayTurn, status, stopped: status === 'stopped',
    stopReason: status === 'stopped' ? 'user_stop' : status === 'failed' ? 'provider_stream_exception' : '',
    stopScenario: '', completedAt: new Date(Date.parse(at) + time).toISOString(), raw: {},
  } });
  // Re-delivery of the canonical snapshot exercises idempotent final merging.
  const finalMessages = canonical.map(item => item.role === 'assistant' ? { ...item, status } : item);
  add({ kind: 'snapshot', messages: finalMessages });
  add({ kind: 'snapshot', messages: finalMessages });
  return { initial, events, finalText, duration: time };
}
