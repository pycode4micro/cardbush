import { uiText } from '@cardbush/platform/i18n';
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

export function providerActivityLabel(activity: ProviderActivity, language: string = 'en'): string {
  const labels = {
    waiting: 'providerActivity.preparing_to_chat' as const,
    thinking: 'providerActivity.thinking' as const,
    private_thinking: 'providerActivity.thinking_no_public_output' as const,
    responding: 'providerActivity.responding' as const,
    preparing_tool: 'providerActivity.preparing_tool_call' as const,
  };
  return uiText(language)(labels[activity]);
}
