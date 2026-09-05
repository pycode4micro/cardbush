import { Clipboard, Menu, PanelRightOpen } from 'lucide-react';
import type { AppLanguage } from '../types';

export function TopBar({
  title,
  sidebarCollapsed,
  language,
  conversationContentAvailable = false,
  workSummaryVisible,
  reviewAvailable,
  onToggleWorkSummary,
  onOpenReview,
  onRevealSidebar,
}: {
  title: string;
  sidebarCollapsed: boolean;
  language: AppLanguage;
  conversationContentAvailable?: boolean;
  workSummaryVisible?: boolean;
  reviewAvailable?: boolean;
  onToggleWorkSummary?: (anchor: HTMLElement) => void;
  onOpenReview?: () => void;
  onRevealSidebar: () => void;
}) {
  return (
    <div className="topbar">
      {sidebarCollapsed && (
        <button className="icon-button" type="button" onClick={onRevealSidebar}>
          <Menu size={20} />
        </button>
      )}
      <h1>{title}</h1>
      {conversationContentAvailable && onOpenReview && reviewAvailable && (
        <button
          className="topbar-inspector-action icon-only"
          type="button"
          data-change-review-toggle
          onClick={() => onOpenReview()}
          title={language === 'zh' ? '在右侧打开修改审查' : 'Open review on the right'}
          aria-label={language === 'zh' ? '打开修改审查' : 'Open change review'}
        >
          <PanelRightOpen size={15} />
        </button>
      )}
      {conversationContentAvailable && onToggleWorkSummary && (
        <button
          className={`topbar-inspector-action icon-only ${workSummaryVisible ? 'active' : ''}`}
          type="button"
          data-work-summary-toggle
          onClick={(event) => onToggleWorkSummary(event.currentTarget)}
          title={language === 'zh' ? '显示或隐藏工作摘要' : 'Show or hide work summary'}
          aria-label={language === 'zh' ? '显示或隐藏工作摘要' : 'Show or hide work summary'}
        >
          <Clipboard size={15} />
        </button>
      )}
    </div>
  );
}
