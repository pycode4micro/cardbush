import { NotebookText, PanelRightOpen } from 'lucide-react';
import type { AppLanguage } from '../types';
import type { HTMLAttributes, ReactNode } from 'react';
import { conversationDisplayTitle } from '../shared/conversationTitle';

export function TopBar({
  title,
  language,
  conversationContentAvailable = false,
  workSummaryVisible,
  inspectorOpen,
  onToggleWorkSummary,
  workSummaryHoverProps,
  onToggleInspector,
  workspaceControl,
  titleIcon,
}: {
  title: string;
  language: AppLanguage;
  conversationContentAvailable?: boolean;
  workSummaryVisible?: boolean;
  inspectorOpen: boolean;
  onToggleWorkSummary?: (anchor: HTMLElement) => void;
  workSummaryHoverProps?: HTMLAttributes<HTMLButtonElement>;
  onToggleInspector?: () => void;
  workspaceControl?: ReactNode;
  titleIcon?: ReactNode;
}) {
  const displayTitle = conversationDisplayTitle(title);
  return (
    <div className="topbar">
      {titleIcon}
      <h1 title={displayTitle}>{displayTitle}</h1>
      {workspaceControl}
      {conversationContentAvailable && onToggleWorkSummary && (
        <button
          {...workSummaryHoverProps}
          className={`topbar-inspector-action icon-only ${workSummaryVisible ? 'active' : ''}`}
          type="button"
          data-work-summary-toggle
          aria-expanded={Boolean(workSummaryVisible)}
          onClick={(event) => onToggleWorkSummary(event.currentTarget)}
          aria-label={language === 'zh' ? '显示或隐藏工作摘要' : 'Show or hide work summary'}
        >
          <NotebookText size={15} />
        </button>
      )}
      {!inspectorOpen && onToggleInspector && <button
        className="topbar-inspector-action icon-only"
        type="button"
        data-inspector-toggle
        data-shortcut="toggleInspector"
        onClick={() => onToggleInspector()}
        aria-label={language === 'zh' ? '展开右侧栏' : 'Expand sidebar'}
        aria-expanded={false}
        aria-controls="right-inspector"
      >
        <PanelRightOpen size={15} />
      </button>}
    </div>
  );
}
