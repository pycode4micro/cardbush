import type { ChatMessage, ChatToolExecution } from '../../types';
import { spokenText, visibleVoiceMessages } from './speechText';

const silentTools = new Set(['summary_for_user', 'check_habit', 'remember_source']);
function title(tool: ChatToolExecution, language: 'zh' | 'en') {
  const titles = tool.metadata?.displayTitles as Record<string, unknown> | undefined;
  const raw = titles?.[language] ?? tool.metadata?.displayTitle;
  // Only the runtime's public reason/display text; never speak tool arguments,
  // outputs, hidden reasoning or a synthetic interpretation of them.
  return typeof raw === 'string' ? spokenText(raw).slice(0, 160) : '';
}
export class VoiceProgress {
  private seen = new Set<string>();
  private lastAnnouncement = -Infinity;
  reset(messages: ChatMessage[]) { this.seen.clear(); this.lastAnnouncement = -Infinity; this.skip(messages); }
  skip(messages: ChatMessage[]) {
    for (const message of visibleVoiceMessages(messages)) for (const tool of message.toolExecutions ?? []) this.seen.add(`${tool.turnId ?? message.turnId}:${tool.id}`);
  }
  update(messages: ChatMessage[], turnId: string | null | undefined, language: 'zh' | 'en', now = Date.now()) {
    let activity = '', announcement = '';
    for (const message of visibleVoiceMessages(messages)) for (const tool of message.toolExecutions ?? []) {
      if (!turnId || (tool.turnId ?? message.turnId) !== turnId || silentTools.has(tool.name) || tool.state === 'queued') continue;
      const text = title(tool, language); if (!text) continue;
      activity = text;
      const key = `${turnId}:${tool.id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (tool.state !== 'failed' && tool.state !== 'cancelled') announcement = text;
    }
    if (now - this.lastAnnouncement < 6000) announcement = '';
    if (announcement) this.lastAnnouncement = now;
    return { activity, announcement };
  }
}
// Ambiguous fragments are reviewable instead of spawning another Agent turn.
// Short useful commands such as “好”“停”“否” still go through immediately.
export function needsVoiceReview(text: string) {
  return /^(?:[嗯呃啊唔额]+|[a-z])$/i.test(text.replace(/[\s。，、！？.!?,]/g, ''));
}
