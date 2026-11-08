import { useMemo } from 'react';
import type { FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../../i18n';
import { MarkdownContent, MessageFileReferenceScope } from '../../chatMessages/MessageBubble';
import { InteractionCard } from '../../interactions/InteractionCard';
import { solutionInteractionAnswer } from '../../interactions/solutionSelectionModel';
import { createRuntimeInteractions } from '../../../runtime-client/RuntimeInteractionBridge';
import { eventBackend } from './eventBackend';

export function FriendsEventDetails({ event, snapshot, language, showHeading = true }: {
  event?: FriendsWorkEvent; snapshot?: FriendsSnapshot; language: string; showHeading?: boolean;
}) {
  const t = uiText(language);
  if (!event) return <p className="friends-empty">{t('yourFriends.noEvents')}</p>;
  const status = t(`yourFriends.status.${event.status}`);
  const due = event.recurrence && snapshot?.detections.find(timer => timer.eventId === event.id);
  return <div className="friends-event-details">
    {showHeading && <><h3>{event.title}</h3><p className="friends-aside">{event.subscription ? t('assistant.events.subscriptionStatus', { status }) : status}</p></>}
    {due && event.recurrence && event.status !== 'failed' && event.status !== 'paused' && <p className="friends-aside">
      {t('assistant.events.nextOccurrence', {
        time: new Intl.DateTimeFormat(language, { timeZone: event.recurrence.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(due.at)),
        zone: event.recurrence.timeZone,
      })}
    </p>}
    {event.error && <p className="your-friends-error" role="alert">{t(event.interruptedTurnId ? 'yourFriends.executionInterrupted' : 'yourFriends.executionFailed')} <code>{event.error}</code></p>}
    {event.result && <><h3>{t('yourFriends.latestResult')}</h3><div className="friends-result"><MessageFileReferenceScope workspaceRoot={snapshot?.workspaceDir}>
      <MarkdownContent content={event.result.text} language={language}/>
    </MessageFileReferenceScope></div></>}
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
