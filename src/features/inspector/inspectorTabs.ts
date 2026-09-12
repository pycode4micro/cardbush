import type { ShadowConversationContext } from '../../ShadowWindow';
import type { AppLanguage } from '../../types';
import type { WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import type { InspectorOpenDetail } from './inspectorEvents';

export type InspectorResourceTab = { id: string; kind: 'resource'; detail: InspectorOpenDetail };
export type InspectorReviewTab = {
  id: string; kind: 'review'; conversationId: string; initialFilePath: string; title: string;
  selectionRequestId?: string;
};
export type InspectorShadowTab = {
  id: string; kind: 'shadow'; context: ShadowConversationContext; title: string;
};
export type InspectorHistoryTab = {
  id: string; kind: 'history'; detail: Extract<WorkSummaryInspectorDetail, { kind: 'turn-history' }>; title: string;
};
export type InspectorSubagentTab = {
  id: string; kind: 'subagent'; detail: Extract<WorkSummaryInspectorDetail, { kind: 'subagent-task' }>; title: string;
};
export type InspectorTab = InspectorResourceTab | InspectorReviewTab | InspectorShadowTab
  | InspectorHistoryTab | InspectorSubagentTab;

export function workSummaryInspectorTab(detail: WorkSummaryInspectorDetail, language: AppLanguage): InspectorHistoryTab | InspectorSubagentTab {
  if (detail.kind === 'turn-history') {
    return {
      id: `history:${detail.sessionId}`, kind: 'history', detail,
      title: language === 'zh' ? '历史记录' : 'History',
    };
  }
  return {
    id: `subagent:${detail.sessionId}:${detail.task.taskId || detail.task.toolCallId || detail.task.childTurnId}`,
    kind: 'subagent', detail,
    title: detail.title || (language === 'zh' ? '子任务详情' : 'Subagent task'),
  };
}

export interface InspectorTabsState { tabs: InspectorTab[]; activeId: string }
export type InspectorTabsAction =
  | { type: 'open'; tab: InspectorTab }
  | { type: 'activate'; id: string }
  | { type: 'close'; ids: ReadonlySet<string> };

// Every inspector page participates in the same selection and close lifecycle.
// Keep the active ID and collection atomic, including batched open/close actions.
export function inspectorTabsReducer(state: InspectorTabsState, action: InspectorTabsAction): InspectorTabsState {
  if (action.type === 'activate') {
    return state.tabs.some(tab => tab.id === action.id) ? { ...state, activeId: action.id } : state;
  }
  if (action.type === 'open') {
    const next = action.tab;
    const index = state.tabs.findIndex(tab => tab.id === next.id || (
      tab.kind === 'subagent' && next.kind === 'subagent' && tab.detail.sessionId === next.detail.sessionId &&
      (['taskId', 'toolCallId', 'childTurnId'] as const).some(key =>
        Boolean(tab.detail.task[key]) && tab.detail.task[key] === next.detail.task[key])
    ));
    if (index < 0) return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };
    const previous = state.tabs[index];
    const tab = previous.kind === 'resource' && next.kind === 'resource'
      ? { ...next, detail: { ...previous.detail, ...next.detail, title: next.detail.title || previous.detail.title } }
      : { ...next, id: previous.id };
    const tabs = [...state.tabs];
    tabs[index] = tab;
    return { tabs, activeId: tab.id };
  }
  const tabs = state.tabs.filter(tab => !action.ids.has(tab.id));
  if (tabs.length === state.tabs.length) return state;
  const index = state.tabs.findIndex(tab => tab.id === state.activeId);
  return {
    tabs,
    activeId: action.ids.has(state.activeId)
      ? tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? ''
      : state.activeId,
  };
}
