import { ChevronDown, LoaderCircle } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { HoverPreview, useHoverPreview } from '../../components/HoverPreview';
import { basename } from '../../shared/localPaths';
import type { AppLanguage, ChatToolExecution } from '../../types';
import { modelLogoFor } from '../composer/modelLogos';
import type { ThinkingNotice } from '../composer/thinkingNoticeProjection';
import { useLiveThinkingNotice } from '../composer/useLiveThinkingNotice';
import { activeToolStatusLabel } from '../tools/toolExecutionState';
import type { ConversationChangeSummary } from '../tools/toolChangeReports';

export const AssistantThinkingScope = createContext<{
  activeConversationId: string; activeTurnId: string; enabled: boolean; running: boolean;
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
  return <AssistantThinkingDetail {...props} notice={notice} animate={scope.running} />;
}

export function TurnChangeSummary({ summary, language, onOpen }: {
  summary: ConversationChangeSummary; language: AppLanguage; onOpen?: (filePath: string) => void;
}) {
  const preview = useHoverPreview(summary.files.length === 0, { interactive: true });
  const focusRequested = useRef(false);
  useEffect(() => {
    if (preview.anchor && focusRequested.current) {
      focusRequested.current = false;
      document.getElementById(preview.id)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  }, [preview.anchor, preview.id]);
  const names = new Set<string>(), repeatedNames = new Set<string>();
  if (preview.anchor) for (const file of summary.files) {
    const name = basename(file.path);
    if (names.has(name)) repeatedNames.add(name);
    names.add(name);
  }
  return <><div {...preview.triggerProps} className="turn-change-review" role="group" tabIndex={summary.files.length ? 0 : undefined}
    aria-haspopup={summary.files.length ? 'dialog' : undefined} aria-describedby={undefined} aria-controls={preview.anchor ? preview.id : undefined}
    aria-keyshortcuts="ArrowUp ArrowDown"
    onKeyDown={event => {
      if (!summary.files.length || !['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const first = document.getElementById(preview.id)?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (first) first.focus();
      else { focusRequested.current = true; preview.open(event.currentTarget); }
    }}
    aria-label={language === 'zh'
      ? `本轮 ${summary.fileCount} 个文件改动，新增 ${summary.additions} 行，删除 ${summary.deletions} 行`
      : `${summary.fileCount} changed files, ${summary.additions} additions, ${summary.deletions} deletions`}>
    <span>file {summary.fileCount}</span><span className="turn-change-separator" aria-hidden="true">|</span>
    <b className="diff-count add">+{summary.additions}</b><b className="diff-count del">-{summary.deletions}</b>
  </div>
    <HoverPreview preview={preview} placement="top" className="turn-change-preview" interactiveLabel={language === 'zh' ? '本轮文件改动' : 'Changed files this turn'}>
      {preview.anchor && <ul className="turn-change-files">
        {summary.files.map(file => <li key={file.path}><button type="button" className="turn-change-file-action" disabled={!onOpen}
          aria-label={language === 'zh' ? `查看 ${file.path} 的改动` : `Review changes to ${file.path}`}
          onClick={() => { preview.dismiss(); onOpen?.(file.path); }}>
          <span className="turn-change-file-name">
            <span>{basename(file.path)}</span>
            {repeatedNames.has(basename(file.path)) && <small>{file.path}</small>}
          </span>
          <span className="turn-change-file-counts">
            <b className="diff-count add">+{file.additions}</b><b className="diff-count del">-{file.deletions}</b>
          </span>
        </button></li>)}
      </ul>}
    </HoverPreview>
  </>;
}

export function AssistantThinkingDetail({ language, model, execution, notice, statusLabel, animate = true }: {
  language: AppLanguage;
  model: string;
  execution?: ChatToolExecution;
  notice?: ThinkingNotice | null;
  statusLabel?: string;
  animate?: boolean;
}) {
  const logo = modelLogoFor(model);
  const thinking = execution ? null : notice;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = Boolean(thinking && expandedId === thinking.id);
  return (
    <div className="assistant-activity-line">
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
    </div>
  );
}
