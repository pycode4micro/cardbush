import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';

export function LoopPreviewGroup({ kind, icon, label, status, children }: {
  kind: string; icon: ReactNode; label: string; status?: string; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const id = useId();
  return <section className={`loop-preview-section loop-${kind}-previews`}>
    <button type="button" className="loop-preview-summary" aria-expanded={expanded} aria-controls={id}
      onClick={event => preserveScrollPositionForToggle(event.currentTarget, () => setExpanded(value => !value))}>
      <span className="loop-preview-summary-icon" aria-hidden="true">{icon}</span><span>{label}</span>
      {status && <small>· {status}</small>}
      <ChevronDown size={13} className="loop-preview-chevron" aria-hidden="true" />
    </button>
    <div id={id} className="loop-execution-preview-group" hidden={!expanded}>{children}</div>
  </section>;
}
