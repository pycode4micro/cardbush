import { WorkspaceLocationButton } from '../ssh/WorkspaceLocationPicker';
import { type ReactNode, type RefObject, useRef } from 'react';
import type { QueuedChatMessage } from '../../hooks/useCardbushChat';
import { Composer } from '../composer';
import { basename, samePath } from '../../shared/localPaths';
import { StarWordmark } from './StarWordmark';
import { WelcomeSuggestions } from './WelcomeSuggestions';
import type { WelcomeSuggestion } from './welcomeSuggestionRanking';
import type {
  AppLanguage,
  AppSettingsState,
  ManagedModelConfig,
  PermissionMode,
  SubagentPermissionRouting,
  ReasoningLevel,
  ReferencePlanMode,
  ProjectItem,
  SkillSummary,
} from '../../types';

export function WelcomeComposer({
  language,
  fileDropTarget,
  draft,
  onDraftChange,
  sending,
  stopping,
  guidanceDeliveryMode,
  cancelEnabled,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  selectedModel,
  availableModels,
  teamAvailable = false,
  goalAvailable,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  subagentPermissionRouting,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  selectedProjectDir,
  availableProjects,
  onProjectChange,
  skills = [],
  disabledSkillNames,
  onToggleSkill,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSubagentPermissionRoutingChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onOpenConversation,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onSend,
  onCancel,
  workspaceControl,
  submissionPending,
}: {
  language: AppLanguage;
  fileDropTarget?: RefObject<HTMLElement | null>;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  stopping: boolean;
  guidanceDeliveryMode: AppSettingsState['guidance']['deliveryMode'];
  cancelEnabled: boolean;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  teamAvailable?: boolean;
  goalAvailable: boolean;
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  subagentPermissionRouting: SubagentPermissionRouting;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onProjectChange: (projectDir: string | null) => Promise<void>;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSubagentPermissionRoutingChange: (value: SubagentPermissionRouting) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onOpenConversation: (conversationId: string) => void;
  onEditQueuedMessage: (item: QueuedChatMessage) => void;
  onGuideQueuedMessage: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onSend: (text: string, options?: { immediate?: boolean }) => Promise<void | boolean>;
  onCancel: () => Promise<void>;
  workspaceControl?: ReactNode;
  submissionPending?: boolean;
}) {
  const welcomeRef = useRef<HTMLDivElement>(null);
  const selectedProjectTitle = availableProjects.find(project => samePath(project.rootPath, selectedProjectDir))?.title
    || basename(selectedProjectDir);
  function selectSuggestion({ text, sessionId }: WelcomeSuggestion) {
    if (sending) return;
    if (sessionId) {
      onOpenConversation(sessionId);
      return;
    }
    if (draft.trim()) return;
    onDraftChange(text);
    requestAnimationFrame(() => {
      const input = welcomeRef.current?.querySelector<HTMLElement>('[data-composer-input]');
      input?.focus();
      if (input instanceof HTMLTextAreaElement) input.setSelectionRange(text.length, text.length);
    });
  }
  const welcomeComposer = (
    <Composer
      compact
      fileDropTarget={fileDropTarget}
      language={language}
      draft={draft}
      onDraftChange={onDraftChange}
      sending={sending}
      submissionPending={submissionPending}
      stopping={stopping}
      guidanceDeliveryMode={guidanceDeliveryMode}
      cancelEnabled={cancelEnabled}
      queuedMessageCount={queuedMessageCount}
      queuedMessagePreview={queuedMessagePreview}
      queuedMessages={queuedMessages}
      selectedModel={selectedModel}
      availableModels={availableModels}
      teamAvailable={teamAvailable}
      goalAvailable={goalAvailable}
      referencePlanAvailable={referencePlanAvailable}
      referencePlanMode={referencePlanMode}
      permissionMode={permissionMode}
      subagentPermissionRouting={subagentPermissionRouting}
      reasoningLevelAvailable={reasoningLevelAvailable}
      reasoningLevel={reasoningLevel}
      reasoningLevels={reasoningLevels}
      onModelChange={onModelChange}
      onReferencePlanModeChange={onReferencePlanModeChange}
      onPermissionModeChange={onPermissionModeChange}
      onSubagentPermissionRoutingChange={onSubagentPermissionRoutingChange}
      onReasoningLevelChange={onReasoningLevelChange}
      onConfigureModels={onConfigureModels}
      onCreateConversation={onCreateConversation}
      skills={skills}
      disabledSkillNames={disabledSkillNames}
      onToggleSkill={onToggleSkill}
      onEditQueuedMessage={onEditQueuedMessage}
      onGuideQueuedMessage={onGuideQueuedMessage}
      onRemoveQueuedMessage={onRemoveQueuedMessage}
      onSend={onSend}
      onCancel={onCancel}
    />
  );

  return (
    <div className="welcome-composer" ref={welcomeRef}>
      <div className="welcome-hero">
        <StarWordmark />
        <h2>
          {selectedProjectDir
            ? language === 'zh'
              ? `你想在 ${selectedProjectTitle} 中做些什么？`
              : `What would you like to do in ${selectedProjectTitle}?`
            : language === 'zh' ? '你想做些什么？' : 'What would you like to do?'}
        </h2>
        <WelcomeSuggestions language={language} disabled={sending} hasDraft={Boolean(draft.trim())} onSelect={selectSuggestion} />
      </div>
      <div className="welcome-input-stack">
        {workspaceControl !== undefined ? workspaceControl : <WelcomeProjectSwitcher
          language={language}
          projects={availableProjects}
          selectedProjectDir={selectedProjectDir}
          disabled={sending}
          onSelect={onProjectChange}
        />}
        {welcomeComposer}
      </div>
    </div>
  );
}

export function WelcomeProjectSwitcher({ language, projects, selectedProjectDir, disabled, onSelect }: {
  language: AppLanguage; projects: ProjectItem[]; selectedProjectDir: string; disabled: boolean;
  onSelect: (projectDir: string | null) => Promise<void>;
}) {
  return <WorkspaceLocationButton language={language} projects={projects} root={selectedProjectDir} disabled={disabled} onSelect={onSelect} />;
}
