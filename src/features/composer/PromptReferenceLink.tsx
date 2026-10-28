import { uiText } from '../../i18n';
import { useUiLanguage } from '../../i18n/react';
import { Fragment, useContext } from 'react';
import { ConversationHostContext, type ConversationHost } from '../conversationHost';
import { Globe, LayoutGrid, MessageSquare, UsersRound } from 'lucide-react';
import { requestApplication } from '../appCenter/appCenterStore';
import { openInspector } from '../inspector/inspectorEvents';
import { openWorkSummaryInspector } from '../subagents/subagentObservabilityEvents';
import { promptReferenceHref, promptReferenceParts, type PromptReference } from '../../shared/promptReferences';
import { PluginPromptFallback } from '../plugins/PluginReferenceLink';
import { showUiError } from '../../shared/showUiError';
import { ComposerReferenceContext } from './ComposerReferenceContext';
import { BrowserTabReferenceLink } from '../browser/BrowserTabReferenceLink';
import { openBrowserTabReference } from '../browser/browserTabReferences';

export async function openPromptReference(reference: PromptReference, host?: ConversationHost, sessionId = '') {
  if (reference.kind === 'ssh') return;
  if (reference.kind === 'team') {
    (host?.openWorkSummary ?? openWorkSummaryInspector)({ kind: 'agent-definition', entity: 'team', entityId: reference.id,
      sessionId: host?.sessionId || sessionId, title: reference.title });
    return;
  }
  if (reference.kind === 'application') { requestApplication(reference.id, host?.environmentId, reference); return; }
  if (host && reference.kind !== 'browser') {
    if (reference.kind === 'conversation-extract') host.openExtract?.(reference.id);
    else host.openWorkSummary?.({ kind: 'turn-history', sessionId: reference.sessionId, turnId: reference.turnId });
    return;
  }
  if (reference.kind === 'browser') {
    const result = await openBrowserTabReference({ connectionId: 'cardbush', tabId: reference.tabId, title: reference.title, url: reference.url });
    if (result.status !== 'opened') void showUiError(uiText()('app.tabUnavailable'), result.status === 'missing' ? uiText()('promptReferenceLink.the_original_tab_was_closed') : result.message || uiText()('promptReferenceLink.could_not_display_the_original_tab'));
  }
  else if (reference.kind === 'conversation-extract') {
    try {
      const result = await window.cardbushDesktop?.conversationExtracts?.resolve(reference.id);
      if (!result) throw new Error(uiText()('conversationExtraction.conversation_excerpts_are_unavailable'));
      openInspector(result.path, result.title);
    } catch (error) { void showUiError(uiText()('promptReferenceLink.could_not_open_the_conversation_excerpt'), String(error)); }
  } else openWorkSummaryInspector({ kind: 'turn-history', sessionId: reference.sessionId, turnId: reference.turnId });
}

export function PromptReferenceLink({ reference }: { reference: PromptReference }) {
  const language = useUiLanguage();
  const host = useContext(ConversationHostContext);
  const { sessionId } = useContext(ComposerReferenceContext);
  if (reference.kind === 'browser') return <BrowserTabReferenceLink reference={{ connectionId: 'cardbush', tabId: reference.tabId, title: reference.title, url: reference.url }}/>;
  if (reference.kind === 'ssh') return <span className="context-reference-token" title={reference.path}><Globe size={16}/><span>{reference.title}</span></span>;
  return <a className="context-reference-token" href={promptReferenceHref(reference)}
    title={reference.kind === 'team' ? uiText(language)('reference.teamTitle', { title: reference.title }) : reference.title}
    onClick={event => {
      event.preventDefault();
      void openPromptReference(reference, host, sessionId);
    }}>
    {reference.kind === 'team' ? <UsersRound size={16}/> : reference.kind === 'application' ? <LayoutGrid size={16}/> : <MessageSquare size={16} />}
    <span>{reference.title}</span>
  </a>;
}

export function PromptReferenceFallback({ content }: { content: string }) {
  return <>{promptReferenceParts(content).map(part => <Fragment key={part.start}>
    {part.reference ? <PromptReferenceLink reference={part.reference} /> : <PluginPromptFallback content={part.text} />}
  </Fragment>)}</>;
}
