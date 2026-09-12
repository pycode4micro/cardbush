import { useCallback, useReducer } from 'react';
import { inspectorTabsReducer, type InspectorTab } from '../features/inspector/inspectorTabs';

export function useInspectorTabs() {
  const [state, dispatch] = useReducer(inspectorTabsReducer, { tabs: [], activeId: '' });
  const openTab = useCallback((tab: InspectorTab) => dispatch({ type: 'open', tab }), []);
  const activateTab = useCallback((id: string) => dispatch({ type: 'activate', id }), []);
  const closeTabs = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'close', ids }), []);
  return {
    tabs: state.tabs, activeId: state.activeId,
    activeTab: state.tabs.find(tab => tab.id === state.activeId) ?? null,
    openTab, activateTab, closeTabs,
  };
}
