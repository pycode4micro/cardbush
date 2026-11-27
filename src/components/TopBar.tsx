import { createPortal } from 'react-dom';
import { resolveUiLanguage, uiText } from '../i18n';
import { AlignLeft, PanelRight } from 'lucide-react';
import type { AppLanguage } from '../types';
import type { ComponentProps, ReactNode } from 'react';
import { conversationDisplayTitle } from '../shared/conversationTitle';

export function TopBar({
  title,
  language,
  conversationContentAvailable = false,
  workSummaryVisible,
  workSummarySubagents,
  inspectorOpen,
  onToggleWorkSummary,
  workSummaryHoverProps,
  onToggleInspector,
  workspaceControl,
  actionsTarget,
  showActionTooltips = false,
}: {
  title?: string;
  language: AppLanguage;
  conversationContentAvailable?: boolean;
  workSummaryVisible?: boolean;
  workSummarySubagents?: { active: number; unread: number; spinning: boolean };
  inspectorOpen: boolean;
  onToggleWorkSummary?: (anchor: HTMLElement) => void;
  workSummaryHoverProps?: ComponentProps<'button'>;
  onToggleInspector?: () => void;
  workspaceControl?: ReactNode;
  actionsTarget?: HTMLElement | null;
  showActionTooltips?: boolean;
}) {
  const t = uiText(language);
  const subagentCount = (workSummarySubagents?.active ?? 0) + (workSummarySubagents?.unread ?? 0);
  const number = new Intl.NumberFormat(resolveUiLanguage(language));
  const summaryLabel = subagentCount && workSummarySubagents
    ? t('topBar.workSummarySubagentActivity', { active: number.format(workSummarySubagents.active), unread: number.format(workSummarySubagents.unread) })
    : t('topBar.showOrHideWorkSummary');
  const inspectorLabel = t(inspectorOpen ? 'app.closeInspector' : 'topBar.expandSidebar');
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
          aria-label={summaryLabel}
          data-tooltip={showActionTooltips ? summaryLabel : undefined}
        >
          <AlignLeft size={15} aria-hidden="true" />
          {subagentCount > 0 && <span className="work-summary-badge" data-spinning={workSummarySubagents?.spinning || undefined} aria-hidden="true">
            {`${number.format(Math.min(subagentCount, 99))}${subagentCount > 99 ? '+' : ''}`}
          </span>}
        </button>
      )}
      {onToggleInspector && <button
        className={`topbar-inspector-action icon-only${inspectorOpen ? ' active' : ''}`}
        type="button"
        data-inspector-toggle
        data-shortcut="toggleInspector"
        onClick={() => onToggleInspector()}
        aria-label={inspectorLabel}
        data-tooltip={showActionTooltips ? inspectorLabel : undefined}
        aria-expanded={inspectorOpen}
        aria-controls="right-inspector"
      >
        <PanelRight size={15} aria-hidden="true" />
      </button>}
    </>
  );
  if (actionsTarget !== undefined) return actionsTarget ? createPortal(actions, actionsTarget) : null;
  const displayTitle = title === undefined ? undefined : conversationDisplayTitle(title);
  return <div className="topbar" data-titleless={displayTitle === undefined || undefined}>
    {displayTitle !== undefined && <h1 title={displayTitle}>{displayTitle}</h1>}
    {actions}
  </div>;
}
