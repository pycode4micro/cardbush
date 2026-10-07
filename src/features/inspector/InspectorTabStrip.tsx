import { Plus } from 'lucide-react';
import { Children, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';

export function InspectorTabStrip({ language, stripRef, onNewTab, children }: {
  language: AppLanguage; stripRef?: Ref<HTMLDivElement>; onNewTab: () => void; children: ReactNode;
}) {
  const shortcuts = useKeyboardShortcuts();
  return <div className="right-inspector-tab-strip">
    <div className="right-inspector-tabs" ref={stripRef} role="tablist" style={{ '--inspector-tab-count': Children.count(children) } as CSSProperties}
      aria-label={language === 'zh' ? '已打开的标签页' : 'Open inspector tabs'}>{children}</div>
    <button type="button" className="right-inspector-new-tab" onClick={onNewTab}
      aria-label={language === 'zh' ? '新建标签页' : 'New tab'} aria-keyshortcuts={shortcuts.aria('openBrowser')}>
      <Plus size={17} aria-hidden="true"/>
    </button>
  </div>;
}
