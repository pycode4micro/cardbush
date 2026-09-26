import { Fragment, useContext } from 'react';
import { ConversationHostContext, type ConversationHost } from '../conversationHost';
import { Globe, LayoutGrid, MessageSquare } from 'lucide-react';
import { requestApplication } from '../appCenter/appCenterStore';
import { openInspector } from '../inspector/inspectorEvents';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { promptReferenceHref, promptReferenceParts, type PromptReference } from '../../shared/promptReferences';
import { PluginPromptFallback } from '../plugins/PluginReferenceLink';
import { showUiError } from '../../shared/showUiError';

export async function openPromptReference(reference: PromptReference, host?: ConversationHost) {
  if (reference.kind === 'ssh') return;
  if (reference.kind === 'application') { requestApplication(reference.id, host?.environmentId, reference); return; }
  if (host && reference.kind !== 'browser') {
    if (reference.kind === 'conversation-extract') host.openExtract?.(reference.id);
    else host.openWorkSummary?.({ kind: 'turn-history', sessionId: reference.sessionId, turnId: reference.turnId });
    return;
  }
  if (reference.kind === 'browser') openInspector(reference.url, reference.title, reference.tabId);
  else if (reference.kind === 'conversation-extract') {
    try {
      const result = await window.cardbushDesktop?.conversationExtracts?.resolve(reference.id);
      if (!result) throw new Error('对话提取不可用。');
      openInspector(result.path, result.title);
    } catch (error) { void showUiError('无法打开对话提取', String(error)); }
  } else openWorkSummaryInspector({ kind: 'turn-history', sessionId: reference.sessionId, turnId: reference.turnId });
}

export function PromptReferenceLink({ reference }: { reference: PromptReference }) {
  const host = useContext(ConversationHostContext);
  if (reference.kind === 'ssh') return <span className="context-reference-token" title={reference.path}><Globe size={16}/><span>{reference.title}</span></span>;
  return <a className="context-reference-token" href={promptReferenceHref(reference)}
    title={reference.kind === 'browser' ? reference.url : reference.title}
    onClick={event => {
      event.preventDefault();
      void openPromptReference(reference, host);
    }}>
    {reference.kind === 'application' ? <LayoutGrid size={16}/> : reference.kind === 'browser' ? <Globe size={16} /> : <MessageSquare size={16} />}
    <span>{reference.title}</span>
  </a>;
}

export function PromptReferenceFallback({ content }: { content: string }) {
  return <>{promptReferenceParts(content).map(part => <Fragment key={part.start}>
    {part.reference ? <PromptReferenceLink reference={part.reference} /> : <PluginPromptFallback content={part.text} />}
  </Fragment>)}</>;
}
