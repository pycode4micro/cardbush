import { useEffect, useMemo, useRef } from 'react';
import type { AssistantManagementSnapshot } from '@cardbush/bush-protocol';
import { createRuntimeInteractions } from '../../runtime-client/RuntimeInteractionBridge';
import { InteractionCard } from '../interactions/InteractionCard';
import { assistantBackend } from './assistantBackend';
import { uiText } from '../../i18n';

/** Same permission choices and answer validation as ordinary conversations. */
export function AssistantPermissionCard({ permission, language, onResolved }: {
  permission: AssistantManagementSnapshot['permissions'][number]; language: string; onResolved(): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    node?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    return () => { node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const { interactions, interaction } = useMemo(() => {
    const interactions = createRuntimeInteractions();
    const interaction = interactions.registerRuntimePermission({ ...permission, answer: assistantBackend.answerPermission })!;
    return { interactions, interaction };
  }, [permission, language]);
  return <dialog className="assistant-permission-dialog" ref={dialog} aria-label={uiText(language)('permissionRequestCard.approvalRequired')}
    onCancel={event => event.preventDefault()}><InteractionCard language={language} interaction={interaction}
    onReply={async answers => {
      const decision = answers[0]?.selectedOptionId;
      if (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny') return;
      await interactions.answerRuntimeInteraction(permission.permissionId, decision); await onResolved();
    }}
    onCancel={async () => { await interactions.answerRuntimeInteraction(permission.permissionId, 'cancel'); await onResolved(); }}/></dialog>;
}
