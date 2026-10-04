import { ChevronDown, LoaderCircle } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import type { AppLanguage, ChatToolExecution } from '../../types';
import { modelLogoFor } from '../composer/modelLogos';
import type { ThinkingNotice } from '../composer/thinkingNoticeProjection';
import { useLiveThinkingNotice } from '../composer/useLiveThinkingNotice';
import { activeToolStatusLabel } from '../tools/toolExecutionState';

export const AssistantThinkingScope = createContext({
  activeConversationId: '', activeTurnId: '', enabled: false, running: false,
});

export function AssistantThinkingProcessLine(props: {
  language: AppLanguage;
  model: string;
  execution?: ChatToolExecution;
}) {
  const scope = useContext(AssistantThinkingScope);
  // Reasoning updates only this tail slot, leaving the transcript and media intact.
  const notice = useLiveThinkingNotice(scope);
  return <AssistantThinkingDetail {...props} notice={notice} />;
}

export function AssistantThinkingDetail({ language, model, execution, notice, statusLabel }: {
  language: AppLanguage;
  model: string;
  execution?: ChatToolExecution;
  notice?: ThinkingNotice | null;
  statusLabel?: string;
}) {
  const logo = modelLogoFor(model);
  const thinking = execution ? null : notice;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = Boolean(thinking && expandedId === thinking.id);
  return (
    <details className="turn-thinking-detail" open={expanded}>
      <summary
        className="assistant-thinking-process"
        aria-expanded={expanded}
        aria-disabled={!thinking}
        onClick={event => {
          event.preventDefault();
          if (thinking) setExpandedId(expanded ? null : thinking.id);
        }}
      >
        {logo ? (
          <span className={`assistant-thinking-model model-${logo.id}`} title={logo.label} aria-hidden="true">
            <img src={logo.src} alt="" />
          </span>
        ) : (
          <span className="assistant-thinking-model fallback" aria-hidden="true">
            <LoaderCircle size={11} />
          </span>
        )}
        <span className="assistant-thinking-label">
          {statusLabel ?? (execution ? activeToolStatusLabel(execution, language) : language === 'zh' ? '思考中' : 'Thinking')}
        </span>
        {thinking && <>
          <small>{thinking.preview}</small>
          <ChevronDown size={12} className="assistant-thinking-chevron" aria-hidden="true" />
        </>}
      </summary>
      {thinking && expanded && <div className="turn-thinking-content">{thinking.content}</div>}
    </details>
  );
}
