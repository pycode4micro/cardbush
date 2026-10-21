import { useContext, useId, useMemo } from 'react';
import type { AppLanguage } from '../../types';
import { ConversationExtractionContext } from '../chat/ConversationExtraction';
import { Composer } from '../composer/Composer';
import { ComposerPortalContext } from '../composer/ComposerPortalContext';
import { ComposerPresentationContext } from '../composer/ComposerPresentationContext';
import { ComposerReferenceContext } from '../composer/ComposerReferenceContext';
import { ConversationHostContext, ConversationMessageTargetContext, type ConversationHost } from '../conversationHost';

const noop = () => {};
const noSkills = new Set<string>();
// An explicit host prevents the preview from falling back to desktop services.
const previewHost: ConversationHost = {
  id: 'component-preview',
  plugins: [],
  pluginCommands: [],
  conversationStyleAvailable: false,
  uploadFiles: async () => [],
  openFile: noop,
  toolDetails: async () => [],
};

/** Reuse the real layout without mounting a conversation's composer or callbacks. */
export function ComponentComposerPreview({ language }: { language: AppLanguage }) {
  const id = useId(), presentation = useContext(ComposerPresentationContext);
  const references = useMemo(() => ({ sessionId: `component-preview-${id}`, browserTabs: [], messages: [] }), [id]);
  return <div inert>
    <ConversationHostContext.Provider value={previewHost}>
      <ConversationMessageTargetContext.Provider value={undefined}>
        <ConversationExtractionContext.Provider value={null}>
          <ComposerReferenceContext.Provider value={references}>
            <ComposerPortalContext.Provider value={null}>
              <ComposerPresentationContext.Provider value={{ ...presentation, preview: true }}>
                <Composer compact inputReadOnly language={language} draft="" onDraftChange={noop}
                  sending={false} cancelEnabled={false} selectedModel="" availableModels={[]}
                  referencePlanAvailable={false} referencePlanMode="off" permissionMode="task_free"
                  subagentPermissionRouting="user" reasoningLevelAvailable={false} reasoningLevel="high" reasoningLevels={[]}
                  disabledSkillNames={noSkills} onModelChange={noop} onReferencePlanModeChange={noop}
                  onPermissionModeChange={noop} onSubagentPermissionRoutingChange={noop} onReasoningLevelChange={noop}
                  onConfigureModels={noop} onToggleSkill={noop} onSend={async () => false} onCancel={async () => {}}/>
              </ComposerPresentationContext.Provider>
            </ComposerPortalContext.Provider>
          </ComposerReferenceContext.Provider>
        </ConversationExtractionContext.Provider>
      </ConversationMessageTargetContext.Provider>
    </ConversationHostContext.Provider>
  </div>;
}
