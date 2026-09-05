import { Check, Folder, LoaderCircle, Monitor, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QueuedChatMessage } from '../../hooks/useCardbushChat';
import { Composer } from '../composer';
import { samePath } from '../../shared/localPaths';
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
  onlyTalkMode = false,
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
  goalAvailable,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  subagentPermissionRouting,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  activeProjectDir,
  selectedProjectDir,
  availableProjects,
  onProjectChange,
  projectContext,
  skills = [],
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  gitAvailable,
  onToggleSkill,
  onVisualInputEnabledChange,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSubagentPermissionRoutingChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onSend,
  onCancel,
}: {
  language: AppLanguage;
  onlyTalkMode?: boolean;
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
  goalAvailable: boolean;
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  subagentPermissionRouting: SubagentPermissionRouting;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  activeProjectDir?: string;
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onProjectChange: (projectDir: string | null) => Promise<void>;
  projectContext: string;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  gitAvailable: boolean;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSubagentPermissionRoutingChange: (value: SubagentPermissionRouting) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onEditQueuedMessage: (item: QueuedChatMessage) => void;
  onGuideQueuedMessage: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const welcomeComposer = (
    <Composer
      compact
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
      activeProjectDir={activeProjectDir}
      projectContext={projectContext}
      skills={skills}
      disabledSkillNames={disabledSkillNames}
      visualInputAvailable={visualInputAvailable}
      visualInputEnabled={visualInputEnabled}
      gitAvailable={gitAvailable}
      onToggleSkill={onToggleSkill}
      onVisualInputEnabledChange={onVisualInputEnabledChange}
      onSaveProjectContext={onSaveProjectContext}
      onEditQueuedMessage={onEditQueuedMessage}
      onGuideQueuedMessage={onGuideQueuedMessage}
      onRemoveQueuedMessage={onRemoveQueuedMessage}
      onSend={onSend}
      onCancel={onCancel}
    />
  );

  return (
    <div className="welcome-composer">
      <div className="welcome-hero">
        <span className="welcome-hero-mark" aria-hidden="true">
          <img className="welcome-hero-logo" src="./cardbush-logo.png" alt="" />
        </span>
        <h2>
          {onlyTalkMode
            ? language === 'zh'
              ? '你想聊些什么？'
              : 'What would you like to talk about?'
            : language === 'zh'
              ? `你想让我们在 ${selectedProjectDir ? (availableProjects.find((project) => samePath(project.rootPath, selectedProjectDir))?.title || 'cardbush') : 'cardbush'} 中构建什么？`
              : `What do you want us to build in ${selectedProjectDir ? (availableProjects.find((project) => samePath(project.rootPath, selectedProjectDir))?.title || 'cardbush') : 'cardbush'}?`}
        </h2>
      </div>
      <div className={`welcome-input-stack${onlyTalkMode ? ' only-talk' : ''}`}>
        {!onlyTalkMode && (
          <WelcomeProjectSwitcher
            language={language}
            projects={availableProjects}
            selectedProjectDir={selectedProjectDir}
            disabled={sending}
            onSelect={onProjectChange}
          />
        )}
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
    if (disabled) return;
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
              aria-checked={!selectedProject}
              disabled={busy || disabled}
              onClick={() => void selectProject(null)}
            >
              <X size={14} />
              <span>{language === 'zh' ? '不在项目中工作' : 'Work without a project'}</span>
              {!selectedProject && <Check size={14} />}
            </button>
          </div>
        </div>
      )}
      <button
        className="welcome-project-trigger"
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? <LoaderCircle className="spinning" size={14} /> : <Folder size={14} />}
        <span>{selectedProject?.title || (language === 'zh' ? '不在项目中' : 'No project')}</span>
      </button>
      {selectedProject && (
        <span className="welcome-project-context-meta" aria-label={language === 'zh' ? '本地项目' : 'Local project'}>
          <Monitor size={13} aria-hidden="true" />
          <span>{language === 'zh' ? '本地' : 'Local'}</span>
        </span>
      )}
    </div>
  );
}
