import type { SubagentDispatchEvent, SubagentTaskSnapshot } from '../../types';

export const SUBAGENT_DISPATCH_UI_EVENT = 'cardbush:subagent-dispatch';
export const OPEN_WORK_SUMMARY_INSPECTOR_EVENT = 'cardbush:open-work-summary-inspector';

export type WorkSummaryInspectorDetail =
  | {
      kind: 'turn-history';
      sessionId: string;
      turnId?: string;
      title?: string;
    }
  | {
      kind: 'subagent-task';
      sessionId: string;
      task: SubagentTaskSnapshot;
      title?: string;
    };

export function emitSubagentDispatch(event: SubagentDispatchEvent) {
  window.dispatchEvent(new CustomEvent<SubagentDispatchEvent>(
    SUBAGENT_DISPATCH_UI_EVENT,
    { detail: event },
  ));
}

export function openWorkSummaryInspector(detail: WorkSummaryInspectorDetail) {
  window.dispatchEvent(new CustomEvent<WorkSummaryInspectorDetail>(
    OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
    { detail },
  ));
}
