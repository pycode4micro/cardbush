import { useMemo } from 'react';
import type { FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../../i18n';
import { MarkdownContent, MessageFileReferenceScope } from '../../chatMessages/MessageBubble';
import { InteractionCard } from '../../interactions/InteractionCard';
import { solutionInteractionAnswer } from '../../interactions/solutionSelectionModel';
import { createRuntimeInteractions } from '../../../runtime-client/RuntimeInteractionBridge';
import { eventBackend } from './eventBackend';
import { EventResultDisclosure } from '../../automations/EventResultDisclosure';
import { useDisclosureState } from '../../navigation/useDisclosureState';

export function FriendsEventDetails({ event, snapshot, language, showHeading = true, expanded }: {
  event?: FriendsWorkEvent; snapshot?: FriendsSnapshot; language: string; showHeading?: boolean; expanded?: Set<string>;
}) {
  const t = uiText(language);
  const history = useDisclosureState(JSON.stringify(['event', event?.id]), expanded);
  if (!event) return <p className="friends-empty">{t('yourFriends.noEvents')}</p>;
  const status = t(`yourFriends.status.${event.status}`);
  const due = snapshot?.detections.find(timer => timer.eventId === event.id);
  const zone = event.recurrence?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const execution = event.conversationExecution;
  const date = new Intl.DateTimeFormat(language, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
  return <div className="friends-event-details">
    {showHeading && <><h3>{event.title}</h3><p className="friends-aside">{event.subscription ? t('assistant.events.subscriptionStatus', { status }) : status}</p></>}
    {execution?.sourceTitle && <p className="friends-aside">{t('assistant.events.sourceConversation', { title: execution.sourceTitle })}</p>}
    {due && event.status !== 'failed' && event.status !== 'paused' && <p className="friends-aside">
      {t('assistant.events.nextOccurrence', {
        time: date.format(new Date(due.at)), zone,
      })}
    </p>}
    {execution && execution.runs.length > 0 && <details className="event-history" {...history}>
      <summary>{t('assistant.events.runHistory')}</summary><ul>{[...execution.runs].reverse().map(run => {
        const label = <><time dateTime={run.at}>{date.format(new Date(run.at))}</time> · {t(run.status === 'awaiting_user_action' ? 'automationPanel.needsAttention' : `automationPanel.${run.status}`)}</>;
        return <li key={run.id}>{run.status === 'queued' || run.status === 'running' ? label :
          <EventResultDisclosure jobId={execution.jobId} runId={run.id} summary={run.summary} language={language} ResultContent={MarkdownContent} expanded={expanded}>{label}</EventResultDisclosure>}</li>;
      })}</ul></details>}
    {event.error && <p className="your-friends-error" role="alert">{t(event.interruptedTurnId ? 'yourFriends.executionInterrupted' : 'yourFriends.executionFailed')} <code>{event.error}</code></p>}
    {event.result && <><h3>{t('yourFriends.latestResult')}</h3><div className="friends-result">{execution ? <p>{event.result.text}</p> : <MessageFileReferenceScope workspaceRoot={snapshot?.workspaceDir}>
      <MarkdownContent content={event.result.text} language={language}/>
    </MessageFileReferenceScope>}</div></>}
    {event.inputs.length > 0 && <><h3>{t(event.inputs.some(input => input.authoredBy === 'assistant') ? 'assistant.events.evidence' : 'yourFriends.originalInputs')}</h3>{event.inputs.map(input => <p className="friends-original-input" key={input.id}>{input.text}</p>)}</>}
  </div>;
}

export function FriendsExecutionRequests({ snapshot, language, refresh }: {
  snapshot?: FriendsSnapshot; language: string; refresh(): Promise<void>;
}) {
  const t = uiText(language);
  const interactions = useMemo(() => {
    const bridge = createRuntimeInteractions();
    return { bridge, permissions: snapshot?.permissions.flatMap(permission => {
      const interaction = bridge.registerRuntimePermission({ ...permission, answer: eventBackend.answerPermission });
      return interaction ? [{ permission, interaction }] : [];
    }) ?? [], solutions: snapshot?.solutions.map(request => bridge.registerRuntimeSolution(request)) ?? [] };
  }, [snapshot?.permissions, snapshot?.solutions, language]);
  return <div className="friends-execution-requests">
    {!interactions.permissions.length && !interactions.solutions.length && <p className="friends-aside">{t('yourFriends.noPendingRequests')}</p>}
    {interactions.permissions.map(({ permission, interaction }) => <InteractionCard key={permission.permissionId} language={language} interaction={interaction}
      onReply={async answers => { const decision = answers[0]?.selectedOptionId;
        if (decision === 'allow_once' || decision === 'allow_session' || decision === 'deny') { await interactions.bridge.answerRuntimeInteraction(permission.permissionId, decision); await refresh(); }
      }} onCancel={async () => { await interactions.bridge.answerRuntimeInteraction(permission.permissionId, 'cancel'); await refresh(); }}/>)}
    {interactions.solutions.map(interaction => <InteractionCard key={interaction.id} language={language} interaction={interaction}
      onReply={async answers => { await eventBackend.answerSolution(solutionInteractionAnswer(interaction, answers)); await refresh(); }}
      onCancel={async () => { await eventBackend.answerSolution({ selectionId: interaction.id, sessionId: interaction.sessionId!, turnId: interaction.turnId!, kind: 'cancel' }); await refresh(); }}/>)}
  </div>;
}
