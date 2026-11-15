import type { ComponentProps, RefObject, ReactNode } from 'react';
import { PERSONAL_ASSISTANT_SESSION, type UserMessagePrediction } from '@cardbush/bush-protocol';
import { Composer } from '../composer';
import { ComposerReferenceContext } from '../composer/ComposerReferenceContext';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import type { ChatMessage } from '../../types';
import type { BrowserPromptReference } from '../../shared/promptReferences';

type ComposerProps = ComponentProps<typeof Composer>;
export type AssistantComposerControls = Pick<ComposerProps,
  'selectedModel' | 'availableModels' | 'onModelChange' | 'onConfigureModels' |
  'referencePlanMode' | 'onReferencePlanModeChange' | 'permissionMode' | 'onPermissionModeChange' |
  'subagentPermissionRouting' | 'onSubagentPermissionRoutingChange' | 'onRetainDraft' | 'reasoningLevel' |
  'reasoningLevelAvailable' | 'reasoningLevels' | 'onReasoningLevelChange' | 'skills' | 'disabledSkillNames' | 'onToggleSkill'>;

export function AssistantComposer({ controls, language, draft, onDraftChange, ready, submitting, busy, onSend, onCancel, queuedMessages, messages, fileDropTarget, browserTabs, userMessagePrediction, predictionPending, interaction, quote }: {
  controls: AssistantComposerControls; language: string; draft: string; onDraftChange(value: string): void;
  ready: boolean; submitting: boolean; busy: boolean; onSend: ComposerProps['onSend']; onCancel: ComposerProps['onCancel'];
  queuedMessages: ComposerProps['queuedMessages']; messages: ChatMessage[];
  fileDropTarget: RefObject<HTMLElement | null>;
  browserTabs: BrowserPromptReference[];
  userMessagePrediction?: UserMessagePrediction;
  predictionPending?: boolean;
  interaction?: ReactNode;
  quote?: ReactNode;
}) {
  return <ComposerReferenceContext.Provider value={{ sessionId: PERSONAL_ASSISTANT_SESSION, browserTabs, messages, userMessagePrediction, predictionPending }}>
    <ComposerPresentationContext.Provider value={{ style: 'simple' }}>
      <Composer {...controls} compact language={language} draft={draft} onDraftChange={onDraftChange}
        topAccessory={(interaction || quote) && <div className="assistant-composer-accessories">{interaction}{quote}</div>}
        fileDropTarget={fileDropTarget} inputReadOnly={!ready} submissionPending={submitting}
        sending={busy} guidanceDeliveryMode="immediate" queuedMessages={queuedMessages}
        referencePlanAvailable={false} retainUntilAccepted optimisticSubmission
        onSend={onSend} onCancel={onCancel} cancelEnabled={busy}/>
    </ComposerPresentationContext.Provider>
  </ComposerReferenceContext.Provider>;
}
