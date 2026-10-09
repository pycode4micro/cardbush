import { useConversationSource } from '../settings/conversationSource';
import { VoiceButton } from '../voice/VoiceConversation';
import { useVoiceComposer, VoiceComposerPanel } from '../voice/VoiceComposer';
import { useIndividuation } from '../settings/useIndividuation';
import { useConversationStyle } from '../settings/useConversationStyle';
import { conversationStyleName, conversationStylePresets } from '../settings/conversationStyle';
import { usePluginCatalog } from '../plugins/pluginCatalog';
import { useApplications } from '../appCenter/appCenterStore';
import { applicationReference } from '../appCenter/appCenterModel';
import { ApplicationIcon } from '../appCenter/AppCenter';
import { ConversationHostContext } from '../conversationHost';
import { ComposerPortalContext } from './ComposerPortalContext';
import { ComposerPresentationContext } from './ComposerPresentationContext';
import { useComponents } from '../components/componentStore';
import { welcomeInputStyle } from '../components/componentModel';
import './composerPresentation.css';
import { ComposerCommandPortal } from './ComposerCommandPortal';
import { useSshConnections } from '../ssh/SshConnectionsPanel';
import { pickWorkspace } from '../ssh/WorkspaceLocationPicker';
import { parseSshWorkspace, protocolReasoningEffort, reasoningEffortsForProtocol } from '@cardbush/bush-protocol';
import { modelProtocolInfo } from '../settings/modelProtocols';
import { pluginReference } from '../plugins/pluginPrompts';
import { PluginGlyph } from '../plugins/PluginGlyph';
import { ComposerReferenceContext, referenceableUserMessages } from './ComposerReferenceContext';
import { ConversationExtractionContext, CONVERSATION_DRAG_TYPE, ExtractionBulbs } from '../chat/ConversationExtraction';
import { promptReferenceMarkdown, selectedTeamReference, withTeamReference, type TeamPromptReference } from '../../shared/promptReferences';
import { openPromptReference } from './PromptReferenceLink';
import { ComposerPromptInput, type ComposerPromptInputHandle } from './ComposerPromptInput';
import { useComposerMultiline } from './useComposerMultiline';
import { pastedTextSummary } from './pastedText';
import { useFileDropZone } from './useFileDropZone';
import { showUiError } from '../../shared/showUiError';
import { normalizePermissionMode, permissionModeOptions } from '../../shared/permissionModes';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { QueueActionsMenu } from './QueueActionsMenu';
import {
  ArrowRight,
  ArrowUp,
  Box,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Circle,
  Clock3,
  CornerDownLeft,
  Edit3,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  ListOrdered,
  LoaderCircle,
  Lock,
  MessageSquare,
  Paperclip,
  Quote,
  Plus,
  Presentation,
  Puzzle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Square,
  Target,
  Trash2,
  Unlock,
  UsersRound,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  Fragment,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  basename,
  fileUrl,
  isImagePath,
} from '../../shared/localPaths';
import type {
  AppLanguage,
  ManagedModelConfig,
  PermissionMode,
  SubagentPermissionRouting,
  ReasoningLevel,
  ReferencePlanMode,
  SkillSummary,
  PluginCommandSummary,
} from '../../types';
import { ImagePreviewDialog, type ImagePreviewSource as ImagePreview } from '../chatMessages';
import { openInspector } from '../inspector/inspectorEvents';
import { SkillIcon } from '../skills/SkillIcon';
import { skillReference } from '../skills/skillReferences';
import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import { modelLogoFor } from './modelLogos';
import type { QuickLoadPayload } from './quickLoad';
import { useTeamWorkspace, selectTeam } from '../team/teamWorkspaceStore';
import { conversationViewKey, useConversationViewState } from '../../shared/conversationViewState';
import { useRuntimeStartupStatus } from '../../shared/useRuntimeStartupStatus';

type ComposerImageAttachment = {
  id: string;
  path: string;
  name: string;
  previewUrl: string;
};

type ComposerFileAttachment = {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size?: number;
  pastedText?: { id: string; lines: number; preview: string };
};

type ComposerQueuedMessage = {
  id: string;
  text: string;
  createdAt: string;
};

type ComposerMenu =
  | 'more'
  | 'skills'
  | 'models'
  | 'permissions'
  | 'teams'
  | null;

export type ContextWindowUsage = {
  usedTokens?: number;
  maxTokens?: number;
  remainingTokens?: number;
  measuredAt?: string;
};

type ComposerCommandMode = 'slash' | 'plugin' | 'mention' | 'style';

type ComposerCommandState = {
  mode: ComposerCommandMode;
  start: number;
  end: number;
  query: string;
};

type ComposerCommandItem = {
  category?: 'ssh' | 'actions' | 'apps' | 'plugins' | 'skills' | 'commands' | 'files' | 'browser' | 'turns' | 'extracts';
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  disabled?: boolean;
  value?: string;
  run?: () => void | Promise<void>;
  searchText?: string;
};

type ComposerPopoverPlacement = 'below' | 'above';

type ComposerPopoverAnchor = {
  x: number;
  y: number;
  width: number;
  placement: ComposerPopoverPlacement;
};

const composerPopoverWidths: Record<Exclude<ComposerMenu, null>, number> = {
  more: 320,
  skills: 336,
  models: 300,
  permissions: 274,
  teams: 320,
};

function imageAttachmentFromPath(pathValue: string): ComposerImageAttachment {
  return {
    id: `image-${crypto.randomUUID()}`,
    path: pathValue,
    name: basename(pathValue),
    previewUrl: fileUrl(pathValue),
  };
}

function fileAttachmentFromPath(
  pathValue: string,
  metadata?: { name?: string; kind?: 'file' | 'folder'; size?: number },
): ComposerFileAttachment {
  return {
    id: `file-${crypto.randomUUID()}`,
    path: pathValue,
    name: metadata?.name?.trim() || basename(pathValue),
    kind: metadata?.kind ?? 'file',
    size: Number.isFinite(metadata?.size) ? metadata?.size : undefined,
  };
}

function fileExtension(value: string) {
  const extension = basename(value).match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
  return extension.slice(0, 5);
}

function fileIconKind(extension: string) {
  if (/^(?:xls|xlsx|xlsm|csv|tsv|ods)$/.test(extension)) return 'sheet';
  if (/^(?:ppt|pptx|pps|ppsx|odp|key)$/.test(extension)) return 'slides';
  if (/^(?:zip|rar|7z|tar|gz|bz2|xz)$/.test(extension)) return 'archive';
  if (/^(?:js|jsx|ts|tsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|html|css|scss|json|xml|yaml|yml|toml|sql|sh|ps1)$/.test(extension)) return 'code';
  if (/^(?:doc|docx|odt|rtf|txt|md|pdf)$/.test(extension)) return 'document';
  return 'file';
}

function ComposerFileIcon({ name, kind }: { name: string; kind: 'file' | 'folder' }) {
  const extension = fileExtension(name);
  const iconKind = kind === 'folder' ? 'folder' : fileIconKind(extension);
  const icon = iconKind === 'folder'
    ? <FolderOpen size={23} />
    : iconKind === 'sheet'
    ? <FileSpreadsheet size={22} />
    : iconKind === 'slides'
      ? <Presentation size={22} />
      : iconKind === 'archive'
        ? <FileArchive size={22} />
        : iconKind === 'code'
          ? <FileCode2 size={22} />
          : iconKind === 'document'
            ? <FileText size={22} />
            : <FileIcon size={22} />;
  return (
    <span className={`composer-file-icon ${iconKind}`} aria-hidden="true">
      {icon}
      <em>{kind === 'folder' ? 'FOLDER' : extension ? extension.toUpperCase() : 'FILE'}</em>
    </span>
  );
}

function formatFileSize(size?: number) {
  if (!Number.isFinite(size) || size == null || size < 0) {
    return '—';
  }
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function composerPopoverAnchorFromTrigger(
  trigger: HTMLElement,
  menu: Exclude<ComposerMenu, null>,
): ComposerPopoverAnchor {
  const rect = trigger.getBoundingClientRect();
  const gap = 8;
  const padding = 10;
  const width = Math.min(
    composerPopoverWidths[menu],
    Math.max(180, window.innerWidth - padding * 2),
  );
  const roomBelow = window.innerHeight - rect.bottom - padding;
  const placement: ComposerPopoverPlacement = roomBelow >= 170 ? 'below' : 'above';
  const targetY = placement === 'below' ? rect.bottom + gap : rect.top - gap;
  const targetX = rect.left;
  return {
    x: Math.max(padding, Math.min(targetX, window.innerWidth - width - padding)),
    y: placement === 'below'
      ? Math.max(padding, targetY)
      : Math.min(window.innerHeight - padding, targetY),
    width,
    placement,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  compact,
  fileDropTarget,
  autoFocus = false,
  language,
  draft,
  onDraftChange,
  sending,
  stopping = false,
  guidanceDeliveryMode = 'queue',
  queuedMessageCount = 0,
  queuedMessagePreview = '',
  queuedMessages = [],
  queueLocked = false,
  queueLockPending = false,
  onToggleQueueLock,
  selectedModel,
  availableModels,
  goalAvailable = false,
  teamAvailable = false,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  subagentPermissionRouting,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSubagentPermissionRoutingChange,
  onReasoningLevelChange,
  onSend,
  onCancel,
  cancelEnabled = true,
  skills = [],
  disabledSkillNames,
  onQuickLoad,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onShowQueue,
  onConfigureModels,
  onCreateConversation,
  onToggleSkill,
  shadowActive = false,
  shadowAvailable = false,
  shadowAgentName,
  onToggleShadow,
  contextWindow,
  submissionPending = false,
  inputReadOnly = false,
  portalCommands = false,
  retainUntilAccepted = false,
}: {
  compact?: boolean;
  fileDropTarget?: React.RefObject<HTMLElement | null>;
  autoFocus?: boolean;
  language: AppLanguage;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  stopping?: boolean;
  guidanceDeliveryMode?: 'queue' | 'immediate';
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: ComposerQueuedMessage[];
  queueLocked?: boolean;
  queueLockPending?: boolean;
  onToggleQueueLock?: () => void;
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  goalAvailable?: boolean;
  teamAvailable?: boolean;
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  subagentPermissionRouting: SubagentPermissionRouting;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSubagentPermissionRoutingChange: (value: SubagentPermissionRouting) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onSend: (text: string, options?: { immediate?: boolean }) => Promise<void | boolean>;
  onCancel: () => Promise<void>;
  cancelEnabled?: boolean;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  onQuickLoad?: (payload: QuickLoadPayload) => void;
  onEditQueuedMessage?: (item: ComposerQueuedMessage) => void;
  onGuideQueuedMessage?: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage?: (queuedId: string) => void;
  onShowQueue?: () => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  shadowActive?: boolean;
  shadowAvailable?: boolean;
  shadowAgentName?: string;
  onToggleShadow?: () => void;
  contextWindow?: ContextWindowUsage;
  submissionPending?: boolean;
  inputReadOnly?: boolean;
  portalCommands?: boolean;
  retainUntilAccepted?: boolean;
}) {
  const host = useContext(ConversationHostContext);
  const portalTarget = useContext(ComposerPortalContext);
  const presentation = useContext(ComposerPresentationContext);
  const components = useComponents();
  const simple = (presentation?.style ?? welcomeInputStyle(components)) === 'simple';
  const initializePermissions = Boolean(presentation && !presentation.preview && !presentation.preservePermissions);
  const simplePermissionInitialized = useRef(false);
  useEffect(() => {
    // Continuing a conversation changes presentation only, preserving its permissions.
    if (!initializePermissions) return;
    if (!simple) {
      simplePermissionInitialized.current = false;
    } else if (!simplePermissionInitialized.current) {
      // Apply the default on entry, without overwriting later permission changes.
      simplePermissionInitialized.current = true;
      if (permissionMode !== 'all_free') onPermissionModeChange('all_free');
    }
  }, [simple, initializePermissions, permissionMode, onPermissionModeChange]);
  const runtimeStartup = useRuntimeStartupStatus(!host);
  const keyboardShortcuts = useKeyboardShortcuts();
  const immediatePendingRef = useRef(false);
  const immediateHandlerRef = useRef<(fromQueue?: boolean) => Promise<void>>(async () => {});
  const runtimeReady = runtimeStartup.phase === 'ready';
  const runtimeStartupFailed = runtimeStartup.phase === 'error';
  const composerStackRef = useRef<HTMLDivElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const voiceComposer = useVoiceComposer(!presentation?.preview, composerSurfaceRef);
  const textareaRef = useRef<ComposerPromptInputHandle>(null);
  useEffect(() => {
    if (!portalTarget || presentation?.preview) return;
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [portalTarget, presentation?.preview]);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [commandState, setCommandState] = useState<ComposerCommandState | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  useEffect(() => { if (voiceComposer.visible) { setActiveMenu(null); setCommandState(null); } }, [voiceComposer.visible]);
  const plugins = usePluginCatalog();
  const applications = useApplications(language);
  const [pluginCommands, setPluginCommands] = useState<PluginCommandSummary[]>([]);
  const referenceContext = useContext(ComposerReferenceContext);
  const source = useConversationSource(referenceContext.sessionId, host?.environmentId ?? host?.id ?? '');
  const conversationStyle = useConversationStyle(referenceContext.sessionId, host?.environmentId ?? host?.id ?? '');
  const styleAvailable = host?.conversationStyleAvailable !== false;
  const styleOptions = [
    { value: '', label: (language === 'zh' ? '默认 · ' : 'Default · ') + conversationStyleName(conversationStyle.preferences.defaultId, conversationStyle.preferences, language) },
    ...[...conversationStylePresets, ...conversationStyle.preferences.styles].map(style => ({ value: style.id, label: conversationStyleName(style.id, conversationStyle.preferences, language) })),
  ];
  const sshConnections = useSshConnections(!host);
  const extraction = useContext(ConversationExtractionContext);
  const draftForExtraction = useRef({ draft, onDraftChange });
  draftForExtraction.current = { draft, onDraftChange };
  const insertExtraction = (text: string) => {
    const current = draftForExtraction.current;
    current.onDraftChange(`${current.draft}${current.draft && !/\s$/.test(current.draft) ? ' ' : ''}${text} `);
    textareaRef.current?.focus();
  };
  useEffect(() => {
    if (host) { setPluginCommands(host.pluginCommands); return; }
    const desktop = window.cardbushDesktop;
    if (!desktop?.pluginCommands) return;
    let active = true, generation = 0;
    const refresh = () => {
      const revision = ++generation;
      void desktop.pluginCommands().then(commands => { if (active && revision === generation) setPluginCommands(commands); })
        .catch(() => { /* Retain the last successful catalog during a transient refresh failure. */ });
    };
    refresh();
    const unsubscribe = desktop.onCapabilityCatalogChanged?.(refresh);
    window.addEventListener('focus', refresh);
    return () => { active = false; unsubscribe?.(); window.removeEventListener('focus', refresh); };
  }, [host]);
  const attachmentKey = conversationViewKey(host?.id, referenceContext.sessionId, 'attachments');
  const [imageAttachments, setImageAttachments] = useConversationViewState<ComposerImageAttachment[]>(`${attachmentKey}:images`, () => [], value => value.length > 0);
  const [fileAttachments, setFileAttachments] = useConversationViewState<ComposerFileAttachment[]>(`${attachmentKey}:files`, () => [], value => value.length > 0);
  const [attachmentUploads, setAttachmentUploads, currentAttachmentUploads] = useConversationViewState(`${attachmentKey}:uploads`, () => 0, value => value > 0);
  const pastedTextApi = host ? host.pastedTextAttachments : window.cardbushDesktop?.pastedTextAttachments;
  const [, rememberDraft, currentSubmittedDraft] = useConversationViewState(`${attachmentKey}:text`, () => draft, value => Boolean(value));
  useLayoutEffect(() => { rememberDraft(draft); }, [draft, rememberDraft]);
  const dropTargetRef = fileDropTarget ?? composerStackRef;
  const fileDragActive = useFileDropZone(dropTargetRef, transfer => {
    void handleDrop(transfer).catch(error => showUiError(
      language === 'zh' ? '无法添加附件' : 'Unable to add attachments',
      error instanceof Error ? error.message : String(error),
    ));
  });
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
  const [popoverAnchor, setPopoverAnchor] = useState<ComposerPopoverAnchor | null>(null);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const [cancelReady, setCancelReady] = useState(false);
  const teamWorkspace = useTeamWorkspace(!host && teamAvailable);
  const delegationCommand = teamWorkspace.command ? `/${teamWorkspace.command}` : '';
  const selectedTeam = teamAvailable ? teamWorkspace.choices.find((team) => team.id === teamWorkspace.selectedId) : undefined;
  const draftTeam = selectedTeamReference(draft);
  const teamInsertionCaret = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!teamAvailable) setActiveMenu(menu => menu === 'teams' ? null : menu);
  }, [teamAvailable]);


  const goalDraft = composerGoalDraftPresentation(draft);
  const composerInputValue = goalDraft?.content ?? draft;
  const multilineInput = useComposerMultiline(composerSurfaceRef, composerInputValue,
    voiceComposer.visible ? null : portalTarget ? 'input-only' : simple ? 'simple' : null);
  const hasContent =
    draft.trim().length > 0 ||
    imageAttachments.length > 0 ||
    fileAttachments.length > 0;
  const sendButtonLabel = !runtimeReady
    ? runtimeStartupFailed
      ? language === 'zh' ? 'Runtime 启动失败，点击重试' : 'Runtime failed to start. Click to retry'
      : language === 'zh' ? 'Runtime 正在准备' : 'Runtime is preparing'
    : sending
    ? hasContent
      ? guidanceDeliveryMode === 'immediate'
        ? language === 'zh' ? '马上发送引导' : 'Send guidance now'
        : language === 'zh' ? '加入发送队列' : 'Queue message'
      : stopping
        ? language === 'zh' ? '正在停止' : 'Stopping'
      : cancelReady
        ? language === 'zh' ? '停止生成' : 'Stop generating'
        : language === 'zh' ? '等待任务启动' : 'Waiting for task to start'
    : language === 'zh' ? '发送' : 'Send';

  useEffect(() => {
    if (!sending || !cancelEnabled) {
      setCancelReady(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setCancelReady(true), 600);
    return () => window.clearTimeout(timer);
  }, [cancelEnabled, sending]);


  const updatePopoverMaxHeight = useCallback(() => {
    const topInset = 52;
    const padding = 10;
    if (popoverAnchor) {
      const available =
        popoverAnchor.placement === 'below'
          ? window.innerHeight - popoverAnchor.y - padding
          : popoverAnchor.y - topInset;
      setPopoverMaxHeight(Math.max(180, Math.min(520, Math.floor(available))));
      return;
    }
    const host = composerStackRef.current;
    if (!host) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const gap = 12;
    const availableAbove = Math.max(120, Math.floor(rect.top - topInset - gap));
    setPopoverMaxHeight(Math.min(520, availableAbove));
  }, [popoverAnchor]);

  useEffect(() => {
    if (!activeMenu && !commandState) {
      return undefined;
    }
    updatePopoverMaxHeight();
    const handleResize = () => updatePopoverMaxHeight();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [
    activeMenu,
    commandState,
    draft,
    fileAttachments.length,
    imageAttachments.length,
    updatePopoverMaxHeight,
  ]);

  async function submit(immediate = false) {
    if (submissionPending || currentAttachmentUploads() > 0) return;
    const styleCommand = styleAvailable ? detectComposerCommand(draft, draft.length) : null;
    if (styleCommand?.mode === 'style') {
      if (commandState?.mode === 'style' && commandItems.length) applyCommand(commandItems[Math.min(commandIndex, commandItems.length - 1)]);
      else { setCommandState(styleCommand); focusComposer(); }
      return;
    }
    if (!runtimeReady) {
      if (runtimeStartupFailed) {
        await window.cardbushDesktop?.retryRuntimeStartup?.();
      }
      return;
    }
    if (sending && !hasContent) {
      if (!cancelReady) {
        return;
      }
      await onCancel();
      return;
    }
    if (!hasContent) {
      return;
    }
    if (teamAvailable && delegationCommand && draft.trim().toLowerCase() === delegationCommand.toLowerCase() && imageAttachments.length === 0 && fileAttachments.length === 0) {
      onDraftChange('');
      teamInsertionCaret.current = 0;
      setCommandState(null);
      setPopoverAnchor(null);
      setActiveMenu('teams');
      return;
    }
    const attachmentPaths = [...imageAttachments, ...fileAttachments]
      .map((item) => `@${item.path}`);
    // Capture the default in the submitted prompt too, so queues and history do
    // not silently switch workflows when the workspace default changes later.
    const prompt = !draftTeam && selectedTeam
      ? withTeamReference(draft, { kind: 'team', id: selectedTeam.id, title: selectedTeam.name }).content : draft;
    const value = [...attachmentPaths, prompt.trimEnd()].filter(Boolean).join('\n');
    const pastedIds = fileAttachments.flatMap(file => file.pastedText ? [file.pastedText.id] : []);
    if (pastedIds.length) {
      setAttachmentUploads(current => current + 1);
      try {
        if (!pastedTextApi) throw new Error('Text attachment storage is unavailable.');
        // Retain before handing off: guidance can be queued and a lost network
        // acknowledgement must not let cleanup break a successfully sent reference.
        for (let offset = 0; offset < pastedIds.length; offset += 32) await pastedTextApi.retain(pastedIds.slice(offset, offset + 32));
      } catch (error) {
        showUiError(language === 'zh' ? '无法发送文本附件' : 'Unable to send text attachment', String(error));
        return;
      } finally { setAttachmentUploads(current => current - 1); }
    }
    const submittedIds = new Set([...imageAttachments, ...fileAttachments].map(item => item.id));
    if (host || retainUntilAccepted) {
      if (await onSend(value, immediate ? { immediate: true } : undefined) === false) return;
      if (currentSubmittedDraft() === draft) onDraftChange('');
      setImageAttachments(current => current.filter(item => !submittedIds.has(item.id)));
      setFileAttachments(current => current.filter(item => !submittedIds.has(item.id)));
      return;
    }
    if (currentSubmittedDraft() === draft) onDraftChange('');
    setImageAttachments(current => current.filter(item => !submittedIds.has(item.id)));
    setFileAttachments(current => current.filter(item => !submittedIds.has(item.id)));
    await onSend(value, immediate ? { immediate: true } : undefined);
  }

  function toggleMenu(menu: Exclude<ComposerMenu, null>, event?: React.MouseEvent<HTMLElement>) {
    if (menu === 'teams') teamInsertionCaret.current = draft.length;
    if (event?.currentTarget) {
      setPopoverAnchor(composerPopoverAnchorFromTrigger(event.currentTarget, menu));
    }
    setActiveMenu((current) => {
      if (current === menu) {
        setPopoverAnchor(null);
        return null;
      }
      return menu;
    });
    setCommandState(null);
  }

  function loadPayload(payload: QuickLoadPayload) {
    if (payload.kind === 'file' && payload.value.trim()) {
      const pathValue = payload.value.trim();
      void addAttachmentPaths([pathValue]);
      setActiveMenu(null);
      setPopoverAnchor(null);
      setCommandState(null);
      return;
    }
    onQuickLoad?.(payload);
    setActiveMenu(null);
    setPopoverAnchor(null);
    setCommandState(null);
  }

  async function addAttachmentPaths(paths: string[]) {
    if (host) { onDraftChange([...paths.map(path => `@${path}`), draft].join('\n')); return; }
    const identity = (path: string) => path.startsWith('ssh://') ? path : path.toLowerCase();
    const uniquePaths = [...new Set(paths.map((value) => value.trim()).filter(Boolean))]
      .slice(0, 32);
    if (uniquePaths.length === 0) {
      return;
    }
    const inspected = await window.cardbushDesktop
      ?.inspectAttachments?.(uniquePaths)
      .catch(() => []);
    const metadataByPath = new Map(
      (inspected ?? []).map((item) => [identity(item.path), item]),
    );
    const imagePaths = uniquePaths.filter((pathValue) => {
      const metadata = metadataByPath.get(identity(pathValue));
      return !pathValue.startsWith('ssh://') && metadata?.kind !== 'folder' && isImagePath(pathValue);
    });
    if (imagePaths.length > 0) {
      setImageAttachments((current) => {
        const existing = new Set(current.map((item) => identity(item.path)));
        return [
          ...current,
          ...imagePaths
            .filter((pathValue) => !existing.has(identity(pathValue)))
            .map((pathValue) => imageAttachmentFromPath(pathValue)),
        ];
      });
    }
    const imagePathSet = new Set(imagePaths.map((pathValue) => identity(pathValue)));
    const filePaths = uniquePaths.filter(
      (pathValue) => !imagePathSet.has(identity(pathValue)),
    );
    if (filePaths.length === 0) {
      return;
    }
    setFileAttachments((current) => {
      const existing = new Set(current.map((item) => identity(item.path)));
      return [
        ...current,
        ...filePaths
          .filter((pathValue) => !existing.has(identity(pathValue)))
          .map((pathValue) =>
            fileAttachmentFromPath(
              pathValue,
              metadataByPath.get(identity(pathValue)),
            ),
          ),
      ];
    });
  }

  useEffect(() => {
    if (!activeMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.composer-popover') ||
        target.closest('[data-composer-menu-trigger="true"]')
      ) {
        return;
      }
      setActiveMenu(null);
      setPopoverAnchor(null);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [activeMenu]);

  useEffect(() => {
    if (!commandState) {
      return undefined;
    }
    function closeCommandOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (composerStackRef.current?.contains(target)) {
        return;
      }
      setCommandState(null);
    }
    document.addEventListener('pointerdown', closeCommandOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeCommandOnOutsidePointer, true);
    };
  }, [commandState]);

  async function handleDrop(transfer: DataTransfer) {
    if (host) { await addTransferredFiles([...transfer.files]); return; }
    const sessionId = transfer.getData(CONVERSATION_DRAG_TYPE);
    if (sessionId && extraction) { insertExtraction(await extraction.referenceSession(sessionId)); return; }
    const raw = transfer.getData('application/x-cardbush-quickload');
    if (raw) {
      try {
        loadPayload(JSON.parse(raw) as QuickLoadPayload);
      } catch {
        const text = transfer.getData('text/plain');
        if (text.trim()) {
          onDraftChange(draft.trim() ? `${draft.trimEnd()}\n${text}` : text);
        }
      }
      return;
    }
    const files = [...transfer.files];
    if (files.length === 0) {
      return;
    }
    await addTransferredFiles(files);
    textareaRef.current?.focus();
  }

  async function pickAttachments() {
    if (host) {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
      input.onchange = () => { void addTransferredFiles([...input.files ?? []]).catch(error => showUiError(language === 'zh' ? '附件上传失败' : 'Upload failed', String(error))); };
      input.click(); return;
    }
    const paths = await window.cardbushDesktop?.pickAttachments?.();
    if (!paths || paths.length === 0) {
      return;
    }
    await addAttachmentPaths(paths);
  }

  async function pasteAttachments(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files];
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    await addTransferredFiles(files);
  }

  function capturePastedText(event: React.ClipboardEvent<HTMLDivElement>) {
    if (inputReadOnly || submissionPending) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.clipboardData.files.length) return;
    const text = event.clipboardData.getData('text/plain');
    const summary = pastedTextSummary(text);
    if (!summary.attach) return;
    // Capture before either textarea or rich-editor paste handling inserts text.
    event.preventDefault(); event.stopPropagation();
    void attachPastedText(text, summary).catch(error => showUiError(
      language === 'zh' ? '未能保存粘贴文本，原文仍在剪贴板中，可重试粘贴' : 'Could not save pasted text. It remains on the clipboard; try pasting again.', String(error)));
  }

  async function attachPastedText(text: string, summary: ReturnType<typeof pastedTextSummary>) {
    if (!pastedTextApi) throw new Error(language === 'zh' ? '请更新并重启 CardBush / Agent 服务以使用文本附件。' : 'Update and restart CardBush / the Agent service to attach pasted text.');
    setAttachmentUploads(current => current + 1);
    try {
      const saved = await pastedTextApi.create(text);
      setFileAttachments(current => [...current, {
        ...fileAttachmentFromPath(saved.path, { name: saved.name, size: saved.size }),
        pastedText: { id: saved.id, lines: summary.lines, preview: summary.preview },
      }]);
    } finally { setAttachmentUploads(current => current - 1); }
  }

  async function removeFileAttachment(file: ComposerFileAttachment) {
    if (file.pastedText) {
      if (!pastedTextApi) throw new Error('Text attachment storage is unavailable.');
      await pastedTextApi.discard(file.pastedText.id);
    }
    setFileAttachments(current => current.filter(item => item.id !== file.id));
  }

  async function addTransferredFiles(files: File[]) {
    if (host) {
      setAttachmentUploads(current => current + 1);
      try {
        const uploaded = await host.uploadFiles(files);
        const images: ComposerImageAttachment[] = [];
        const attachments: ComposerFileAttachment[] = [];
        for (const [index, file] of uploaded.entries()) {
          const attachment = { id: crypto.randomUUID(), path: file.path, name: file.name };
          if (isImagePath(file.path) && files[index]) {
            images.push({ ...attachment, previewUrl: await readFileAsDataUrl(files[index]) });
          } else attachments.push({ ...attachment, kind: 'file' });
        }
        setImageAttachments(current => [...current, ...images]);
        setFileAttachments(current => [...current, ...attachments]);
      } finally { setAttachmentUploads(current => current - 1); }
      return;
    }
    const pathBacked: string[] = [];
    const transientImages: File[] = [];
    for (const file of files.slice(0, 32)) {
      const pathValue = pathForTransferredFile(file);
      if (pathValue) {
        pathBacked.push(pathValue);
      } else if (file.type.startsWith('image/')) {
        transientImages.push(file);
      }
    }
    if (pathBacked.length > 0) {
      await addAttachmentPaths(pathBacked);
    }
    if (transientImages.length === 0) {
      return;
    }
    if (!window.cardbushDesktop?.saveImageDataUrl) {
      return;
    }
    try {
      const saved = await Promise.all(
        transientImages.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          const result = await window.cardbushDesktop!.saveImageDataUrl(
            dataUrl,
            file.name || 'cardbush-paste',
          );
          return {
            id: `image-${crypto.randomUUID()}`,
            path: result.path,
            name: file.name || result.name,
            previewUrl: dataUrl,
          };
        }),
      );
      setImageAttachments((current) => [...current, ...saved]);
    } catch (caught) {
      console.warn(caught);
    }
  }

  function pathForTransferredFile(file: File): string {
    try {
      return window.cardbushDesktop?.getPathForFile?.(file)?.trim() ?? '';
    } catch {
      return '';
    }
  }

  function selectModel(model: string) {
    onModelChange(model);
    setActiveMenu(null);
    setPopoverAnchor(null);
  }

  function focusComposer(nextCaret?: number) {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (nextCaret != null) {
        textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  function replaceCommandToken(replacement: string) {
    const state = commandState;
    if (!state) {
      return;
    }
    const before = draft.slice(0, state.start);
    const after = draft.slice(state.end);
    const next = `${before}${replacement}${after}`;
    onDraftChange(next);
    setCommandState(null);
    if (replacement === '/style ') setCommandState({ mode: 'style', start: before.length, end: before.length + replacement.length, query: '' });
    focusComposer(before.length + replacement.length);
  }

  function removeCommandToken(restoreFocus = true) {
    const state = commandState;
    if (!state) {
      return;
    }
    const before = draft.slice(0, state.start);
    const after = draft.slice(state.end);
    const needsTrim = before.endsWith(' ') && after.startsWith(' ');
    const next = `${before}${needsTrim ? after.trimStart() : after}`;
    onDraftChange(next);
    setCommandState(null);
    if (restoreFocus) focusComposer(before.length);
  }

  function chooseTeam(reference?: TeamPromptReference) {
    const next = withTeamReference(draft, reference, teamInsertionCaret.current);
    if (!reference) selectTeam('');
    onDraftChange(next.content);
    setActiveMenu(null);
    setPopoverAnchor(null);
    setCommandState(null);
    teamInsertionCaret.current = undefined;
    focusComposer(next.caret);
  }

  const pluginCommandItems = useMemo<ComposerCommandItem[]>(() => plugins.map(plugin => ({
    id: `$${plugin.id}`, title: plugin.name, category: 'plugins',
    subtitle: `${plugin.enabled ? '' : language === 'zh' ? '已停用 · ' : 'Disabled · '}${plugin.description}`,
    icon: <PluginGlyph plugin={plugin} />, value: `${pluginReference(plugin)} `,
    searchText: `${plugin.id} ${plugin.name} ${plugin.description} ${plugin.keywords.join(' ')}`,
  })), [plugins, language]);

  const slashCommands = useMemo<ComposerCommandItem[]>(
    () => {
      const commands: ComposerCommandItem[] = [
        ...(styleAvailable ? [{ id: '/style', title: '/style', subtitle: language === 'zh' ? '选择当前会话的对话风格' : 'Choose a style for this chat', searchText: 'style 风格 对话 语气', icon: <MessageSquare size={16}/>, value: '/style ' }] : []),
        ...(delegationCommand ? [{
          id: delegationCommand,
          title: language === 'zh' ? '选择 Team' : 'Select Team',
          subtitle: language === 'zh'
            ? '选择已保存的团队流程'
            : 'Choose a saved team workflow',
          icon: <UsersRound size={16} />,
          run: () => {
            setPopoverAnchor(null);
            setActiveMenu('teams');
          },
          searchText: `${delegationCommand} Team 团队 agent`,
        }] : []),
        {
          id: '/model',
          title: language === 'zh' ? '模型切换' : 'Switch model',
          subtitle:
            language === 'zh'
              ? '选择当前会话使用的模型'
              : 'Choose the model used by this conversation',
          icon: <Box size={16} />,
          run: () => {
            setPopoverAnchor(null);
            setActiveMenu('models');
          },
          searchText: '/model 模型切换 switch model',
        },
        {
          id: '/goal',
          title: language === 'zh' ? '目标' : 'Goal',
          subtitle:
            language === 'zh'
              ? '填入命令，通过对话创建或管理目标'
              : 'Insert the command to create or manage a goal in chat',
          icon: <Target size={16} />,
          value: '/goal ',
          searchText: '/goal 目标 goal',
        },
        {
          id: '/skill',
          title: language === 'zh' ? '技能' : 'Skills',
          subtitle:
            language === 'zh'
              ? '查看并选择当前会话启用的技能'
              : 'View and choose skills enabled for this session',
          icon: <Puzzle size={16} />,
          run: () => {
            setPopoverAnchor(null);
            setActiveMenu('skills');
          },
          searchText: '/skill 技能 skill skills',
        },
        {
          id: '/collect',
          title: language === 'zh' ? '总结为技能' : 'Collect as a skill',
          subtitle: language === 'zh'
            ? '将当前会话流程总结为 Skill 并安装'
            : 'Summarize this conversation’s workflow as a skill and install it',
          icon: <Puzzle size={16} />,
          value: language === 'zh'
            ? '根据我们的当前已有的会话信息，帮我总结成 skill 进行安装。'
            : 'Based on our current conversation, summarize the workflow into a skill and install it.',
          searchText: '/collect 收集 总结 流程 技能 安装 collect workflow skill install',
        },
        {
          id: '/new',
          title: language === 'zh' ? '新会话' : 'New conversation',
          subtitle:
            language === 'zh'
              ? '在当前项目中开始一个新会话'
              : 'Start a new conversation in the current project',
          icon: <Edit3 size={16} />,
          run: () => onCreateConversation?.(),
          searchText: '/new 新会话 new conversation',
        },
      ];
      commands.push(...pluginCommandItems);
      commands.push(...pluginCommands.filter(command => command.kind !== 'skill' || (!disabledSkillNames.has(command.id) && !disabledSkillNames.has(command.id.split(':').at(-1)!))).map(command => {
        const plugin = plugins.find(plugin => plugin.id === command.pluginId);
        const skill = skills.find(skill => skill.path === command.path || skill.name === command.id);
        return {
          id: `/${command.id}`, title: skill?.displayName || command.name || command.id.split(':').slice(-1)[0],
          category: command.kind === 'skill' ? 'skills' as const : 'commands' as const,
          subtitle: [plugin?.name, command.description, command.argumentHint].filter(Boolean).join(' · '),
          icon: skill?.logoPath || skill?.logoDarkPath ? <SkillIcon skill={skill} compact /> : <PluginGlyph plugin={plugin} />,
          value: `/${command.id} `, searchText: `${command.id} ${skill?.displayName || ''} ${command.description} ${plugin?.name || ''}`,
        };
      }));
      const commandPaths = new Set(pluginCommands.map(command => command.path));
      commands.push(...skills.filter(skill => !commandPaths.has(skill.path) && !pluginCommands.some(command => command.id === skill.name) &&
        !disabledSkillNames.has(skill.name) && skill.invocationMode !== 'model' && skill.invocationMode !== 'disabled').map(skill => ({
          id: `skill:${skill.name}`, title: skill.displayName || skill.name, category: 'skills' as const,
          subtitle: [skill.sourceLabel, language === 'zh' ? skill.descriptionZh || skill.description : skill.description].filter(Boolean).join(' · '),
          icon: <SkillIcon skill={skill} compact />,
          value: `${skillReference(skill)} `,
          searchText: `${skill.name} ${skill.displayName || ''} ${skill.description} ${skill.descriptionZh || ''}`,
        })));
      return commands.filter(command => (goalAvailable || command.id !== '/goal') && (teamAvailable || command.id !== delegationCommand));
    },
    [
      goalAvailable,
      styleAvailable,
      teamAvailable,
      delegationCommand,
      language,
      onCreateConversation,
      pluginCommands,
      pluginCommandItems,
      plugins,
      skills,
      disabledSkillNames,
    ],
  );

  const commandItems = useMemo(() => {
    if (!commandState) {
      return [];
    }
    const items: ComposerCommandItem[] = commandState.mode === 'style' ? (styleAvailable ? styleOptions.map(option => ({
      id: 'style:' + (option.value || 'default'), title: option.label,
      subtitle: language === 'zh' ? '仅当前会话，从下一轮回复生效' : 'This chat only; applies from the next reply',
      icon: (conversationStyle.override ?? '') === option.value ? <Check size={16}/> : <MessageSquare size={16}/>,
      run: () => conversationStyle.select(option.value || null),
    })) : []) : commandState.mode === 'mention' ? [
      ...applications.map(app => ({ id: `application:${app.id}`, category: 'apps' as const, title: app.title, subtitle: app.description,
        icon: <ApplicationIcon app={app} size={18}/>, value: `${promptReferenceMarkdown(applicationReference(app))} `,
        searchText: `app application 应用 ${app.title} ${app.description}` })),
      ...sshConnections.map(connection => ({
        id: `ssh:${connection.id}`, category: 'ssh' as const, title: connection.name, subtitle: `${connection.username}@${connection.host}`,
        icon: <Globe size={18} />, disabled: !referenceContext.onWorkspaceSelect,
        searchText: `ssh remote 远程 服务器 ${connection.name} ${connection.host}`,
        run: async () => {
          const uri = await pickWorkspace({ language, connectionId: connection.id, projects: referenceContext.projects });
          if (!uri) return;
          try { const target = parseSshWorkspace(uri); await referenceContext.onWorkspaceSelect?.(uri, target ? promptReferenceMarkdown({ kind: 'ssh', ...target, title: (sshConnections.find(item => item.id === target.connectionId)?.name ?? 'SSH') + target.path }) : undefined); }
          catch (error) { void showUiError(language === 'zh' ? 'SSH 连接失败' : 'SSH connection failed', (error as Error).message); }
        },
      })),
      { id: 'ssh:manage', category: 'ssh', title: language === 'zh' ? '连接 SSH 项目…' : 'Connect to an SSH project…', subtitle: language === 'zh' ? '选择连接和远程目录' : 'Choose a connection and directory', icon: <Globe size={18}/>, disabled: !referenceContext.onWorkspaceSelect,
        run: async () => { const uri = await pickWorkspace({ language, projects: referenceContext.projects, remote: true }); if (uri) try { await referenceContext.onWorkspaceSelect?.(uri); } catch (error) { void showUiError(language === 'zh' ? 'SSH 连接失败' : 'SSH connection failed', (error as Error).message); } } },
      { id: 'reference:files', category: 'files', title: language === 'zh' ? '文件和文件夹' : 'Files and folders',
        subtitle: language === 'zh' ? '从电脑中添加附件' : 'Attach from your computer', icon: <Paperclip size={18} />,
        run: pickAttachments, searchText: 'file folder attachment 文件 附件 文件夹' },
      ...referenceContext.browserTabs.map(tab => ({
        id: `browser:${tab.tabId}`, category: 'browser' as const, title: tab.title, subtitle: tab.url,
        icon: <Globe size={18} />, value: `${promptReferenceMarkdown(tab)} `, searchText: `browser 浏览器 ${tab.title} ${tab.url}`,
      })),
      ...(extraction?.permanent ?? []).map(item => ({
        id: `extract:${item.id}`, category: 'extracts' as const, title: item.title, subtitle: item.description,
        icon: <MessageSquare size={18} />, value: `${promptReferenceMarkdown({ kind: 'conversation-extract', id: item.id, title: item.title })} `,
        searchText: `conversation 会话 提取 ${item.title} ${item.description}`,
      })),
      ...referenceableUserMessages(referenceContext.messages, referenceContext.sessionId).map((message, index) => {
        const title = message.content.trim().replace(/\s+/g, ' ').slice(0, 80) || message.attachments?.map(item => item.name).join(', ') || '';
        const turnLabel = language === 'zh' ? `用户指令 ${index + 1}` : `User instruction ${index + 1}`;
        return { id: `turn:${message.messageId}`, category: 'turns' as const, title,
          subtitle: turnLabel, icon: <MessageSquare size={18} />,
          value: `${promptReferenceMarkdown({ kind: 'user-turn', sessionId: referenceContext.sessionId,
            turnId: message.turnId!, messageId: message.messageId!, title })} `,
          searchText: `turn 用户 指令 ${turnLabel} ${message.content}` };
      }).reverse(),
    ] : commandState.mode === 'plugin' ? pluginCommandItems : slashCommands;
    const order = ['actions', 'apps', 'ssh', 'files', 'browser', 'extracts', 'turns', 'plugins', 'skills', 'commands'];
    return rankComposerCommandItems(host ? items.filter(item => item.category !== 'ssh') : items, commandState.query).slice(0, 50)
      .sort((a, b) => order.indexOf(a.category || 'actions') - order.indexOf(b.category || 'actions'));
  }, [commandState, styleAvailable, conversationStyle, slashCommands, pluginCommandItems, referenceContext, extraction?.permanent, language, sshConnections, host, applications]);

  useEffect(() => {
    setCommandIndex(0);
  }, [commandState?.mode, commandState?.query]);

  useEffect(() => {
    setCommandIndex((current) =>
      Math.min(current, Math.max(commandItems.length - 1, 0)),
    );
  }, [commandItems.length]);

  function applyCommand(item: ComposerCommandItem) {
    if (item.disabled) {
      return;
    }
    if (item.run) {
      const openingTeam = item.id === delegationCommand;
      if (openingTeam) teamInsertionCaret.current = commandState?.start ?? draft.length;
      // The Team search box owns keyboard navigation. Do not steal its focus
      // on the next animation frame after React mounts the picker.
      removeCommandToken(!openingTeam);
      void item.run();
      return;
    }
    replaceCommandToken(item.value ?? `${item.title} `);
  }

  function updateCommandFromTextarea(value: string, caret: number | null) {
    const next = detectComposerCommand(value, caret ?? value.length);
    setCommandState(next);
  }

  const hasConfiguredModels = availableModels.length > 0;
  const selectedModelConfig = availableModels.find(
    (config) => config.id === selectedModel,
  ) ?? availableModels.find(
    (config) => config.modelName.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  );
  const modelLabel =
    selectedModelConfig
      ? selectedModelConfig.modelName
      : language === 'zh' ? '待配置' : 'Configure';
  const supportedReasoningLevels: ReasoningLevel[] = reasoningEffortsForProtocol(selectedModelConfig?.apiProtocol);
  const effectiveReasoningLevel = reasoningLevel === 'default' ? 'default' : protocolReasoningEffort(selectedModelConfig?.apiProtocol, reasoningLevel);
  const permissionLabel = permissionModeLabel(permissionMode, language);
  const permissionTitle = permissionModeDescription(permissionMode, language);
  const firstQueuedMessage = queuedMessages[0] ?? null;
  const queuePreview =
    queuedMessagePreview.trim() || firstQueuedMessage?.text.trim() || '';
  const queueLabel =
    queuedMessageCount > 0
      ? language === 'zh'
        ? `排队 ${queuedMessageCount}`
        : `${queuedMessageCount} queued`
      : '';
  const queueHint =
    queueLocked ? language === 'zh' ? '已锁定，仅手动发送' : 'Locked · send manually'
      : language === 'zh' ? '当前回复完成后自动发送' : 'Sends after the current reply';
  const queueTitle = queuedMessagePreview.trim()
    ? `${queueLabel} · ${queueHint}\n${queuePreview}`
    : `${queueLabel} · ${queueHint}`;
  const guideFirstQueuedMessage = async () => {
    if (!firstQueuedMessage || !onGuideQueuedMessage) {
      return;
    }
    setGuidingQueuedId(firstQueuedMessage.id);
    try {
      await onGuideQueuedMessage(firstQueuedMessage.id);
    } finally {
      setGuidingQueuedId('');
    }
  };

  async function sendImmediate(fromQueue = false) {
    if (!runtimeReady || stopping || immediatePendingRef.current || (sending && !cancelEnabled)) return;
    const useQueue = fromQueue || !hasContent;
    if (useQueue && (!firstQueuedMessage || !onGuideQueuedMessage)) return;
    immediatePendingRef.current = true;
    try {
      if (useQueue) await guideFirstQueuedMessage();
      else await submit(true);
    } catch (error) {
      showUiError(language === 'zh' ? '引导发送失败' : 'Unable to send guidance', error instanceof Error ? error.message : String(error));
    } finally { immediatePendingRef.current = false; }
  }
  immediateHandlerRef.current = sendImmediate;

  useEffect(() => {
    const handleImmediate = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !keyboardShortcuts.matches('guideNow', event)) return;
      const root = fileDropTarget?.current ?? composerStackRef.current;
      const target = event.target;
      if (!root || root.closest('[inert]') || !(target instanceof Element) || !root.contains(target) ||
          target.closest('[role="dialog"], [data-shortcut-recorder]')) return;
      if (!composerStackRef.current?.contains(target) && target.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
      event.preventDefault();
      event.stopPropagation();
      void immediateHandlerRef.current(Boolean(target.closest('.queue-context-panel, .runtime-screen-queue-actions, .composer-queue-row')));
    };
    window.addEventListener('keydown', handleImmediate);
    return () => window.removeEventListener('keydown', handleImmediate);
  }, [fileDropTarget, keyboardShortcuts]);

  const composer = (
    <div
      className={`composer-stack ${compact ? 'compact' : ''} ${shadowActive ? 'shadow-active' : ''} ${portalTarget ? 'input-only' : simple ? 'simple' : ''}`}
      ref={composerStackRef}
      style={
        {
          '--composer-popover-max-height': `${popoverMaxHeight}px`,
        } as CSSProperties
      }
    >
      {commandState && (() => {
        const palette = <ComposerCommandPalette
          language={language}
          mode={commandState.mode}
          items={commandItems}
          selectedIndex={commandIndex}
          onSelect={(item) => applyCommand(item)}
        />;
        return portalCommands ? <ComposerCommandPortal anchor={composerStackRef}>{palette}</ComposerCommandPortal> : palette;
      })()}
      {activeMenu &&
        (() => {
          const popover = (
            <ComposerPopover
              menu={activeMenu}
              simpleModels={simple}
              language={language}
              contextWindow={contextWindow}
              skills={skills}
              disabledSkillNames={disabledSkillNames}
              selectedModel={selectedModel}
              availableModels={availableModels}
              permissionMode={permissionMode}
              subagentPermissionRouting={subagentPermissionRouting}
              reasoningLevelAvailable={reasoningLevelAvailable}
              reasoningLevel={effectiveReasoningLevel}
              reasoningLevels={reasoningLevels.filter(level => supportedReasoningLevels.includes(level))}
              reasoningMode={selectedModelConfig?.apiProtocol === 'anthropic_messages' ? selectedModelConfig.anthropicThinkingMode ?? 'adaptive' : 'effort'}
              referencePlanAvailable={referencePlanAvailable}
              referencePlanMode={referencePlanMode}
              sourceEnabled={source.enabled}
              onSourceChange={source.setEnabled}
              onToggleSkill={onToggleSkill}
              onSelectModel={selectModel}
              onSelectPermissionMode={onPermissionModeChange}
              onSelectSubagentPermissionRouting={onSubagentPermissionRoutingChange}
              onSelectReasoningLevel={onReasoningLevelChange}
              onSelectReferencePlanMode={onReferencePlanModeChange}
              selectedTeamId={draftTeam?.id ?? selectedTeam?.id ?? ''}
              onSelectTeam={chooseTeam}
              onConfigureModels={() => {
                setActiveMenu(null);
                setPopoverAnchor(null);
                onConfigureModels();
              }}
              onPickAttachments={() => {
                void pickAttachments();
                setActiveMenu(null);
                setPopoverAnchor(null);
              }}
              onClose={() => {
                setActiveMenu(null);
                setPopoverAnchor(null);
                if (activeMenu === 'teams') focusComposer(teamInsertionCaret.current);
              }}
              anchor={popoverAnchor}
            />
          );
          const portalRoot = document.querySelector<HTMLElement>('.app') ?? document.body;
          return popoverAnchor ? createPortal(popover, portalRoot) : popover;
        })()}
      {previewImage && (
        <ImagePreviewDialog
          image={previewImage}
          images={imageAttachments.map(image => ({ src: image.previewUrl, path: image.path, name: image.name }))}
          initialScope="attachments"
          language={language}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {(queueLabel || queueLocked) && !onShowQueue && (
        <div className="composer-secondary-row composer-queue-row" title={queueTitle}>
          <div className="composer-queue-summary">
            <Clock3 size={13} />
            <span>{queueLocked ? language === 'zh' ? '已锁定' : 'Locked' : queueLabel}</span>
            <small>{queuePreview || queueHint}</small>
          </div>
          <div className="composer-queue-actions">
            {firstQueuedMessage && <>
              <button
                type="button"
                aria-label={language === 'zh' ? '发送排队引导' : 'Send queued message'}
                title={[language === 'zh' ? '发送' : 'Send', keyboardShortcuts.label('guideNow')].filter(Boolean).join(' · ')}
                aria-keyshortcuts={keyboardShortcuts.aria('guideNow')}
                disabled={!onGuideQueuedMessage || guidingQueuedId === firstQueuedMessage.id}
                onClick={() => void guideFirstQueuedMessage()}
              >
                {guidingQueuedId === firstQueuedMessage.id ? (
                  <LoaderCircle size={12} />
                ) : (
                  <CornerDownLeft size={12} />
                )}
                <span>{language === 'zh' ? '发送' : 'Send'}</span>
              </button>
              <button
                type="button"
                aria-label={language === 'zh' ? '删除排队消息' : 'Delete queued message'}
                title={language === 'zh' ? '删除' : 'Delete'}
                disabled={!onRemoveQueuedMessage}
                onClick={() => onRemoveQueuedMessage?.(firstQueuedMessage.id)}
              >
                <Trash2 size={12} />
                <span>{language === 'zh' ? '删除' : 'Delete'}</span>
              </button>
            </>}
            <QueueActionsMenu language={language} locked={queueLocked} lockPending={queueLockPending}
              onToggleLock={onToggleQueueLock} busy={Boolean(guidingQueuedId)}
              onEdit={firstQueuedMessage && onEditQueuedMessage ? () => onEditQueuedMessage(firstQueuedMessage) : undefined} />
          </div>
        </div>
      )}
      <div
        ref={composerSurfaceRef}
        style={voiceComposer.style}
        className={`composer-surface${multilineInput ? ' is-multiline' : ''}${fileDragActive ? ' is-file-dragging' : ''}${voiceComposer.visible ? ' voice-call-active' : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || voiceComposer.visible) return;
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('button, input, select, textarea, a, [contenteditable], [role="textbox"], [role="button"]')
          ) {
            return;
          }
          // Focusing on pointerdown is otherwise undone by the padding's
          // default mouse action, leaving the composer without a caret.
          event.preventDefault();
          textareaRef.current?.focus();
        }}
        onPasteCapture={capturePastedText}
        onPaste={(event) => void pasteAttachments(event).catch(error => showUiError(language === 'zh' ? '无法添加附件' : 'Unable to add attachments', String(error)))}
      >
        {voiceComposer.visible && voiceComposer.session && <VoiceComposerPanel session={voiceComposer.session} language={language}
          onReturnText={() => requestAnimationFrame(() => textareaRef.current?.focus())}/>}
        {fileDragActive && dropTargetRef.current && createPortal(
          <div className="composer-file-drop-overlay" role="status">
            <Paperclip size={20} />
            <strong>{language === 'zh' ? '松开即可添加' : 'Drop to attach'}</strong>
            <span>{language === 'zh' ? '支持文件、文件夹和图片' : 'Files, folders and images are supported'}</span>
          </div>, dropTargetRef.current,
        )}
        {imageAttachments.length > 0 && (
          <div className="composer-image-strip">
            {imageAttachments.map((image) => (
              <figure className="composer-image-thumb" key={image.id}>
                <button
                  className="composer-image-preview"
                  type="button"
                  aria-label={language === 'zh' ? `查看图片：${image.name}` : `Preview image: ${image.name}`}
                  onClick={event => {
                    const thumbnail = event.currentTarget.querySelector('img');
                    setPreviewImage({
                      src: image.previewUrl,
                      name: image.name,
                      path: image.path,
                      naturalWidth: thumbnail?.naturalWidth,
                      naturalHeight: thumbnail?.naturalHeight,
                    });
                  }}
                >
                  <img src={image.previewUrl} alt={image.name} />
                </button>
                <button
                  className="composer-image-remove"
                  type="button"
                  aria-label={language === 'zh' ? '移除图片' : 'Remove image'}
                  onClick={() =>
                    setImageAttachments((current) =>
                      current.filter((item) => item.id !== image.id),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </figure>
            ))}
          </div>
        )}
        {fileAttachments.length > 0 && (
          <div className="composer-file-strip">
            {fileAttachments.map((file) => (
              <article className="composer-file-attachment" data-pasted-text={file.pastedText ? true : undefined} key={file.id}>
                <button
                  className="composer-file-preview"
                  type="button"
                  title={file.kind === 'folder'
                    ? language === 'zh' ? `打开文件夹 ${file.name}` : `Open folder ${file.name}`
                    : language === 'zh' ? `只读预览 ${file.name}` : `Preview ${file.name} read-only`}
                  onClick={() => host ? host.openFile(file.path) : file.kind === 'folder'
                    ? void window.cardbushDesktop?.openPath?.(file.path)
                    : openInspector(file.path, file.name)}
                >
                  <ComposerFileIcon name={file.name} kind={file.kind} />
                  <span className="composer-file-meta">
                    <strong>{file.pastedText ? language === 'zh' ? '粘贴文本' : 'Pasted text' : file.name}</strong>
                    <small>{file.pastedText
                      ? `${file.pastedText.lines} ${language === 'zh' ? '行' : file.pastedText.lines === 1 ? 'line' : 'lines'} · ${formatFileSize(file.size)}`
                      : file.kind === 'folder'
                      ? language === 'zh' ? '文件夹' : 'Folder'
                      : formatFileSize(file.size)}</small>
                    {file.pastedText?.preview && <small className="composer-pasted-text-preview">{file.pastedText.preview}</small>}
                  </span>
                </button>
                <button
                  className="composer-file-remove"
                  type="button"
                  disabled={attachmentUploads > 0}
                  aria-label={file.kind === 'folder'
                    ? language === 'zh' ? `移除文件夹 ${file.name}` : `Remove folder ${file.name}`
                    : language === 'zh' ? `移除文件 ${file.name}` : `Remove ${file.name}`}
                  title={file.kind === 'folder'
                    ? language === 'zh' ? '移除文件夹' : 'Remove folder'
                    : language === 'zh' ? '移除文件' : 'Remove file'}
                  onClick={() => void removeFileAttachment(file).catch(error => showUiError(language === 'zh' ? '无法移除附件' : 'Unable to remove attachment', String(error)))}
                >
                  <X size={12} />
                </button>
              </article>
            ))}
          </div>
        )}
        {attachmentUploads > 0 && <div className="composer-attachment-progress" role="status">{language === 'zh' ? '正在准备附件…' : 'Preparing attachment…'}</div>}
        {goalDraft && (
          <div className="composer-command-mode goal" role="status">
            <Target size={15} />
            <strong>{language === 'zh' ? '目标' : 'Goal'}</strong>
            <button
              type="button"
              aria-label={language === 'zh' ? '退出目标模式' : 'Exit goal mode'}
              title={language === 'zh' ? '退出目标模式' : 'Exit goal mode'}
              onClick={() => {
                onDraftChange(goalDraft.content);
                focusComposer(goalDraft.content.length);
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <ComposerPromptInput
          readOnly={inputReadOnly || submissionPending}
          richReferences={host ? 'applications' : true}
          ref={textareaRef}
          plugins={plugins}
          skills={skills}
          language={language}
          autoFocus={autoFocus && !presentation?.preview}
          value={composerInputValue}
          onChange={(next, caret) => {
            if (goalDraft) {
              onDraftChange(`/goal${next ? ` ${next}` : ' '}`);
              setCommandState(null);
              return;
            }
            onDraftChange(next);
            updateCommandFromTextarea(next, caret);
          }}
          onSelectionChange={(caret) => {
            if (!goalDraft) {
              updateCommandFromTextarea(draft, caret);
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.repeat) {
              const gesture = { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey };
              if (keyboardShortcuts.matches('guideNow', gesture) || keyboardShortcuts.matches('sendMessage', gesture) ||
                commandState && (event.key === 'Enter' || event.key === 'Tab')) {
                event.preventDefault();
                return;
              }
            }
            if (keyboardShortcuts.matches('guideNow', event)) {
              event.preventDefault();
              event.stopPropagation();
              void sendImmediate();
              return;
            }
            if (
              goalDraft &&
              event.key === 'Backspace' &&
              goalDraft.content.length === 0
            ) {
              event.preventDefault();
              onDraftChange('');
              setCommandState(null);
              return;
            }
            if (commandState) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setCommandIndex((current) => {
                  const count = Math.max(commandItems.length, 1);
                  return event.key === 'ArrowDown'
                    ? (current + 1) % count
                    : (current - 1 + count) % count;
                });
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setCommandState(null);
                return;
              }
              if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                commandItems.length > 0
              ) {
                event.preventDefault();
                applyCommand(commandItems[Math.min(commandIndex, commandItems.length - 1)]);
                return;
              }
            }
            if (keyboardShortcuts.matches('sendMessage', event)) {
              if (event.repeat || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            !runtimeReady
              ? runtimeStartupFailed
                ? language === 'zh' ? 'Runtime 启动失败，点击发送按钮重试' : 'Runtime failed to start. Use Send to retry'
                : language === 'zh' ? 'CardBush Runtime 正在准备…' : 'CardBush Runtime is preparing...'
            : simple ? "let's talk"
            : shadowActive
              ? language === 'zh'
                ? `回复 ${shadowAgentName || 'Shadow Agent'}…`
                : `Reply to ${shadowAgentName || 'Shadow Agent'}...`
              : language === 'zh'
              ? compact
                ? '问 cardbush 任何事。/ 选择功能，@ 引用'
                : '给 cardbush 发消息…'
              : compact
                ? 'Ask cardbush anything. / for actions, @ to reference'
                : 'Message cardbush...'
          }
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <ToolChip
              icon={<Plus size={15} />}
              label={language === 'zh' ? '添加' : 'Add'}
              active={activeMenu === 'more'}
              menuTrigger
              onClick={(event) => toggleMenu('more', event)}
            />
            {shadowAvailable && onToggleShadow && (
              <ToolChip
                icon={<ShadowCloneIcon size={15} />}
                label={shadowActive
                  ? language === 'zh' ? '收起 Shadow' : 'Close Shadow'
                  : language === 'zh' ? '打开 Shadow' : 'Open Shadow'}
                active={shadowActive}
                onClick={onToggleShadow}
              />
            )}
            {selectedTeam && !draftTeam && (
              <button
                className={`tool-chip composer-team-chip ${activeMenu === 'teams' ? 'active' : ''}`}
                type="button"
                title={`${selectedTeam.name} · ${selectedTeam.id}`}
                onClick={() => void openPromptReference({ kind: 'team', id: selectedTeam.id, title: selectedTeam.name }, host, referenceContext.sessionId)}
              >
                <UsersRound size={14} />
                <span>{selectedTeam.name}</span>
              </button>
            )}
            <button
              className={`permission-center-button mode-${permissionMode} ${
                activeMenu === 'permissions' ? 'active' : ''
              }`}
              type="button"
              data-composer-menu-trigger="true"
              title={permissionTitle}
              onClick={(event) => toggleMenu('permissions', event)}
            >
              {permissionIcon(permissionMode, 14)}
              <span>{permissionLabel}</span>
              <ChevronDown size={13} />
            </button>
            <ExtractionBulbs onInsert={insertExtraction} />
            {queuedMessageCount > 0 && onShowQueue && (
              <button className="composer-queue-button" type="button"
                title={language === 'zh' ? `查看排队消息（${queuedMessageCount}）` : `Show queue (${queuedMessageCount})`}
                aria-label={language === 'zh' ? `查看排队消息（${queuedMessageCount}）` : `Show queue (${queuedMessageCount})`}
                onClick={() => { setActiveMenu(null); onShowQueue(); }}>
                <ListOrdered size={15} aria-hidden="true" />
                <span>{queuedMessageCount}</span>
              </button>
            )}
          </div>
          <div className="composer-actions">
            <button
              className={`model-select ${activeMenu === 'models' ? 'active' : ''}`}
              type="button"
              data-composer-menu-trigger="true"
              title={
                language === 'zh'
                  ? `模型：${modelLabel}`
                  : `Model: ${modelLabel}`
              }
              onClick={(event) => {
                if (!hasConfiguredModels) {
                  onConfigureModels();
                  return;
                }
                toggleMenu('models', event);
              }}
            >
              <ModelLogoMark model={selectedModelConfig?.modelName || modelLabel} size={15} />
              <span>{modelLabel}</span>
              <ChevronDown size={15} />
            </button>
            {(hasContent || sending) && !presentation?.preview && <VoiceButton language={language} callOnly className="voice-call-entry" disabled={!runtimeReady || inputReadOnly || submissionPending} />}
            {!sending && !hasContent && runtimeReady && !presentation?.preview ? <VoiceButton language={language} disabled={inputReadOnly || submissionPending || attachmentUploads > 0} /> : <button
              className={`send-button ${sending && hasContent ? guidanceDeliveryMode : ''} ${stopping ? 'stopping' : ''}`}
              type="button"
              disabled={submissionPending || attachmentUploads > 0 || (!runtimeReady && !runtimeStartupFailed) || (sending && !hasContent && (!cancelReady || stopping))}
              title={[sendButtonLabel, hasContent ? keyboardShortcuts.label('sendMessage') : '', sending && hasContent && keyboardShortcuts.label('guideNow') ? keyboardShortcuts.label('guideNow') + (language === 'zh' ? ' 立即引导' : ' Send guidance now') : ''].filter(Boolean).join(' · ')}
              aria-label={sendButtonLabel}
              aria-keyshortcuts={hasContent ? keyboardShortcuts.aria('sendMessage') : undefined}
              onClick={() => void submit()}
            >
              {!runtimeReady ? (
                runtimeStartupFailed
                  ? <RefreshCw size={14} />
                  : <LoaderCircle size={14} className="spin" />
              ) : sending && !hasContent ? (
                cancelReady && !stopping
                  ? <Square size={10} fill="currentColor" />
                  : <LoaderCircle size={14} className="spin" />
              ) : (
                <ArrowUp size={15} />
              )}
            </button>}
          </div>
        </div>
      </div>
      {!compact && (
        <div className="composer-note">
          {language === 'zh'
            ? 'cardbush 可能出错，请核实重要信息'
            : 'cardbush can make mistakes. Check important information.'}
        </div>
      )}
    </div>
  );
  return portalTarget ? createPortal(composer, portalTarget) : composer;
}

function ComposerCommandPalette({
  language,
  mode,
  items,
  selectedIndex,
  onSelect,
}: {
  language: AppLanguage;
  mode: ComposerCommandMode;
  items: ComposerCommandItem[];
  selectedIndex: number;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const emptyLabel = mode === 'style' ? (language === 'zh' ? '没有匹配的风格，可在设置 → 个性化中添加' : 'No matching styles. Add one in Settings → Personalization') : mode === 'mention' ? (language === 'zh' ? '没有匹配的应用或引用' : 'No matching apps or references') : mode === 'plugin' ? (language === 'zh' ? '没有匹配的已安装插件' : 'No matching installed plugins') : language === 'zh' ? '没有匹配的快捷功能' : 'No matching quick actions';
  const categories = language === 'zh'
    ? { ssh: 'SSH 连接', actions: '快捷操作', apps: '应用', plugins: '插件', skills: '技能', commands: '插件命令', files: '添加', browser: 'CardBush 浏览器', extracts: '已保存的对话提取', turns: '当前对话 · 用户指令' }
    : { ssh: 'SSH connections', actions: 'Actions', apps: 'Applications', plugins: 'Plugins', skills: 'Skills', commands: 'Plugin commands', files: 'Add', browser: 'CardBush browser', extracts: 'Saved conversation extracts', turns: 'This conversation · User instructions' };
  useLayoutEffect(() => {
    const row = rowRefs.current[Math.max(0, selectedIndex)];
    const list = listRef.current;
    if (!row || !list) return;
    const item = row.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    // Only move the menu, never the conversation or its outer scroll container.
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  }, [items.length, selectedIndex]);
  return (
    <div className="composer-command-palette">
      <header>
        <strong>{mode === 'style' ? (language === 'zh' ? '对话风格' : 'Conversation styles') : mode === 'mention' ? (language === 'zh' ? '引用' : 'Reference') : mode === 'plugin' ? (language === 'zh' ? '插件' : 'Plugins') : language === 'zh' ? '快捷功能' : 'Quick actions'}</strong>
        <span>{language === 'zh' ? '输入关键词筛选' : 'Type to filter'}</span>
      </header>
      <div className="composer-command-list" ref={listRef}>
        {items.length === 0 ? (
          <div className="composer-command-empty">{emptyLabel}</div>
        ) : (
          items.map((item, index) => (
            <Fragment key={item.id}>
            {mode !== 'style' && (index === 0 || item.category !== items[index - 1].category) &&
              <div className="composer-command-category">{categories[item.category || 'actions']}</div>}
            <button
              className={`composer-command-row ${
                index === selectedIndex ? 'active' : ''
              } ${item.disabled ? 'disabled' : ''}`}
              type="button"
              data-command-id={item.id}
              key={item.id}
              disabled={item.disabled}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
            >
              <span className="composer-command-icon">{item.icon}</span>
              <span className="composer-command-label">
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}

function rankComposerCommandItems(
  items: ComposerCommandItem[],
  rawQuery: string,
) {
  const query = normalizeCommandQuery(rawQuery);
  if (!query) {
    return items;
  }
  return items
    .map((item) => ({
      item,
      score: scoreSlashCommand(item, query),
    }))
    .filter((entry): entry is { item: ComposerCommandItem; score: [number, number, number] } =>
      entry.score != null,
    )
    .sort((left, right) =>
      left.score[0] - right.score[0] ||
      left.score[1] - right.score[1] ||
      left.score[2] - right.score[2],
    )
    .map((entry) => entry.item);
}

function scoreSlashCommand(
  item: ComposerCommandItem,
  query: string,
): [number, number, number] | null {
  const source = item.searchText ?? `${item.id} ${item.title} ${item.subtitle}`;
  const commandName = normalizeCommandQuery(item.id.replace(/^[/$]+/, ''));
  const compactSource = normalizeCommandQuery(source);
  if (!query) {
    return [0, 0, commandName.length];
  }
  if (commandName.startsWith(query)) {
    return [0, 0, commandName.length];
  }
  const directIndex = compactSource.indexOf(query);
  if (directIndex >= 0) {
    return [1, directIndex, commandName.length];
  }
  const positions: number[] = [];
  let searchFrom = 0;
  for (const char of query) {
    const foundAt = compactSource.indexOf(char, searchFrom);
    if (foundAt < 0) {
      return null;
    }
    positions.push(foundAt);
    searchFrom = foundAt + 1;
  }
  return [2, positions[positions.length - 1] - positions[0], commandName.length];
}

function normalizeCommandQuery(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '');
}

export function detectComposerCommand(
  value: string,
  caret: number,
): ComposerCommandState | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const beforeCaret = value.slice(0, safeCaret);
  const styleMatch = beforeCaret.match(/(^|\s)\/(?:style|风格)(?:[ \t]+([^\n/]*))?$/i);
  if (styleMatch?.index != null) {
    return { mode: 'style', start: styleMatch.index + styleMatch[1].length, end: safeCaret, query: styleMatch[2] ?? '' };
  }
  const mentionMatch = beforeCaret.match(/(^|\s)@([^\s@/\\:]*)$/);
  if (mentionMatch?.index != null) {
    return { mode: 'mention', start: mentionMatch.index + mentionMatch[1].length, end: safeCaret, query: mentionMatch[2] };
  }
  const pluginMatch = beforeCaret.match(/(^|\s)\$([^\s$]*)$/);
  if (pluginMatch?.index != null) {
    return { mode: 'plugin', start: pluginMatch.index + pluginMatch[1].length, end: safeCaret, query: pluginMatch[2] };
  }
  const slashMatch = beforeCaret.match(/(^| )\/([^\s/]*)$/);
  if (!slashMatch || slashMatch.index == null) {
    return null;
  }
  const prefix = slashMatch[1] ?? '';
  const start = slashMatch.index + prefix.length;
  return {
    mode: 'slash',
    start,
    end: safeCaret,
    query: slashMatch[2] ?? '',
  };
}

export function composerGoalDraftPresentation(value: string) {
  const match = value.match(/^\/goal[ \t]+([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  return {
    content: match[1],
  };
}

function ComposerPopover({
  sourceEnabled, onSourceChange,
  menu,
  simpleModels,
  language,
  contextWindow,
  skills,
  disabledSkillNames,
  selectedModel,
  availableModels,
  permissionMode,
  subagentPermissionRouting,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  reasoningMode,
  referencePlanAvailable,
  referencePlanMode,
  onToggleSkill,
  onSelectModel,
  onConfigureModels,
  onPickAttachments,
  onSelectPermissionMode,
  onSelectSubagentPermissionRouting,
  onSelectReasoningLevel,
  onSelectReferencePlanMode,
  selectedTeamId,
  onSelectTeam,
  onClose,
  anchor,
}: {
  sourceEnabled: boolean;
  onSourceChange: (enabled: boolean) => void;
  menu: Exclude<ComposerMenu, null>;
  simpleModels: boolean;
  language: AppLanguage;
  contextWindow?: ContextWindowUsage;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  permissionMode: PermissionMode;
  subagentPermissionRouting: SubagentPermissionRouting;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  reasoningMode: 'effort' | 'adaptive' | 'budget';
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onSelectModel: (model: string) => void;
  onConfigureModels: () => void;
  onPickAttachments: () => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  onSelectSubagentPermissionRouting: (routing: SubagentPermissionRouting) => void;
  onSelectReasoningLevel: (level: ReasoningLevel) => void;
  onSelectReferencePlanMode: (mode: ReferencePlanMode) => void;
  selectedTeamId: string;
  onSelectTeam: (reference?: TeamPromptReference) => void;
  onClose: () => void;
  anchor: ComposerPopoverAnchor | null;
}) {
  const memory = useIndividuation();
  const models = availableModels;
  const pickerMenu = menu === 'models';
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const reasoningLevelGroups = useMemo(
    () => splitReasoningLevels(reasoningLevels),
    [reasoningLevels],
  );
  const referencePlanEnabled = referencePlanMode === 'auto';
  const secondaryReasoningSelected = reasoningLevelGroups.secondary.includes(reasoningLevel);
  useEffect(() => {
    setReasoningExpanded(menu === 'models' && secondaryReasoningSelected);
  }, [menu, selectedModel, reasoningMode, secondaryReasoningSelected]);
  const selectPermission = (mode: PermissionMode) => {
    onSelectPermissionMode(mode);
    onClose();
  };
  const anchorStyle = anchor
    ? ({
        left: anchor.x,
        top: anchor.y,
        width: anchor.width,
      } as CSSProperties)
    : undefined;

  return (
    <div
      className={`composer-popover ${menu} ${pickerMenu ? 'picker' : ''} ${
        anchor ? `anchored ${anchor.placement}` : ''
      }`}
      style={anchorStyle}
    >
      {!pickerMenu && (
        <header>
          <strong>{composerMenuTitle(menu, language)}</strong>
          <button type="button" onClick={onClose} aria-label="close popover">
            <X size={15} />
          </button>
        </header>
      )}
      {menu === 'more' && (
        <div className="composer-add-menu">
          <button className="composer-add-action" type="button" onClick={onPickAttachments}>
            <Paperclip size={18} />
            <span className="composer-add-copy">
              <strong>{language === 'zh' ? '文件和文件夹' : 'Files and folders'}</strong>
              <small>{language === 'zh' ? '添加到当前消息' : 'Attach to this message'}</small>
            </span>
          </button>
          <button className="composer-add-action" type="button" role="switch" aria-checked={sourceEnabled}
            aria-label="Source" onClick={() => onSourceChange(!sourceEnabled)}>
            <Quote size={18} />
            <span className="composer-add-copy"><strong>Source</strong>
              <small>{language === 'zh' ? '为关键结论附上说明与依据，会增加少量用量' : 'Explain key claims with sources; uses additional tokens'}</small>
            </span>
            <span className={`composer-add-toggle${sourceEnabled ? ' on' : ''}`} aria-hidden="true" />
          </button>
          {referencePlanAvailable && (
            <button
              className="composer-add-action"
              type="button"
              role="switch"
              aria-checked={referencePlanEnabled}
              aria-label={language === 'zh' ? '任务计划' : 'Task plan'}
              onClick={() => onSelectReferencePlanMode(referencePlanEnabled ? 'off' : 'auto')}
            >
              <ListChecks size={18} />
              <span className="composer-add-copy">
                <strong>{language === 'zh' ? '任务计划' : 'Task plan'}</strong>
                <small>{language === 'zh' ? '允许模型规划和更新任务步骤' : 'Let the model plan and update task steps'}</small>
              </span>
              <span className={`composer-add-toggle${referencePlanEnabled ? ' on' : ''}`} aria-hidden="true" />
            </button>
          )}
          <button className="composer-add-action" type="button" role="switch" aria-checked={memory.habits}
            aria-label={language === 'zh' ? '个性化记忆' : 'Personalization memory'} onClick={() => memory.setHabits(!memory.habits)}>
            <Brain size={18} />
            <span className="composer-add-copy">
              <strong>{language === 'zh' ? '个性化记忆' : 'Personalization memory'}</strong>
              <small>{language === 'zh' ? '记住并参考用户习惯，从下一轮生效' : 'Remember and use habits next turn'}</small>
            </span>
            <span className={`composer-add-toggle${memory.habits ? ' on' : ''}`} aria-hidden="true" />
          </button>
        </div>
      )}
      {menu === 'permissions' && (
        <div className="popover-list permission-mode-list">
          {permissionModeOptions(language).map((option) => (
            <button
              className={`popover-row permission-mode-row mode-${option.id} ${
                option.id === normalizePermissionMode(permissionMode) ? 'active' : ''
              }`}
              type="button"
              key={option.id}
              onClick={() => selectPermission(option.id)}
            >
              {permissionIcon(option.id, 15)}
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {option.id === normalizePermissionMode(permissionMode) && <Check size={14} />}
            </button>
          ))}
          <section className="subagent-permission-routing">
            <div className="subagent-permission-routing-copy">
              <strong>{language === 'zh' ? '子 Agent 权限管理' : 'Subagent permissions'}</strong>
              <small>
                {subagentPermissionRouting === 'user'
                  ? language === 'zh'
                    ? '父子 Agent 共同使用当前选择的权限。'
                    : 'Parent and child Agents use the permission selected above.'
                  : language === 'zh'
                    ? '子 Agent 继承权限限制，额外请求转交父任务审批。'
                    : 'Subagents inherit permission limits; extra requests go through the parent task.'}
              </small>
            </div>
            <div
              className={`subagent-routing-switch mode-${subagentPermissionRouting}`}
              role="group"
              aria-label={language === 'zh' ? '子 Agent 权限路由' : 'Subagent permission routing'}
            >
              <button
                type="button"
                className={subagentPermissionRouting === 'user' ? 'active' : ''}
                aria-pressed={subagentPermissionRouting === 'user'}
                onClick={() => onSelectSubagentPermissionRouting('user')}
              >
                {language === 'zh' ? '统一权限' : 'Unified'}
              </button>
              <button
                type="button"
                className={subagentPermissionRouting === 'parent' ? 'active' : ''}
                aria-pressed={subagentPermissionRouting === 'parent'}
                onClick={() => onSelectSubagentPermissionRouting('parent')}
              >
                {language === 'zh' ? '模型审批' : 'Model approval'}
              </button>
            </div>
          </section>
        </div>
      )}
      {menu === 'teams' && <ComposerTeamPicker language={language} selectedId={selectedTeamId} onSelect={onSelectTeam} onClose={onClose} />}
      {menu === 'skills' && (
        <div className="popover-list skill-popover-list">
          {skills.length === 0 ? (
            <p className="composer-popover-empty">
              {language === 'zh' ? '暂无可用 skill' : 'No skills available'}
            </p>
          ) : (
            skills.map((skill) => {
              const enabled = !disabledSkillNames.has(skill.name);
              return (
                <div
                  className={`skill-popover-row ${enabled ? '' : 'disabled'}`}
                  key={skill.name}
                >
                  <button
                    className="skill-popover-main"
                    type="button"
                    onClick={() => onToggleSkill(skill.name, !enabled)}
                  >
                    <SkillIcon skill={skill} compact />
                    <span>
                      <strong>{skill.name}</strong>
                      <small>
                        {language === 'zh' ? skill.descriptionZh : skill.description}
                      </small>
                    </span>
                  </button>
                  <button
                    className={`skill-popover-toggle ${enabled ? 'on' : ''}`}
                    type="button"
                    title={
                      enabled
                        ? language === 'zh'
                          ? '禁用这个 skill'
                          : 'Disable this skill'
                        : language === 'zh'
                          ? '启用这个 skill'
                          : 'Enable this skill'
                    }
                    onClick={() => onToggleSkill(skill.name, !enabled)}
                  >
                    {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                    <span>
                      {enabled
                        ? language === 'zh'
                          ? '开'
                          : 'On'
                        : language === 'zh'
                          ? '关'
                          : 'Off'}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
      {menu === 'models' && (
        <div className="model-picker-menu">
          <div className="model-picker-section-label">
            {language === 'zh' ? '模型' : 'Model'}
          </div>
          {models.length === 0 ? (
            <button
              className="model-picker-row primary"
              type="button"
              onClick={onConfigureModels}
            >
              <Box size={15} />
              <span>{language === 'zh' ? '待配置，前往模型设置' : 'Configure models'}</span>
              <ArrowRight size={15} />
            </button>
          ) : (
            models.map((config) => (
              <button
                className={`model-picker-row ${config.id === selectedModel ? 'active' : ''}`}
                type="button"
                key={config.id}
                onClick={() => onSelectModel(config.id)}
              >
                <ModelLogoMark model={config.modelName} size={16} />
                <span className="model-picker-copy">
                  <strong>{config.modelName}</strong>
                  <small className="model-picker-meta" title={`${config.provider} · ${modelProtocolInfo(config.apiProtocol).label}`}>
                    <span className="model-picker-provider">{config.provider}</span>
                    <span className="model-picker-meta-separator" aria-hidden="true">·</span>
                    <span className="model-picker-protocol">{modelProtocolInfo(config.apiProtocol).shortLabel}{config.authentication?.kind === 'chatgpt' ? ' · ChatGPT' : ''}</span>
                  </small>
                </span>
                {config.id === selectedModel && <Check size={16} />}
              </button>
            ))
          )}
          {!simpleModels && <>
          <div className="model-picker-divider" />
          <ContextWindowMeter usage={contextWindow} language={language} />
          {reasoningLevelAvailable && reasoningLevels.length > 0 && (
            <div className="model-reasoning-section">
              <div className="model-picker-inline-label">
                <span>{reasoningMode === 'budget' ? (language === 'zh' ? '思考预算' : 'Thinking budget')
                  : reasoningMode === 'adaptive' ? (language === 'zh' ? '思考强度' : 'Thinking effort')
                  : language === 'zh' ? '推理强度' : 'Reasoning effort'}</span>
                <span className="model-reasoning-current">
                  {reasoningLevel !== 'default' && <strong>{reasoningLevelLabel(reasoningLevel, language)}</strong>}
                  <button type="button" className="model-reasoning-default" aria-pressed={reasoningLevel === 'default'}
                    title={reasoningLevelDescription('default', language)} onClick={() => onSelectReasoningLevel('default')}>
                    {reasoningLevelLabel('default', language)}</button>
                </span>
              </div>
              <div className={`model-reasoning-options ${reasoningExpanded ? 'expanded' : ''} ${reasoningLevelGroups.secondary.length ? '' : 'single-page'}`}>
                <div className="model-reasoning-viewport">
                  <div className="model-reasoning-pages">
                    <div className="model-reasoning-primary-options" aria-hidden={reasoningExpanded}>
                      {reasoningLevelGroups.primary.map((level) => (
                        <button
                          className={level === reasoningLevel ? 'active' : ''}
                          aria-pressed={level === reasoningLevel}
                          type="button"
                          tabIndex={reasoningExpanded ? -1 : 0}
                          key={level}
                          title={reasoningLevelDescription(level, language)}
                          onClick={() => onSelectReasoningLevel(level)}
                        >
                          {reasoningLevelLabel(level, language)}
                        </button>
                      ))}
                    </div>
                    <div className="model-reasoning-secondary-options" aria-hidden={!reasoningExpanded}>
                      {reasoningLevelGroups.secondary.map((level) => (
                        <button
                          className={level === reasoningLevel ? 'active' : ''}
                          aria-pressed={level === reasoningLevel}
                          type="button"
                          tabIndex={reasoningExpanded ? 0 : -1}
                          key={level}
                          title={reasoningLevelDescription(level, language)}
                          onClick={() => onSelectReasoningLevel(level)}
                        >
                          {reasoningLevelLabel(level, language)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {reasoningLevelGroups.secondary.length > 0 && (
                  <button
                    className={`model-reasoning-expand ${!reasoningExpanded && reasoningLevelGroups.secondary.includes(reasoningLevel) ? 'hidden-selection' : ''}`}
                    type="button"
                    aria-expanded={reasoningExpanded}
                    aria-label={language === 'zh' ? (reasoningExpanded ? '收起其他推理强度' : '展开其他推理强度') : (reasoningExpanded ? 'Collapse other reasoning levels' : 'Show other reasoning levels')}
                    title={language === 'zh' ? (reasoningExpanded ? '收起' : '显示其他强度') : (reasoningExpanded ? 'Collapse' : 'Show other levels')}
                    onClick={() => setReasoningExpanded((current) => !current)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="model-picker-divider" />
          <button
            className="model-picker-row secondary"
            type="button"
            onClick={onConfigureModels}
          >
            <SlidersHorizontal size={15} />
            <span>{language === 'zh' ? '管理模型' : 'Manage models'}</span>
            <ArrowRight size={15} />
          </button>
          </>}
        </div>
      )}
    </div>
  );
}

function composerMenuTitle(menu: Exclude<ComposerMenu, null>, language: AppLanguage) {
  const labels: Record<Exclude<ComposerMenu, null>, { zh: string; en: string }> = {
    more: { zh: '添加', en: 'Add' },
    skills: { zh: 'Skills', en: 'Skills' },
    models: { zh: '模型', en: 'Model' },
    permissions: { zh: '权限中心', en: 'Permissions' },
    teams: { zh: '选择 Team', en: 'Select team' },
  };
  return labels[menu][language];
}

function ComposerTeamPicker({ language, selectedId, onSelect, onClose }: { language: AppLanguage; selectedId: string; onSelect: (reference?: TeamPromptReference) => void; onClose: () => void }) {
  const workspace = useTeamWorkspace();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardNavigating, setKeyboardNavigating] = useState(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const normalized = query.trim().toLowerCase();
  const teams = useMemo(
    () => workspace.choices.filter((team) => !normalized || `${team.id} ${team.name} ${team.description}`.toLowerCase().includes(normalized)),
    [normalized, workspace.choices],
  );
  const options = useMemo(
    () => [
      {
        id: '',
        name: language === 'zh' ? '不使用 Team' : 'No team',
        description: language === 'zh' ? '移除当前 Team 选择' : 'Remove the selected team',
      },
      ...teams,
    ],
    [language, teams],
  );
  const optionSignature = options.map((option) => option.id).join('\u0000');
  const select = (teamId: string) => {
    const team = teams.find(team => team.id === teamId);
    onSelect(team ? { kind: 'team', id: team.id, title: team.name } : undefined);
  };

  useLayoutEffect(() => {
    const selectedIndex = options.findIndex((option) => option.id === selectedId);
    setActiveIndex(normalized && options.length > 1 ? 1 : Math.max(0, selectedIndex));
    setKeyboardNavigating(false);
  }, [normalized, optionSignature, selectedId]);

  const moveActive = (nextIndex: number) => {
    const normalizedIndex = (nextIndex + options.length) % options.length;
    setActiveIndex(normalizedIndex);
    setKeyboardNavigating(true);
    window.requestAnimationFrame(() => optionRefs.current[normalizedIndex]?.scrollIntoView({ block: 'nearest' }));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || options.length === 0) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Tab', 'Escape'].includes(event.key)) event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(activeIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(activeIndex - 1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveActive(event.key === 'Home' ? 0 : options.length - 1);
      return;
    }
    if (event.key === 'Enter' || (event.key === 'Tab' && keyboardNavigating)) {
      event.preventDefault();
      if (event.repeat) return;
      select(options[activeIndex]?.id ?? '');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="composer-team-picker">
      <label><Search size={14} /><input autoFocus role="combobox" aria-label={language === 'zh' ? '搜索 Team' : 'Search teams'} aria-expanded="true" aria-controls={listboxId} aria-activedescendant={`${listboxId}-option-${activeIndex}`} aria-autocomplete="list" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={handleKeyDown} placeholder={language === 'zh' ? '搜索 Team' : 'Search teams'} /></label>
      <div className="popover-list" id={listboxId} role="listbox">
        <button ref={(element) => { optionRefs.current[0] = element; }} id={`${listboxId}-option-0`} role="option" aria-selected={!selectedId} className={`popover-row ${selectedId ? '' : 'active'} ${activeIndex === 0 && keyboardNavigating ? 'keyboard-active' : ''}`} type="button" tabIndex={-1} onMouseEnter={() => setActiveIndex(0)} onClick={() => select('')}>
          <Circle size={14} /><span><strong>{options[0].name}</strong><small>{options[0].description}</small></span>{!selectedId && <Check size={14} />}
        </button>
        {teams.map((team, index) => {
          const optionIndex = index + 1;
          return <button ref={(element) => { optionRefs.current[optionIndex] = element; }} id={`${listboxId}-option-${optionIndex}`} role="option" aria-selected={selectedId === team.id} className={`popover-row ${selectedId === team.id ? 'active' : ''} ${activeIndex === optionIndex && keyboardNavigating ? 'keyboard-active' : ''}`} type="button" tabIndex={-1} key={team.id} onMouseEnter={() => setActiveIndex(optionIndex)} onClick={() => select(team.id)}><UsersRound size={14} /><span><strong>{team.name}</strong><small>{team.description || team.id}</small></span>{selectedId === team.id && <Check size={14} />}</button>;
        })}
        {!workspace.loading && teams.length === 0 && <p className="composer-popover-empty">{workspace.error || (language === 'zh' ? '没有可用 Team' : 'No teams available')}</p>}
      </div>
    </div>
  );
}

function reasoningLevelLabel(level: ReasoningLevel, language: AppLanguage) {
  const labels: Record<ReasoningLevel, { zh: string; en: string }> = {
    default: { zh: '默认', en: 'Default' },
    none: { zh: '关闭', en: 'None' },
    low: { zh: '低', en: 'Low' },
    medium: { zh: '中', en: 'Medium' },
    high: { zh: '高', en: 'High' },
    xhigh: { zh: '超高', en: 'Extra high' },
    max: { zh: '最高', en: 'Max' },
  };
  return labels[level][language];
}

function splitReasoningLevels(levels: ReasoningLevel[]) {
  const rank: ReasoningLevel[] = [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];
  const available = new Set(levels);
  const ordered = rank.filter((level) => available.has(level));
  const primaryStart = Math.max(0, ordered.length - 3);
  return {
    primary: ordered.slice(primaryStart),
    secondary: ordered.slice(0, primaryStart),
  };
}

function reasoningLevelDescription(level: ReasoningLevel, language: AppLanguage) {
  const descriptions: Record<ReasoningLevel, { zh: string; en: string }> = {
    default: { zh: '使用当前模型的服务商默认值，不额外指定思考强度', en: 'Leave reasoning effort unspecified and use the provider default' },
    none: { zh: '不分配推理预算，适合最低延迟请求', en: 'No reasoning budget for lowest-latency requests' },
    low: { zh: '更快，适合直接问题', en: 'Faster for direct questions' },
    medium: { zh: '质量与延迟的平衡档', en: 'Balanced quality and latency' },
    high: { zh: '更深入分析复杂问题', en: 'Deeper analysis for complex work' },
    xhigh: { zh: '适合高难度代理和长链路任务', en: 'For difficult agentic and long-horizon work' },
    max: { zh: '当前模型支持的最大推理强度', en: 'Maximum reasoning effort supported by the current model' },
  };
  return descriptions[level][language];
}

function compactTokenCount(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

function ContextWindowMeter({
  usage,
  language,
}: {
  usage?: ContextWindowUsage;
  language: AppLanguage;
}) {
  const maxTokens = usage?.maxTokens;
  const usedTokens = usage?.usedTokens ?? (
    maxTokens != null && usage?.remainingTokens != null
      ? Math.max(0, maxTokens - usage.remainingTokens)
      : undefined
  );
  const ratio = usedTokens != null && maxTokens != null && maxTokens > 0
    ? Math.max(0, usedTokens / maxTokens)
    : 0;
  const percentage = Math.round(ratio * 100);
  const progressPercentage = Math.min(100, percentage);
  const overflowTokens = usedTokens != null && maxTokens != null
    ? Math.max(0, usedTokens - maxTokens)
    : 0;
  const valueLabel = usedTokens != null && maxTokens != null
    ? overflowTokens > 0
      ? `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)} · ${percentage}% · ${language === 'zh' ? '超出' : 'Over'} ${compactTokenCount(overflowTokens)}`
      : `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)} · ${percentage}%`
    : maxTokens != null
      ? `${language === 'zh' ? '等待统计' : 'Pending'} / ${compactTokenCount(maxTokens)}`
      : usedTokens != null
        ? `${compactTokenCount(usedTokens)} · ${language === 'zh' ? '上限未知' : 'Unknown limit'}`
      : language === 'zh'
        ? '等待用量统计'
        : 'Waiting for usage';

  return (
    <div className={`model-context-section ${overflowTokens > 0 ? 'is-overflow' : ''}`}>
      <div className="model-picker-inline-label">
        <span>{language === 'zh' ? '上下文占用' : 'Context usage'}</span>
        <strong>{valueLabel}</strong>
      </div>
      <div
        className="model-context-progress"
        role="progressbar"
        aria-label={language === 'zh' ? '上下文窗口占用' : 'Context window usage'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usedTokens != null && maxTokens != null ? progressPercentage : undefined}
      >
        <span style={{ width: `${progressPercentage}%` }} />
      </div>
    </div>
  );
}

function ModelLogoMark({
  model,
  size = 16,
}: {
  model: string;
  size?: number;
}) {
  const logo = modelLogoFor(model);
  if (!logo) {
    return <Box className="model-logo-fallback" size={size} />;
  }
  return (
    <img
      className={`model-logo model-logo-${logo.id}`}
      src={logo.src}
      alt={logo.label}
      width={size}
      height={size}
      draggable={false}
    />
  );
}

function permissionIcon(mode: PermissionMode, size = 15) {
  if (mode === 'all_free') {
    return <Unlock size={size} />;
  }
  return <Lock size={size} />;
}

function permissionModeLabel(mode: PermissionMode, language: AppLanguage) {
  return (
    permissionModeOptions(language).find((option) => option.id === mode)?.label ??
    permissionModeOptions(language)[0].label
  );
}

function permissionModeDescription(mode: PermissionMode, language: AppLanguage) {
  return (
    permissionModeOptions(language).find((option) => option.id === mode)?.description ??
    permissionModeOptions(language)[0].description
  );
}

function ToolChip({
  icon,
  label,
  active,
  menuTrigger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  menuTrigger?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      className={`tool-chip ${active ? 'active' : ''}`}
      type="button"
      title={label}
      data-composer-menu-trigger={menuTrigger ? 'true' : undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
