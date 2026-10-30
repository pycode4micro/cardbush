import { useMemo } from 'react';
import type { AssistantManagementSnapshot } from '@cardbush/bush-protocol';
import { createRuntimeInteractions } from '../../runtime-client/RuntimeInteractionBridge';
import { InteractionCard } from '../interactions/InteractionCard';
import { assistantBackend } from './assistantBackend';

/** Same permission choices and answer validation as ordinary conversations. */
export function AssistantPermissionCard({ permission, language, onResolved }: {
  permission: AssistantManagementSnapshot['permissions'][number]; language: string; onResolved(): Promise<void>;
}) {
  const { interactions, interaction } = useMemo(() => {
    const interactions = createRuntimeInteractions();
    const interaction = interactions.registerRuntimePermission({ ...permission, answer: assistantBackend.answerPermission })!;
    return { interactions, interaction };
  }, [permission, language]);
  return <InteractionCard language={language} interaction={interaction}
    onReply={async answers => {
      const decision = answers[0]?.selectedOptionId;
      if (decision !== 'allow_once' && decision !== 'allow_session' && decision !== 'deny') return;
      await interactions.answerRuntimeInteraction(permission.permissionId, decision); await onResolved();
    }}
    onCancel={async () => { await interactions.answerRuntimeInteraction(permission.permissionId, 'cancel'); await onResolved(); }}/ >;
}
