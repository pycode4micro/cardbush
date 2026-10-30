import type { ComponentProps, RefObject, ReactNode } from 'react';
import { PERSONAL_ASSISTANT_SESSION, type NextStepPrediction } from '@cardbush/bush-protocol';
import { Composer } from '../composer';
import { ComposerReferenceContext } from '../composer/ComposerReferenceContext';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import type { ChatMessage } from '../../types';
import type { BrowserPromptReference } from '../../shared/promptReferences';

type ComposerProps = ComponentProps<typeof Composer>;
export type AssistantComposerControls = Pick<ComposerProps,
  'selectedModel' | 'availableModels' | 'onModelChange' | 'onConfigureModels' |
  'referencePlanMode' | 'onReferencePlanModeChange' | 'permissionMode' | 'onPermissionModeChange' |
  'subagentPermissionRouting' | 'onSubagentPermissionRoutingChange' | 'reasoningLevel' |
  'reasoningLevelAvailable' | 'reasoningLevels' | 'onReasoningLevelChange' | 'skills' | 'disabledSkillNames' | 'onToggleSkill'>;

export function AssistantComposer({ controls, language, draft, onDraftChange, ready, submitting, onSend, messages, fileDropTarget, browserTabs, nextStepPrediction, predictionPending, interaction, quote }: {
  controls: AssistantComposerControls; language: string; draft: string; onDraftChange(value: string): void;
  ready: boolean; submitting: boolean; onSend(text: string): Promise<boolean>; messages: ChatMessage[];
  fileDropTarget: RefObject<HTMLElement | null>;
  browserTabs: BrowserPromptReference[];
  nextStepPrediction?: NextStepPrediction;
  predictionPending?: boolean;
  interaction?: ReactNode;
  quote?: ReactNode;
}) {
  return <ComposerReferenceContext.Provider value={{ sessionId: PERSONAL_ASSISTANT_SESSION, browserTabs, messages, nextStepPrediction, predictionPending }}>
    <ComposerPresentationContext.Provider value={{ style: 'simple', preservePermissions: true }}>
      <Composer {...controls} compact language={language} draft={draft} onDraftChange={onDraftChange}
        topAccessory={(interaction || quote) && <div className="assistant-composer-accessories">{interaction}{quote}</div>}
        fileDropTarget={fileDropTarget} inputReadOnly={!ready} submissionPending={submitting}
        sending={false} referencePlanAvailable={false} retainUntilAccepted optimisticSubmission
        onSend={onSend} onCancel={async () => {}} cancelEnabled={false}/>
    </ComposerPresentationContext.Provider>
  </ComposerReferenceContext.Provider>;
}
