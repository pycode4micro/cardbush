import { createPortal } from 'react-dom';
import { uiText } from '../i18n';
import { NotebookText, PanelRightClose, PanelRightOpen } from 'lucide-react';
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
  actionsTarget,
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
  actionsTarget?: HTMLElement | null;
  titleIcon?: ReactNode;
}) {
  const actions = (
    <>
      {workspaceControl}
      {conversationContentAvailable && onToggleWorkSummary && (
        <button
          {...workSummaryHoverProps}
          className={`topbar-inspector-action icon-only ${workSummaryVisible ? 'active' : ''}`}
          type="button"
          data-work-summary-toggle
          aria-expanded={Boolean(workSummaryVisible)}
          onClick={(event) => onToggleWorkSummary(event.currentTarget)}
          aria-label={uiText(language)('topBar.showOrHideWorkSummary')}
        >
          <NotebookText size={15} />
        </button>
      )}
      {onToggleInspector && (!inspectorOpen || actionsTarget) && <button
        className="topbar-inspector-action icon-only"
        type="button"
        data-inspector-toggle
        data-shortcut="toggleInspector"
        onClick={() => onToggleInspector()}
        aria-label={uiText(language)(inspectorOpen ? 'app.closeInspector' : 'topBar.expandSidebar')}
        aria-expanded={inspectorOpen}
        aria-controls="right-inspector"
      >
        {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
      </button>}
    </>
  );
  if (actionsTarget !== undefined) return actionsTarget ? createPortal(actions, actionsTarget) : null;
  const displayTitle = conversationDisplayTitle(title);
  return <div className="topbar">
    {titleIcon}
    <h1 title={displayTitle}>{displayTitle}</h1>
    {actions}
  </div>;
}
