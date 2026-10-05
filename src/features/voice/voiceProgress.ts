import type { ChatMessage, ChatToolExecution } from '../../types';
import { spokenText, visibleVoiceMessages } from './speechText';

const silentTools = new Set(['summary_for_user', 'check_habit', 'remember_source']);
function title(tool: ChatToolExecution, language: 'zh' | 'en') {
  const titles = tool.metadata?.displayTitles as Record<string, unknown> | undefined;
  const raw = titles?.[language] ?? tool.metadata?.displayTitle;
  // Display only the runtime's public title, never arguments or hidden reasoning.
  return typeof raw === 'string' ? spokenText(raw).slice(0, 160) : '';
}
export class VoiceProgress {
  update(messages: ChatMessage[], turnId: string | null | undefined, language: 'zh' | 'en') {
    let activity = '';
    for (const message of visibleVoiceMessages(messages)) for (const tool of message.toolExecutions ?? []) {
      if (!turnId || (tool.turnId ?? message.turnId) !== turnId || silentTools.has(tool.name) || tool.state === 'queued') continue;
      const text = title(tool, language); if (!text) continue;
      activity = text;
    }
    return { activity };
  }
}
// Ignore ambiguous whole utterances instead of spawning another Agent turn.
// Short useful commands such as “好”“停”“否” still go through immediately.
export function isAmbiguousVoiceFragment(text: string) {
  return /^(?:[嗯呃啊唔额]+|[a-z])$/i.test(text.replace(/[\s。，、！？.!?,]/g, ''));
}
