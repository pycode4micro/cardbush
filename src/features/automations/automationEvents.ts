export const OPEN_AUTOMATION_RUN_EVENT = 'cardbush:open-automation-run';
export type AutomationRunOpenDetail = { jobId: string; runId: string; title: string };
export function openAutomationRun(jobId: string, runId: string, title: string) {
  window.dispatchEvent(new CustomEvent<AutomationRunOpenDetail>(OPEN_AUTOMATION_RUN_EVENT, { detail: { jobId, runId, title } }));
}
