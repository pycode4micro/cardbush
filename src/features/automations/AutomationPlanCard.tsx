import { useId, useState, type ReactNode } from 'react';
import { CalendarClock, ChevronDown } from 'lucide-react';
import type { AutomationJob } from '@cardbush/bush-protocol';
import { compactAutomationText } from './automationCalendarModel';

export function AutomationPlanCard({ job, label, state, hint, leading, children }: {
  job: AutomationJob;
  label: string;
  state: string;
  hint: string;
  leading?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  return <article className="automation-card" data-expanded={expanded} data-job-id={job.id}>
    <button type="button" className="automation-plan-toggle" aria-expanded={expanded} aria-controls={detailsId}
      aria-label={job.name} onClick={() => setExpanded(value => !value)}>
      <span className="automation-plan-leading">{leading ?? <CalendarClock size={18}/>}</span>
      <span className="automation-plan-copy">
        <strong title={job.name}>{compactAutomationText(job.name)}</strong>
        <span className="automation-plan-preview">{compactAutomationText(job.prompt, 15)}</span>
        <span className="automation-plan-hint" title={hint}>{hint}</span>
      </span>
      <span className="automation-state" data-state={state}>{label}</span>
      <ChevronDown className="automation-plan-chevron" size={15}/>
    </button>
    {expanded && <div id={detailsId} className="automation-plan-details"><h2>{job.name}</h2>{children}</div>}
  </article>;
}
