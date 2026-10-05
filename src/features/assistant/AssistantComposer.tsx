import type { ComponentProps, RefObject } from 'react';
import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
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

export function AssistantComposer({ controls, language, draft, onDraftChange, ready, submitting, onSend, messages, fileDropTarget, browserTabs }: {
  controls: AssistantComposerControls; language: 'zh' | 'en'; draft: string; onDraftChange(value: string): void;
  ready: boolean; submitting: boolean; onSend(text: string): Promise<boolean>; messages: ChatMessage[];
  fileDropTarget: RefObject<HTMLElement | null>;
  browserTabs: BrowserPromptReference[];
}) {
  return <ComposerReferenceContext.Provider value={{ sessionId: PERSONAL_ASSISTANT_SESSION, browserTabs, messages }}>
    <ComposerPresentationContext.Provider value={{ style: 'simple', preservePermissions: true }}>
      <Composer {...controls} compact language={language} draft={draft} onDraftChange={onDraftChange}
        fileDropTarget={fileDropTarget} inputReadOnly={!ready} submissionPending={submitting}
        sending={false} referencePlanAvailable={false} retainUntilAccepted
        onSend={onSend} onCancel={async () => {}} cancelEnabled={false}/>
    </ComposerPresentationContext.Provider>
  </ComposerReferenceContext.Provider>;
}
