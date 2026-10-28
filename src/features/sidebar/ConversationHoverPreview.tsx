import { uiText } from '../../i18n';
import { Cloud, Edit3, Monitor, PanelsTopLeft } from 'lucide-react';
import { HoverPreview, type useHoverPreview } from '../../components/HoverPreview';
import { basename } from '../../shared/localPaths';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import type { AppLanguage, ConversationSummary, SessionAttentionState } from '../../types';
import { sessionAttentionLabel } from '../sessionAttention';
import { conversationProjectDir } from '../conversationWorkspace';

export function ConversationHoverPreview({ preview, conversation, projectLabel, hostLabel, remote, language, attention, onRename }: {
  preview: ReturnType<typeof useHoverPreview>;
  conversation: ConversationSummary;
  projectLabel?: string;
  hostLabel?: string;
  remote: boolean;
  language: AppLanguage;
  attention?: SessionAttentionState;
  onRename: () => void;
}) {
  if (!preview.anchor) return null;
  const project = projectLabel || basename(conversationProjectDir(conversation)) || (uiText(language)('conversationHoverPreview.standaloneChat'));
  const updated = Date.parse(conversation.updatedAt);
  const age = relativeConversationAge(updated, language);
  const Device = remote ? Cloud : Monitor;
  const renameLabel = uiText(language)('chatSidebar.renameChat');
  return <HoverPreview preview={preview} className="conversation-hover-preview" interactiveLabel={uiText(language)('conversationHoverPreview.chatDetails')}>
    <div className="hover-preview-title">
      <button type="button" className="conversation-hover-preview-rename" title={renameLabel} aria-label={renameLabel}
        onClick={() => { preview.close(); onRename(); }}>
        <strong>{conversationDisplayTitle(conversation.title)}</strong>
        <Edit3 size={13} aria-hidden="true" />
      </button>
      <Device size={14} aria-label={hostLabel || ((remote ? uiText(language)('conversationHoverPreview.remote') : uiText(language)('workspace.local')))} />
      {age && <time dateTime={conversation.updatedAt}>{age}</time>}
    </div>
    <div className="conversation-hover-preview-project"><PanelsTopLeft size={14} aria-hidden="true" /><span>{project}</span></div>
    {attention && <p className="conversation-hover-preview-status">{sessionAttentionLabel(attention, language)}
      {attention.body && <> · {attention.body}</>}
    </p>}
  </HoverPreview>;
}

function relativeConversationAge(updated: number, language: AppLanguage) {
  if (!Number.isFinite(updated)) return '';
  const seconds = Math.max(0, (Date.now() - updated) / 1000);
  if (seconds < 60) return uiText(language)('conversationHoverPreview.justNow');
  const [amount, unit] = seconds < 3600 ? [seconds / 60, 'minute'] as const
    : seconds < 86400 ? [seconds / 3600, 'hour'] as const : [seconds / 86400, 'day'] as const;
  return new Intl.RelativeTimeFormat(language, { numeric: 'always' }).format(-Math.floor(amount), unit);
}
