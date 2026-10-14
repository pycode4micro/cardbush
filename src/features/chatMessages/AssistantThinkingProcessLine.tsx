import { ChevronDown, LoaderCircle } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { AppLanguage, ChatToolExecution } from '../../types';
import { modelLogoFor } from '../composer/modelLogos';
import type { ThinkingNotice } from '../composer/thinkingNoticeProjection';
import { useLiveThinkingNotice } from '../composer/useLiveThinkingNotice';
import { activeToolStatusLabel } from '../tools/toolExecutionState';
import type { ConversationChangeSummary } from '../tools/toolChangeReports';

export const AssistantThinkingScope = createContext<{
  activeConversationId: string; activeTurnId: string; enabled: boolean; running: boolean;
  changeSummary?: ConversationChangeSummary | null; onOpenChangeReview?: () => void;
}>({
  activeConversationId: '', activeTurnId: '', enabled: false, running: false,
});

export function AssistantThinkingProcessLine(props: {
  language: AppLanguage;
  model: string;
  execution?: ChatToolExecution;
  statusLabel?: string;
}) {
  const scope = useContext(AssistantThinkingScope);
  // Reasoning updates only this tail slot, leaving the transcript and media intact.
  const notice = useLiveThinkingNotice(scope);
  const changes = scope.changeSummary;
  return <AssistantThinkingDetail {...props} notice={notice} animate={scope.running}
    accessory={changes && <TurnChangeReviewButton summary={changes} language={props.language} onOpen={scope.onOpenChangeReview} />} />;
}

export function TurnChangeReviewButton({ summary, language, onOpen }: {
  summary: ConversationChangeSummary; language: AppLanguage; onOpen?: () => void;
}) {
  return <button className="turn-change-review" type="button" onClick={() => onOpen?.()}
    aria-label={language === 'zh'
      ? `查看本轮 ${summary.fileCount} 个文件改动，新增 ${summary.additions} 行，删除 ${summary.deletions} 行`
      : `Review ${summary.fileCount} changed files, ${summary.additions} additions, ${summary.deletions} deletions`}>
    <span>file {summary.fileCount}</span><span className="turn-change-separator" aria-hidden="true">|</span>
    <b className="diff-count add">+{summary.additions}</b><b className="diff-count del">-{summary.deletions}</b>
  </button>;
}

export function AssistantThinkingDetail({ language, model, execution, notice, statusLabel, animate = true, accessory }: {
  language: AppLanguage;
  model: string;
  execution?: ChatToolExecution;
  notice?: ThinkingNotice | null;
  statusLabel?: string;
  animate?: boolean;
  accessory?: ReactNode;
}) {
  const logo = modelLogoFor(model);
  const thinking = execution ? null : notice;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = Boolean(thinking && expandedId === thinking.id);
  return (
    <div className={`assistant-activity-line${accessory ? ' has-accessory' : ''}`}>
    <details className="turn-thinking-detail" open={expanded}>
      <summary
        className={`assistant-thinking-process${animate ? ' running-mask' : ''}`}
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
    {accessory}
    </div>
  );
}
