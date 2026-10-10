import { Cloud, Folder, Monitor } from 'lucide-react';
import { HoverPreview, type useHoverPreview } from '../../components/HoverPreview';
import { basename } from '../../shared/localPaths';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import type { AppLanguage, ConversationSummary } from '../../types';
import { conversationProjectDir } from '../conversationWorkspace';

export function ConversationHoverPreview({ preview, conversation, projectLabel, hostLabel, remote, language }: {
  preview: ReturnType<typeof useHoverPreview>;
  conversation: ConversationSummary;
  projectLabel?: string;
  hostLabel?: string;
  remote: boolean;
  language: AppLanguage;
}) {
  if (!preview.anchor) return null;
  const project = projectLabel || basename(conversationProjectDir(conversation)) || (language === 'zh' ? '独立会话' : 'Standalone chat');
  const updated = Date.parse(conversation.updatedAt);
  const age = relativeConversationAge(updated, language);
  const Device = remote ? Cloud : Monitor;
  return <HoverPreview preview={preview} className="conversation-hover-preview">
    <div className="hover-preview-title">
      <strong>{conversationDisplayTitle(conversation.title)}</strong>
      <Device size={14} aria-label={hostLabel || (language === 'zh' ? (remote ? '远程' : '本地') : (remote ? 'Remote' : 'Local'))} />
      {age && <time dateTime={conversation.updatedAt}>{age}</time>}
    </div>
    <div className="conversation-hover-preview-project"><Folder size={14} aria-hidden="true" /><span>{project}</span></div>
  </HoverPreview>;
}

function relativeConversationAge(updated: number, language: AppLanguage) {
  if (!Number.isFinite(updated)) return '';
  const seconds = Math.max(0, (Date.now() - updated) / 1000);
  if (seconds < 60) return language === 'zh' ? '刚刚' : 'Just now';
  const [amount, unit] = seconds < 3600 ? [seconds / 60, 'minute'] as const
    : seconds < 86400 ? [seconds / 3600, 'hour'] as const : [seconds / 86400, 'day'] as const;
  return new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { numeric: 'always' }).format(-Math.floor(amount), unit);
}
