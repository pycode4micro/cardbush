import { Clipboard, PanelRightOpen } from 'lucide-react';
import type { AppLanguage } from '../types';

export function TopBar({
  title,
  language,
  conversationContentAvailable = false,
  workSummaryVisible,
  inspectorOpen,
  onToggleWorkSummary,
  onToggleInspector,
}: {
  title: string;
  language: AppLanguage;
  conversationContentAvailable?: boolean;
  workSummaryVisible?: boolean;
  inspectorOpen: boolean;
  onToggleWorkSummary?: (anchor: HTMLElement) => void;
  onToggleInspector: () => void;
}) {
  return (
    <div className="topbar">
      <h1>{title}</h1>
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
      {!inspectorOpen && <button
        className="topbar-inspector-action icon-only"
        type="button"
        data-inspector-toggle
        onClick={() => onToggleInspector()}
        title={language === 'zh' ? '展开右侧栏' : 'Expand sidebar'}
        aria-label={language === 'zh' ? '展开右侧栏' : 'Expand sidebar'}
        aria-expanded={false}
        aria-controls="right-inspector"
      >
        <PanelRightOpen size={15} />
      </button>}
    </div>
  );
}
