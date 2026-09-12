import { Fragment } from 'react';
import { Globe, MessageSquare } from 'lucide-react';
import { openInspector } from '../inspector/inspectorEvents';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { promptReferenceHref, promptReferenceParts, type PromptReference } from '../../shared/promptReferences';
import { PluginPromptFallback } from '../plugins/PluginReferenceLink';

export function PromptReferenceLink({ reference }: { reference: PromptReference }) {
  return <a className="context-reference-token" href={promptReferenceHref(reference)}
    title={reference.kind === 'browser' ? reference.url : reference.title}
    onClick={event => {
      event.preventDefault();
      if (reference.kind === 'browser') openInspector(reference.url, reference.title, reference.tabId);
      else openWorkSummaryInspector({ kind: 'turn-history', sessionId: reference.sessionId, turnId: reference.turnId });
    }}>
    {reference.kind === 'browser' ? <Globe size={16} /> : <MessageSquare size={16} />}
    <span>{reference.title}</span>
  </a>;
}

export function PromptReferenceFallback({ content }: { content: string }) {
  return <>{promptReferenceParts(content).map(part => <Fragment key={part.start}>
    {part.reference ? <PromptReferenceLink reference={part.reference} /> : <PluginPromptFallback content={part.text} />}
  </Fragment>)}</>;
}
