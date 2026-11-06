import { useMemo } from 'react';
import type { FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages/MessageBubble';
import { InteractionCard } from '../interactions/InteractionCard';
import { solutionInteractionAnswer } from '../interactions/solutionSelectionModel';
import { createRuntimeInteractions } from '../../runtime-client/RuntimeInteractionBridge';
import { friendsBackend } from './friendsBackend';

export function FriendsExecutionView({ event, snapshot, language, refresh, manage }: {
  event?: FriendsWorkEvent; snapshot?: FriendsSnapshot; language: string; refresh(): Promise<void>;
  manage(action: 'pause' | 'resume', id: string): void;
}) {
  const t = uiText(language);
  const interactions = useMemo(() => {
    const bridge = createRuntimeInteractions();
    return { bridge, permissions: snapshot?.permissions.map(permission => ({ permission,
      interaction: bridge.registerRuntimePermission({ ...permission, answer: friendsBackend.answerPermission })! })) ?? [],
    solutions: snapshot?.solutions.map(request => bridge.registerRuntimeSolution(request)) ?? [] };
  }, [snapshot?.permissions, snapshot?.solutions, language]);
  return <section className="friends-event-stage" aria-live="polite">
    <h1>{event ? (event.origin === 'user' ? t('yourFriends.eventProgress') : event.title) : t('yourFriends.runtimeReady')}</h1>
    <p className="friends-lead">{t(event ? `yourFriends.status.${event.status}` : 'yourFriends.runtimeDescription')}</p>
    {event?.result && <div className="friends-card friends-result"><MessageFileReferenceScope workspaceRoot={snapshot?.workspaceDir}>
      <MarkdownContent content={event.result.text} language={language}/></MessageFileReferenceScope></div>}
    {event?.error && <p className="your-friends-error" role="alert">{t(event.interruptedTurnId ? 'yourFriends.executionInterrupted' : 'yourFriends.executionFailed')} <code>{event.error}</code></p>}
    {event && <div className="friends-event-actions">
      {['queued', 'running', 'watching'].includes(event.status)
        ? <button type="button" className="friends-text-button" onClick={() => manage('pause', event.id)}>{t('yourFriends.pauseExecution')}</button>
        : ['paused', 'failed'].includes(event.status) && <button type="button" className="friends-text-button" onClick={() => manage('resume', event.id)}>{t('yourFriends.resumeExecution')}</button>}
    </div>}
    {interactions.permissions.map(({ permission, interaction }) => <InteractionCard key={permission.permissionId} language={language} interaction={interaction}
      onReply={async answers => { const decision = answers[0]?.selectedOptionId;
        if (decision === 'allow_once' || decision === 'allow_session' || decision === 'deny') { await interactions.bridge.answerRuntimeInteraction(permission.permissionId, decision); await refresh(); }
      }} onCancel={async () => { await interactions.bridge.answerRuntimeInteraction(permission.permissionId, 'cancel'); await refresh(); }}/ >)}
    {interactions.solutions.map(interaction => <InteractionCard key={interaction.id} language={language} interaction={interaction}
      onReply={async answers => { await friendsBackend.answerSolution(solutionInteractionAnswer(interaction, answers)); await refresh(); }}
      onCancel={async () => { await friendsBackend.answerSolution({ selectionId: interaction.id, sessionId: interaction.sessionId!, turnId: interaction.turnId!, kind: 'cancel' }); await refresh(); }}/ >)}
  </section>;
}
