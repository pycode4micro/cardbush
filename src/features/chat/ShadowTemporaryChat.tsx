import { uiText } from '../../i18n';
import { X } from 'lucide-react';
import type { CSSProperties } from 'react';

import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import type { AppLanguage } from '../../types';

export type ShadowChatEntry = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export function ShadowTemporaryChat({
  language,
  agentName,
  entries,
  busy,
  error,
  open,
  accentColor,
  onClose,
}: {
  language: AppLanguage;
  agentName: string;
  entries: ShadowChatEntry[];
  busy: boolean;
  error?: string;
  open: boolean;
  accentColor: string;
  onClose: () => void;
}) {
  const style = { '--shadow-accent': accentColor } as CSSProperties;

  if (!open) return null;

  return (
    <section className="shadow-temporary-chat" style={style} aria-label={uiText(language)('shadowTemporaryChat.shadow_temporary_chat')}>
      <header>
        <span className="shadow-chat-title">
          <ShadowCloneIcon size={14} />
          <strong>{agentName}</strong>
          <small>{uiText(language)('shadowTemporaryChat.sharedContextReadOnly')}</small>
        </span>
        <button type="button" title={uiText(language)('shadowTemporaryChat.collapse')} onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="shadow-chat-transcript" aria-busy={busy}>
        {entries.map((entry) => (
          <p
            className={entry.role === 'user' ? 'shadow-chat-reply' : 'shadow-chat-inbound'}
            key={entry.id}
          >
            {entry.content}
          </p>
        ))}
        {busy && <span className="shadow-chat-activity" aria-label={uiText(language)('shadowTemporaryChat.responding')} />}
        {error && <p className="shadow-chat-error">{error}</p>}
      </div>
    </section>
  );
}
