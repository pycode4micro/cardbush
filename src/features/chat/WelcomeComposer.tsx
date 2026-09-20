import { Check, Folder, LoaderCircle, Monitor, Search, X } from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
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
  onSend: (text: string, options?: { immediate?: boolean }) => Promise<void>;
  onCancel: () => Promise<void>;
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
        <WelcomeProjectSwitcher
          language={language}
          projects={availableProjects}
          selectedProjectDir={selectedProjectDir}
          disabled={sending}
          onSelect={onProjectChange}
        />
        {welcomeComposer}
      </div>
    </div>
  );
}

function WelcomeProjectSwitcher({
  language,
  projects,
  selectedProjectDir,
  disabled,
  onSelect,
}: {
  language: AppLanguage;
  projects: ProjectItem[];
  selectedProjectDir: string;
  disabled: boolean;
  onSelect: (projectDir: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedProject = projects.find((project) =>
    samePath(project.rootPath, selectedProjectDir),
  );
  const hasProject = Boolean(selectedProjectDir.trim());
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = projects.filter((project) =>
    !normalizedQuery || `${project.title} ${project.rootPath}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (!open) return undefined;
    const closeFromPointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeFromPointer);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromPointer);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  async function selectProject(projectDir: string | null) {
    if (disabled || busy) return;
    setBusy(true);
    try {
      await onSelect(projectDir);
      setOpen(false);
      setQuery('');
    } catch {
      // The shared conversation error banner reports project update failures.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome-project-switcher" ref={rootRef}>
      {open && (
        <div className="welcome-project-menu" role="menu">
          <label className="welcome-project-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={language === 'zh' ? '搜索项目' : 'Search projects'}
            />
          </label>
          <div className="welcome-project-options">
            {filteredProjects.map((project) => {
              const selected = samePath(project.rootPath, selectedProjectDir);
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={busy || disabled}
                  onClick={() => void selectProject(project.rootPath)}
                >
                  <Folder size={14} />
                  <span>{project.title}</span>
                  {selected && <Check size={14} />}
                </button>
              );
            })}
            {filteredProjects.length === 0 && (
              <div className="welcome-project-empty">
                {language === 'zh' ? '没有匹配的项目' : 'No matching projects'}
              </div>
            )}
          </div>
          <div className="welcome-project-menu-footer">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!hasProject}
              disabled={busy || disabled}
              onClick={() => void selectProject(null)}
            >
              <X size={14} />
              <span>{language === 'zh' ? '不关联项目' : 'No project'}</span>
              {!hasProject && <Check size={14} />}
            </button>
          </div>
        </div>
      )}
      <button
        className="welcome-project-trigger"
        type="button"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? <LoaderCircle className="spinning" size={14} /> : <Folder size={14} />}
        <span>{selectedProject?.title || (hasProject ? basename(selectedProjectDir) : language === 'zh' ? '关联项目' : 'Link a project')}</span>
      </button>
      {hasProject && (
        <span className="welcome-project-context-meta" aria-label={language === 'zh' ? '本地项目' : 'Local project'}>
          <Monitor size={13} aria-hidden="true" />
          <span>{language === 'zh' ? '本地' : 'Local'}</span>
        </span>
      )}
    </div>
  );
}
