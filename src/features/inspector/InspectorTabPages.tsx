import type { ReactNode } from 'react';
import type { InspectorTab } from './inspectorTabs';

/** Switching tabs preserves each page's local state and its underlying guest. */
export function InspectorTabPages({ tabs, activeId, children }: {
  tabs: InspectorTab[];
  activeId: string;
  children: (tab: InspectorTab, active: boolean) => ReactNode;
}) {
  return <div className="right-inspector-tab-pages">
    {tabs.map(tab => {
      const active = tab.id === activeId;
      return <section key={tab.id} data-inspector-page-id={tab.id}
        className={`right-inspector-tab-page${active ? ' active' : ''}`}
        role="tabpanel" aria-hidden={!active} inert={!active}>
        {children(tab, active)}
      </section>;
    })}
  </div>;
}
