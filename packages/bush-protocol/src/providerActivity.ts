import type { ProviderStreamDiagnostic } from './model.js';

export type ProviderActivity = 'waiting' | 'thinking' | 'private_thinking' | 'responding' | 'preparing_tool';

/** Phase evidence only. No inference of socket health or hidden token counts. */
export function providerStreamActivity(event: ProviderStreamDiagnostic): ProviderActivity | undefined {
  if (event.aborted || event.messageStopReceived || ['closed', 'error', 'eof'].includes(event.stage)) return;
  if (event.activeBlockType === 'thinking' || event.activeBlockType === 'redacted_thinking') {
    return event.thinkingChars > 0 ? 'thinking' : 'private_thinking';
  }
  if (event.activeBlockType === 'tool_use') return 'preparing_tool';
  if (event.activeBlockType === 'text') return 'responding';
  return 'waiting';
}

export function providerActivityLabel(activity: ProviderActivity, language: 'zh' | 'en' = 'en'): string {
  const labels = {
    waiting: ['准备开始聊天', 'Preparing to chat'],
    thinking: ['模型思考中', 'Thinking'],
    private_thinking: ['等待模型思考结果', 'Thinking (no public output)'],
    responding: ['正在生成回复', 'Responding'],
    preparing_tool: ['正在准备工具调用', 'Preparing tool call'],
  };
  return labels[activity][language === 'zh' ? 0 : 1]!;
}
