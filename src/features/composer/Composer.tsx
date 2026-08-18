import {
  ArrowRight,
  ArrowUp,
  Box,
  BookOpen,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Edit3,
  Eye,
  EyeOff,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  GitBranch,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Lock,
  Paperclip,
  Pause,
  Plus,
  Presentation,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  Target,
  Terminal,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  basename,
  compactPath,
  fileUrl,
  isImagePath,
} from '../../shared/localPaths';
import type {
  AppLanguage,
  ManagedModelConfig,
  PermissionMode,
  ReasoningLevel,
  ReferencePlanMode,
  SkillSummary,
} from '../../types';
import { ImagePreviewDialog } from '../chatMessages';
import { openInspector } from '../inspector/inspectorEvents';
import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import { modelLogoFor } from './modelLogos';
import { quickPayloadText, type QuickLoadPayload } from './quickLoad';

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
  size?: number;
};

type ImagePreview = {
  src: string;
  name: string;
  path?: string;
};

type ComposerQueuedMessage = {
  id: string;
  text: string;
  createdAt: string;
};

type ComposerMenu =
  | 'more'
  | 'project'
  | 'git'
  | 'skills'
  | 'models'
  | 'permissions'
  | null;

type MorePanelMenu =
  | 'project'
  | 'skills'
  | 'git'
  | 'plan'
  | 'vision';

export type ContextWindowUsage = {
  usedTokens?: number;
  maxTokens?: number;
  remainingTokens?: number;
  measuredAt?: string;
};

type ComposerCommandMode = 'slash';

type ComposerCommandState = {
  mode: ComposerCommandMode;
  start: number;
  end: number;
  query: string;
};

type ComposerCommandItem = {
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
  more: 350,
  project: 300,
  git: 260,
  skills: 336,
  models: 300,
  permissions: 274,
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
  metadata?: { name?: string; size?: number },
): ComposerFileAttachment {
  return {
    id: `file-${crypto.randomUUID()}`,
    path: pathValue,
    name: metadata?.name?.trim() || basename(pathValue),
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

function ComposerFileIcon({ name }: { name: string }) {
  const extension = fileExtension(name);
  const kind = fileIconKind(extension);
  const icon = kind === 'sheet'
    ? <FileSpreadsheet size={22} />
    : kind === 'slides'
      ? <Presentation size={22} />
      : kind === 'archive'
        ? <FileArchive size={22} />
        : kind === 'code'
          ? <FileCode2 size={22} />
          : kind === 'document'
            ? <FileText size={22} />
            : <FileIcon size={22} />;
  return (
    <span className={`composer-file-icon ${kind}`} aria-hidden="true">
      {icon}
      <em>{extension ? extension.toUpperCase() : 'FILE'}</em>
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
  autoFocus = false,
  osMode = false,
  language,
  draft,
  onDraftChange,
  sending,
  queuedMessageCount = 0,
  queuedMessagePreview = '',
  queuedMessages = [],
  selectedModel,
  availableModels,
  goalAvailable = false,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onReasoningLevelChange,
  onSend,
  onCancel,
  cancelEnabled = true,
  skills = [],
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  gitAvailable = false,
  terminalAvailable = false,
  activeProjectDir,
  projectContext = '',
  onQuickLoad,
  onSaveProjectContext,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onConfigureModels,
  onCreateConversation,
  onOpenTerminalConsole,
  onToggleSkill,
  onVisualInputEnabledChange,
  shadowActive = false,
  shadowAvailable = false,
  shadowAgentName,
  onToggleShadow,
  contextWindow,
}: {
  compact?: boolean;
  autoFocus?: boolean;
  osMode?: boolean;
  language: AppLanguage;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: ComposerQueuedMessage[];
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  goalAvailable?: boolean;
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  cancelEnabled?: boolean;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  gitAvailable?: boolean;
  terminalAvailable?: boolean;
  activeProjectDir?: string;
  projectContext?: string;
  onQuickLoad?: (payload: QuickLoadPayload) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onEditQueuedMessage?: (item: ComposerQueuedMessage) => void;
  onGuideQueuedMessage?: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage?: (queuedId: string) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onOpenTerminalConsole?: () => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  shadowActive?: boolean;
  shadowAvailable?: boolean;
  shadowAgentName?: string;
  onToggleShadow?: () => void;
  contextWindow?: ContextWindowUsage;
}) {
  const composerStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [commandState, setCommandState] = useState<ComposerCommandState | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<ComposerFileAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
  const [popoverAnchor, setPopoverAnchor] = useState<ComposerPopoverAnchor | null>(null);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const [cancelReady, setCancelReady] = useState(false);
  const hasContent =
    draft.trim().length > 0 ||
    imageAttachments.length > 0 ||
    fileAttachments.length > 0;

  useEffect(() => {
    if (!sending || !cancelEnabled) {
      setCancelReady(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setCancelReady(true), 600);
    return () => window.clearTimeout(timer);
  }, [cancelEnabled, sending]);

  useEffect(() => {
    if (!gitAvailable && activeMenu === 'git') {
      setActiveMenu(null);
      setPopoverAnchor(null);
    }
  }, [activeMenu, gitAvailable]);

  const resizeComposerTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const minHeight = Math.ceil(lineHeight * 2);
    const maxHeight = Math.min(
      Math.ceil(window.innerHeight * 0.32),
      Math.ceil(lineHeight * 10),
    );
    textarea.style.height = 'auto';
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposerTextarea();
  }, [compact, draft, fileAttachments.length, imageAttachments.length, resizeComposerTextarea]);

  useEffect(() => {
    const handleResize = () => resizeComposerTextarea();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [resizeComposerTextarea]);

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

  async function submit() {
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
    const attachmentPaths = [...imageAttachments, ...fileAttachments]
      .map((item) => `@${item.path}`);
    const value = [...attachmentPaths, draft.trimEnd()].filter(Boolean).join('\n');
    onDraftChange('');
    setImageAttachments([]);
    setFileAttachments([]);
    await onSend(value);
  }

  function toggleMenu(menu: Exclude<ComposerMenu, null>, event?: React.MouseEvent<HTMLElement>) {
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
      if (isImagePath(pathValue)) {
        setImageAttachments((current) => [
          ...current,
          imageAttachmentFromPath(pathValue),
        ]);
      } else {
        void addFileAttachments([pathValue]);
      }
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

  async function addFileAttachments(paths: string[]) {
    const uniquePaths = [...new Set(paths.map((value) => value.trim()).filter(Boolean))];
    if (uniquePaths.length === 0) {
      return;
    }
    const inspected = await window.cardbushDesktop
      ?.inspectAttachments?.(uniquePaths)
      .catch(() => []);
    const metadataByPath = new Map(
      (inspected ?? []).map((item) => [item.path.toLowerCase(), item]),
    );
    setFileAttachments((current) => {
      const existing = new Set(current.map((item) => item.path.toLowerCase()));
      return [
        ...current,
        ...uniquePaths
          .filter((pathValue) => !existing.has(pathValue.toLowerCase()))
          .map((pathValue) =>
            fileAttachmentFromPath(
              pathValue,
              metadataByPath.get(pathValue.toLowerCase()),
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

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData('application/x-cardbush-quickload');
    if (!raw) {
      return;
    }
    event.preventDefault();
    try {
      loadPayload(JSON.parse(raw) as QuickLoadPayload);
    } catch {
      const text = event.dataTransfer.getData('text/plain');
      if (text.trim()) {
        onDraftChange(draft.trim() ? `${draft.trimEnd()}\n${text}` : text);
      }
    }
  }

  async function pickAttachments() {
    const paths = await window.cardbushDesktop?.pickAttachments?.();
    if (!paths || paths.length === 0) {
      return;
    }
    const imagePaths = paths.filter(isImagePath);
    if (imagePaths.length > 0) {
      setImageAttachments((current) => [
        ...current,
        ...imagePaths.map((pathValue) => imageAttachmentFromPath(pathValue)),
      ]);
    }
    const otherPaths = paths.filter((pathValue) => !isImagePath(pathValue));
    if (otherPaths.length > 0) {
      await addFileAttachments(otherPaths);
    }
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    if (!window.cardbushDesktop?.saveImageDataUrl) {
      return;
    }
    try {
      const saved = await Promise.all(
        files.map(async (file) => {
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
    focusComposer(before.length + replacement.length);
  }

  function removeCommandToken() {
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
    focusComposer(before.length);
  }

  const slashCommands = useMemo<ComposerCommandItem[]>(
    () => {
      const commands: ComposerCommandItem[] = [
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
      return goalAvailable
        ? commands
        : commands.filter((command) => command.id !== '/goal');
    },
    [
      goalAvailable,
      language,
      onCreateConversation,
    ],
  );

  const commandItems = useMemo(() => {
    if (!commandState) {
      return [];
    }
    return rankComposerCommandItems(slashCommands, commandState.query).slice(0, 4);
  }, [commandState, slashCommands]);

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
      removeCommandToken();
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
      ? `${selectedModelConfig.modelName} · ${selectedModelConfig.provider}`
      : language === 'zh' ? '待配置' : 'Configure';
  const permissionLabel = permissionModeLabel(permissionMode, language);
  const permissionTitle = permissionModeDescription(permissionMode, language);
  const referencePlanEnabled = referencePlanMode === 'auto';
  const referencePlanLabel =
    language === 'zh' ? '任务计划' : 'Task plan';
  const referencePlanDescription =
    language === 'zh'
      ? '交付、Review 与核查任务可由模型维护分步进度并实时显示；它不替代实际执行与验收。'
      : 'For delivery, review, and audit work, the model may maintain visible step progress; it does not replace execution or verification.';
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
    language === 'zh' ? '当前回复完成后自动发送' : 'Sends after the current reply';
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

  return (
    <div
      className={`composer-stack ${compact ? 'compact' : ''} ${shadowActive ? 'shadow-active' : ''}`}
      ref={composerStackRef}
      style={
        {
          '--composer-popover-max-height': `${popoverMaxHeight}px`,
        } as CSSProperties
      }
    >
      {commandState && (
        <ComposerCommandPalette
          language={language}
          items={commandItems}
          selectedIndex={commandIndex}
          onSelect={(item) => applyCommand(item)}
        />
      )}
      {activeMenu &&
        (() => {
          const popover = (
            <ComposerPopover
              menu={activeMenu}
              language={language}
              contextWindow={contextWindow}
              skills={skills}
              disabledSkillNames={disabledSkillNames}
              visualInputAvailable={visualInputAvailable}
              visualInputEnabled={visualInputEnabled}
              gitAvailable={gitAvailable}
              selectedModel={selectedModel}
              availableModels={availableModels}
              permissionMode={permissionMode}
              reasoningLevelAvailable={reasoningLevelAvailable}
              reasoningLevel={reasoningLevel}
              reasoningLevels={reasoningLevels}
              referencePlanAvailable={referencePlanAvailable}
              referencePlanMode={referencePlanMode}
              activeProjectDir={activeProjectDir}
              projectContext={projectContext}
              onLoad={loadPayload}
              onToggleSkill={onToggleSkill}
              onVisualInputEnabledChange={onVisualInputEnabledChange}
              onSaveProjectContext={onSaveProjectContext}
              onSelectModel={selectModel}
              onSelectPermissionMode={onPermissionModeChange}
              onSelectReasoningLevel={onReasoningLevelChange}
              onSelectReferencePlanMode={onReferencePlanModeChange}
              onConfigureModels={onConfigureModels}
              onPickAttachments={() => {
                void pickAttachments();
                setActiveMenu(null);
                setPopoverAnchor(null);
              }}
              onClose={() => {
                setActiveMenu(null);
                setPopoverAnchor(null);
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
          language={language}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {queueLabel && (
        <div className="composer-secondary-row composer-queue-row" title={queueTitle}>
          <div className="composer-queue-summary">
            <Clock3 size={13} />
            <span>{queueLabel}</span>
            <small>{queuePreview || queueHint}</small>
          </div>
          {firstQueuedMessage && (
            <div className="composer-queue-actions">
              <button
                type="button"
                aria-label={language === 'zh' ? '将排队消息用于引导' : 'Use queued message as guidance'}
                title={language === 'zh' ? '引导' : 'Guide'}
                disabled={!onGuideQueuedMessage || guidingQueuedId === firstQueuedMessage.id}
                onClick={() => void guideFirstQueuedMessage()}
              >
                {guidingQueuedId === firstQueuedMessage.id ? (
                  <LoaderCircle size={12} />
                ) : (
                  <Sparkles size={12} />
                )}
                <span>{language === 'zh' ? '引导' : 'Guide'}</span>
              </button>
              <button
                type="button"
                aria-label={language === 'zh' ? '编辑排队消息' : 'Edit queued message'}
                title={language === 'zh' ? '编辑' : 'Edit'}
                disabled={!onEditQueuedMessage}
                onClick={() => onEditQueuedMessage?.(firstQueuedMessage)}
              >
                <Edit3 size={12} />
                <span>{language === 'zh' ? '编辑' : 'Edit'}</span>
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
            </div>
          )}
        </div>
      )}
      <div
        className="composer-surface"
        onPointerDown={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('button, input, select, textarea, [role="button"]')
          ) {
            return;
          }
          textareaRef.current?.focus();
        }}
        onPaste={(event) => void pasteImages(event)}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-cardbush-quickload')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={handleDrop}
      >
        {imageAttachments.length > 0 && (
          <div className="composer-image-strip">
            {imageAttachments.map((image) => (
              <figure className="composer-image-thumb" key={image.id}>
                <button
                  className="composer-image-preview"
                  type="button"
                  title={language === 'zh' ? '放大查看图片' : 'Preview image'}
                  onClick={() =>
                    setPreviewImage({
                      src: image.previewUrl,
                      name: image.name,
                      path: image.path,
                    })
                  }
                >
                  <img src={image.previewUrl} alt={image.name} />
                </button>
                <button
                  className="composer-image-remove"
                  type="button"
                  title={language === 'zh' ? '移除图片' : 'Remove image'}
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
              <article className="composer-file-attachment" key={file.id}>
                <button
                  className="composer-file-preview"
                  type="button"
                  title={language === 'zh' ? `只读预览 ${file.name}` : `Preview ${file.name} read-only`}
                  onClick={() => openInspector(file.path, file.name)}
                >
                  <ComposerFileIcon name={file.name} />
                  <span className="composer-file-meta">
                    <strong>{file.name}</strong>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                </button>
                <button
                  className="composer-file-remove"
                  type="button"
                  aria-label={language === 'zh' ? `移除文件 ${file.name}` : `Remove ${file.name}`}
                  title={language === 'zh' ? '移除文件' : 'Remove file'}
                  onClick={() =>
                    setFileAttachments((current) =>
                      current.filter((item) => item.id !== file.id),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </article>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-os-primary-input={osMode ? 'true' : undefined}
          autoFocus={autoFocus}
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            onDraftChange(next);
            updateCommandFromTextarea(next, event.currentTarget.selectionStart);
          }}
          onClick={(event) =>
            updateCommandFromTextarea(draft, event.currentTarget.selectionStart)
          }
          onKeyUp={(event) =>
            updateCommandFromTextarea(draft, event.currentTarget.selectionStart)
          }
          onKeyDown={(event) => {
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
            if (event.key === 'Enter' && !event.shiftKey) {
              if (event.repeat || event.nativeEvent.isComposing) {
                return;
              }
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            shadowActive
              ? language === 'zh'
                ? `回复 ${shadowAgentName || 'Shadow Agent'}…`
                : `Reply to ${shadowAgentName || 'Shadow Agent'}...`
              : osMode
              ? language === 'zh'
                ? '告诉 CardBush 你想让电脑完成什么…'
                : 'Tell CardBush what your computer should do...'
              : language === 'zh'
              ? compact
                ? '问 cardbush 任何事。输入 / 选择快捷功能'
                : '给 cardbush 发消息…'
              : compact
                ? 'Ask cardbush anything. Type / for quick actions'
                : 'Message cardbush...'
          }
          rows={2}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            {!osMode && <ToolChip
              icon={<Plus size={15} />}
              label={language === 'zh' ? '添加' : 'Add'}
              active={
                activeMenu === 'more' ||
                activeMenu === 'project' ||
                (gitAvailable && activeMenu === 'git') ||
                activeMenu === 'skills'
              }
              menuTrigger
              onClick={(event) => toggleMenu('more', event)}
            />}
            {!osMode && shadowAvailable && onToggleShadow && (
              <ToolChip
                icon={<ShadowCloneIcon size={15} />}
                label={shadowActive
                  ? language === 'zh' ? '收起 Shadow' : 'Close Shadow'
                  : language === 'zh' ? '打开 Shadow' : 'Open Shadow'}
                active={shadowActive}
                onClick={onToggleShadow}
              />
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
            {terminalAvailable && onOpenTerminalConsole && (
              <button
                className="tool-chip terminal-chip"
                type="button"
                title={language === 'zh' ? '终端控制台' : 'Terminal console'}
                onClick={() => onOpenTerminalConsole()}
              >
                <Terminal size={15} />
              </button>
            )}
            <button
              className={`send-button ${sending && hasContent ? 'queue' : ''}`}
              type="button"
              disabled={sending && !hasContent && !cancelReady}
              title={
                sending && hasContent
                  ? language === 'zh'
                    ? '加入发送队列'
                    : 'Queue message'
                  : undefined
              }
              onClick={() => void submit()}
            >
              {sending && !hasContent ? (
                cancelReady ? <Pause size={17} /> : <LoaderCircle size={17} />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
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
}

function ComposerCommandPalette({
  language,
  items,
  selectedIndex,
  onSelect,
}: {
  language: AppLanguage;
  items: ComposerCommandItem[];
  selectedIndex: number;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const emptyLabel = language === 'zh' ? '没有匹配的快捷功能' : 'No matching quick actions';
  useEffect(() => {
    const row = rowRefs.current[Math.max(0, selectedIndex)];
    row?.scrollIntoView({ block: 'nearest' });
  }, [items.length, selectedIndex]);
  return (
    <div className="composer-command-palette">
      <header>
        <strong>{language === 'zh' ? '快捷功能' : 'Quick actions'}</strong>
        <span>{language === 'zh' ? '输入 / 选择' : 'Type / to choose'}</span>
      </header>
      <div className="composer-command-list">
        {items.length === 0 ? (
          <div className="composer-command-empty">{emptyLabel}</div>
        ) : (
          items.map((item, index) => (
            <button
              className={`composer-command-row ${
                index === selectedIndex ? 'active' : ''
              } ${item.disabled ? 'disabled' : ''}`}
              type="button"
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
              {item.icon}
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
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
  const commandName = normalizeCommandQuery(item.id.replace(/^\/+/, ''));
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
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
}

export function detectComposerCommand(
  value: string,
  caret: number,
): ComposerCommandState | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const beforeCaret = value.slice(0, safeCaret);
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

function ComposerPopover({
  menu,
  language,
  contextWindow,
  skills,
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  gitAvailable,
  selectedModel,
  availableModels,
  permissionMode,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  referencePlanAvailable,
  referencePlanMode,
  activeProjectDir,
  projectContext,
  onLoad,
  onToggleSkill,
  onVisualInputEnabledChange,
  onSaveProjectContext,
  onSelectModel,
  onConfigureModels,
  onPickAttachments,
  onSelectPermissionMode,
  onSelectReasoningLevel,
  onSelectReferencePlanMode,
  onClose,
  anchor,
}: {
  menu: Exclude<ComposerMenu, null>;
  language: AppLanguage;
  contextWindow?: ContextWindowUsage;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  gitAvailable: boolean;
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  permissionMode: PermissionMode;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  activeProjectDir?: string;
  projectContext: string;
  onLoad: (payload: QuickLoadPayload) => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onSelectModel: (model: string) => void;
  onConfigureModels: () => void;
  onPickAttachments: () => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  onSelectReasoningLevel: (level: ReasoningLevel) => void;
  onSelectReferencePlanMode: (mode: ReferencePlanMode) => void;
  onClose: () => void;
  anchor: ComposerPopoverAnchor | null;
}) {
  const models = availableModels;
  const pickerMenu = menu === 'models';
  const [morePanel, setMorePanel] = useState<MorePanelMenu | null>(null);
  const referencePlanEnabled = referencePlanMode === 'auto';
  useEffect(() => {
    if (!gitAvailable && morePanel === 'git') {
      setMorePanel(null);
    }
  }, [gitAvailable, morePanel]);
  const selectPermission = (mode: PermissionMode) => {
    onSelectPermissionMode(mode);
    onClose();
  };
  const selectMorePanel = (panel: MorePanelMenu) => {
    setMorePanel((current) => current === panel ? null : panel);
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
        <div className={`more-hierarchy-menu panel-${morePanel}`}>
          <div className="more-hierarchy-primary">
            <MoreMenuRow
              active={false}
              icon={<Paperclip size={13} />}
              title={language === 'zh' ? '文件和文件夹' : 'Files and folders'}
              detail={language === 'zh' ? '添加到当前消息' : 'Add to this message'}
              onClick={onPickAttachments}
            />
            <div className="more-menu-separator" />
            <MoreMenuRow
              active={morePanel === 'project'}
              icon={<BookOpen size={13} />}
              title={language === 'zh' ? '项目上下文' : 'Project'}
              detail={
                activeProjectDir
                  ? compactPath(activeProjectDir)
                  : language === 'zh'
                    ? '无项目'
                    : 'None'
              }
              onClick={() => selectMorePanel('project')}
            />
            {referencePlanAvailable && (
              <MoreMenuRow
                active={morePanel === 'plan'}
                icon={<ListChecks size={13} />}
                title={language === 'zh' ? '复杂任务' : 'Plan'}
                detail={referencePlanEnabled ? (language === 'zh' ? '开' : 'On') : (language === 'zh' ? '关' : 'Off')}
                onClick={() => selectMorePanel('plan')}
              />
            )}
            <MoreMenuRow
              active={morePanel === 'vision'}
              icon={visualInputEnabled ? <Eye size={13} /> : <EyeOff size={13} />}
              title={language === 'zh' ? '视觉功能' : 'Vision'}
              detail={
                visualInputAvailable
                  ? visualInputEnabled
                    ? language === 'zh'
                      ? '开'
                      : 'On'
                    : language === 'zh'
                      ? '关'
                      : 'Off'
                  : language === 'zh'
                    ? '不可用'
                    : 'Unavailable'
              }
              onClick={() => selectMorePanel('vision')}
            />
            <div className="more-menu-separator" />
            <MoreMenuRow
              active={morePanel === 'skills'}
              icon={<Brain size={13} />}
              title="Skills"
              detail={language === 'zh' ? `${skills.length} 个` : `${skills.length}`}
              onClick={() => selectMorePanel('skills')}
            />
            {gitAvailable && (
              <MoreMenuRow
                active={morePanel === 'git'}
                icon={<GitBranch size={13} />}
                title={language === 'zh' ? 'Git 分支' : 'Git'}
                detail={language === 'zh' ? '分支' : 'Branch'}
                onClick={() => selectMorePanel('git')}
              />
            )}
          </div>
          <div className="more-hierarchy-panel">
            {morePanel === 'project' && (
              <ProjectContextEditor
                language={language}
                activeProjectDir={activeProjectDir}
                value={projectContext}
                onSave={onSaveProjectContext}
              />
            )}
            {referencePlanAvailable && morePanel === 'plan' && (
              <div className="more-plan-panel">
                <button
                  className={`more-plan-toggle ${referencePlanEnabled ? 'active' : ''}`}
                  type="button"
                  aria-pressed={referencePlanEnabled}
                  onClick={() =>
                    onSelectReferencePlanMode(referencePlanEnabled ? 'off' : 'auto')
                  }
                >
                  {referencePlanEnabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                  <span>
                    <strong>{language === 'zh' ? '任务计划' : 'Task plan'}</strong>
                    <small>
                      {language === 'zh'
                        ? '允许模型提交并更新可见任务节点。'
                        : 'Allow the model to submit and update visible task nodes.'}
                    </small>
                  </span>
                </button>
                <p>
                  {language === 'zh'
                    ? '默认开启，适合交付、Review、审查和需要核对多个证据的工作；轻量问答不会强制建计划。'
                    : 'Enabled by default for delivery, review, audit, and multi-evidence work; lightweight questions are not forced to create a plan.'}
                </p>
              </div>
            )}
            {morePanel === 'vision' && (
              <div className="more-plan-panel">
                <button
                  className={`more-plan-toggle ${visualInputEnabled ? 'active' : ''}`}
                  type="button"
                  disabled={!visualInputAvailable}
                  aria-pressed={visualInputEnabled}
                  onClick={() => onVisualInputEnabledChange(!visualInputEnabled)}
                >
                  {visualInputEnabled ? <Eye size={14} /> : <EyeOff size={14} />}
                  <span>
                    <strong>{language === 'zh' ? '视觉功能' : 'Vision input'}</strong>
                    <small>
                      {visualInputAvailable
                        ? language === 'zh'
                          ? '显式允许模型接收图片视觉输入。'
                          : 'Explicitly allow images as native vision input.'
                        : language === 'zh'
                          ? '当前后端未声明视觉输入工具。'
                          : 'The backend has not exposed the vision input tool.'}
                    </small>
                  </span>
                </button>
                <p>
                  {language === 'zh'
                    ? '默认关闭。开启后，请求会携带 standard_image_input_enabled=true；关闭时图片仍可作为普通文件路径交给后端处理。'
                    : 'Off by default. When enabled, requests send standard_image_input_enabled=true; when off, images are still passed as regular file paths.'}
                </p>
              </div>
            )}
            {morePanel === 'skills' && (
              <div className="popover-list skill-popover-list nested">
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
                          <Brain size={14} />
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
                          onClick={() => onToggleSkill(skill.name, !enabled)}
                        >
                          {enabled ? <CheckCircle2 size={13} /> : <Circle size={13} />}
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
            {morePanel === 'git' && gitAvailable && (
              <GitBranchMenu language={language} activeProjectDir={activeProjectDir} />
            )}
          </div>
        </div>
      )}
      {menu === 'permissions' && (
        <div className="popover-list permission-mode-list">
          {permissionModeOptions(language).map((option) => (
            <button
              className={`popover-row permission-mode-row mode-${option.id} ${
                option.id === permissionMode ? 'active' : ''
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
              {option.id === permissionMode && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
      {menu === 'project' && (
        <ProjectContextEditor
          language={language}
          activeProjectDir={activeProjectDir}
          value={projectContext}
          onSave={onSaveProjectContext}
        />
      )}
      {menu === 'git' && gitAvailable && (
        <GitBranchMenu language={language} activeProjectDir={activeProjectDir} />
      )}
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
                    <Brain size={16} />
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
                  <small>{config.provider}</small>
                </span>
                {config.id === selectedModel && <Check size={16} />}
              </button>
            ))
          )}
          <div className="model-picker-divider" />
          <ContextWindowMeter usage={contextWindow} language={language} />
          {reasoningLevelAvailable && reasoningLevels.length > 0 && (
            <div className="model-reasoning-section">
              <div className="model-picker-inline-label">
                <span>{language === 'zh' ? '推理强度' : 'Reasoning effort'}</span>
                <strong>{reasoningLevelLabel(reasoningLevel, language)}</strong>
              </div>
              <div className="model-reasoning-options">
                {reasoningLevels.map((level) => (
                  <button
                    className={level === reasoningLevel ? 'active' : ''}
                    type="button"
                    key={level}
                    title={reasoningLevelDescription(level, language)}
                    onClick={() => onSelectReasoningLevel(level)}
                  >
                    {reasoningLevelLabel(level, language)}
                  </button>
                ))}
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
        </div>
      )}
    </div>
  );
}

function composerMenuTitle(menu: Exclude<ComposerMenu, null>, language: AppLanguage) {
  const labels: Record<Exclude<ComposerMenu, null>, { zh: string; en: string }> = {
    more: { zh: '添加', en: 'Add' },
    project: { zh: '项目上下文', en: 'Project context' },
    git: { zh: 'Git 分支', en: 'Git branches' },
    skills: { zh: 'Skills', en: 'Skills' },
    models: { zh: '模型', en: 'Model' },
    permissions: { zh: '权限中心', en: 'Permissions' },
  };
  return labels[menu][language];
}

function reasoningLevelLabel(level: ReasoningLevel, language: AppLanguage) {
  const labels: Record<ReasoningLevel, { zh: string; en: string }> = {
    low: { zh: '低', en: 'Low' },
    medium: { zh: '中', en: 'Medium' },
    high: { zh: '高', en: 'High' },
    max: { zh: '最高', en: 'Max' },
  };
  return labels[level][language];
}

function reasoningLevelDescription(level: ReasoningLevel, language: AppLanguage) {
  const descriptions: Record<ReasoningLevel, { zh: string; en: string }> = {
    low: { zh: '更快，适合直接问题', en: 'Faster for direct questions' },
    medium: { zh: '速度与分析深度平衡', en: 'Balanced speed and depth' },
    high: { zh: '更深入分析复杂问题', en: 'Deeper analysis for complex work' },
    max: { zh: '使用后端允许的最高强度', en: 'Highest effort allowed by backend' },
  };
  return descriptions[level][language];
}

function MoreMenuRow({
  active,
  icon,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`more-menu-row ${active ? 'active' : ''}`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
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
    ? Math.min(1, Math.max(0, usedTokens / maxTokens))
    : 0;
  const percentage = Math.round(ratio * 100);
  const valueLabel = usedTokens != null && maxTokens != null
    ? `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)} · ${percentage}%`
    : maxTokens != null
      ? `${language === 'zh' ? '等待统计' : 'Pending'} / ${compactTokenCount(maxTokens)}`
      : language === 'zh'
        ? '等待后端统计'
        : 'Waiting for usage';

  return (
    <div className="model-context-section">
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
        aria-valuenow={usedTokens != null && maxTokens != null ? percentage : undefined}
      >
        <span style={{ width: `${percentage}%` }} />
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
  if (mode === 'user_free') {
    return <KeyRound size={size} />;
  }
  return <Lock size={size} />;
}

function permissionModeOptions(language: AppLanguage) {
  const options: Array<{
    id: PermissionMode;
    label: string;
    description: string;
  }> = [
    {
      id: 'task_free',
      label: language === 'zh' ? '项目自由' : 'Project free',
      description:
        language === 'zh'
          ? '仅在当前项目和任务工作区内自由读写、执行。'
          : 'Free read, write, and execute inside the current project and task workspace.',
    },
    {
      id: 'user_free',
      label: language === 'zh' ? '家目录自由' : 'Home free',
      description:
        language === 'zh'
          ? '允许在用户目录内操作，仍避开系统级位置。'
          : 'Allow operations inside the user home while avoiding system locations.',
    },
    {
      id: 'all_free',
      label: language === 'zh' ? '完全控制' : 'Full control',
      description:
        language === 'zh'
          ? '请求完全本机控制，后端应强制审计和确认。'
          : 'Request full local control. Backend should enforce audit and confirmation.',
    },
  ];
  return options;
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

function GitBranchMenu({
  language,
  activeProjectDir,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    const root = activeProjectDir?.trim();
    if (!root || !window.cardbushDesktop?.gitInfo) {
      setBranches([]);
      setCurrentBranch('');
      setStatus(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const [info, loadedBranches] = await Promise.all([
        window.cardbushDesktop.gitInfo(root),
        window.cardbushDesktop.gitBranches?.(root) ?? Promise.resolve([]),
      ]);
      setCurrentBranch(info.branch);
      setBranches(loadedBranches);
      if (info.error || info.missing) {
        setStatus(info.error || (language === 'zh' ? '不是 Git 项目' : 'Not a Git project'));
      }
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const switchBranch = useCallback(
    async (branch: string) => {
      const root = activeProjectDir?.trim();
      if (!root || !branch.trim()) {
        return;
      }
      setLoading(true);
      setStatus('');
      try {
        const result = await window.cardbushDesktop!.gitCheckout(root, branch);
        setCurrentBranch(result.branch || branch);
        setStatus(result.output || (language === 'zh' ? '已切换分支' : 'Branch switched'));
        void reload();
      } catch (caught) {
        setStatus(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [activeProjectDir, language, reload],
  );

  const createBranch = useCallback(async () => {
    const root = activeProjectDir?.trim();
    const branch = newBranch.trim();
    if (!root || !branch) {
      setStatus(language === 'zh' ? '请输入新分支名称' : 'Enter a new branch name');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const result = await window.cardbushDesktop!.gitCreateBranch(root, branch);
      setCurrentBranch(result.branch || branch);
      setNewBranch('');
      setStatus(result.output || (language === 'zh' ? '已创建并切换分支' : 'Branch created'));
      void reload();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language, newBranch, reload]);

  return (
    <div className="popover-stack git-branch-menu">
      <p>
        {activeProjectDir?.trim()
          ? activeProjectDir
          : language === 'zh'
            ? '请先打开一个 Git 项目'
            : 'Open a Git project first'}
      </p>
      <div className="branch-create-row">
        <input
          value={newBranch}
          disabled={loading || !activeProjectDir}
          onChange={(event) => setNewBranch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void createBranch();
            }
          }}
          placeholder={language === 'zh' ? '新分支名称' : 'New branch name'}
        />
        <button type="button" disabled={loading || !newBranch.trim()} onClick={() => void createBranch()}>
          <Plus size={14} />
          {language === 'zh' ? '创建' : 'Create'}
        </button>
      </div>
      <div className="branch-list">
        {branches.length === 0 && (
          <span className="popover-status">
            {loading
              ? language === 'zh'
                ? '正在加载分支...'
                : 'Loading branches...'
              : language === 'zh'
                ? '暂无分支列表'
                : 'No branches found'}
          </span>
        )}
        {branches.map((branch) => (
          <button
            className={`popover-row ${branch === currentBranch ? 'active' : ''}`}
            type="button"
            key={branch}
            disabled={loading || branch === currentBranch}
            onClick={() => void switchBranch(branch)}
          >
            <GitBranch size={16} />
            <span>
              <strong>{branch}</strong>
              <small>
                {branch === currentBranch
                  ? language === 'zh'
                    ? '当前分支'
                    : 'Current branch'
                  : language === 'zh'
                    ? '切换到此分支'
                    : 'Switch to this branch'}
              </small>
            </span>
          </button>
        ))}
      </div>
      {status && <p className="popover-status">{status}</p>}
    </div>
  );
}

function ProjectContextEditor({
  language,
  activeProjectDir,
  value,
  onSave,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  value: string;
  onSave?: (value: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
    setStatus('');
  }, [value, activeProjectDir]);

  const save = useCallback(
    async (nextValue: string) => {
      if (!activeProjectDir || !onSave) {
        setStatus(
          language === 'zh'
            ? '请先从左侧打开项目'
            : 'Open a project from the sidebar first',
        );
        return;
      }
      setSaving(true);
      setStatus('');
      try {
        const saved = await onSave(nextValue);
        setDraft(saved);
        setStatus(
          saved.trim()
            ? language === 'zh'
              ? '已保存为项目系统提示词'
              : 'Saved as project system prompt'
            : language === 'zh'
              ? '已清空项目上下文'
              : 'Project context cleared',
        );
      } catch (caught) {
        setStatus(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setSaving(false);
      }
    },
    [activeProjectDir, language, onSave],
  );

  return (
    <div className="popover-stack project-context-editor">
      <p>
        {activeProjectDir
          ? activeProjectDir
          : language === 'zh'
            ? '请先从左侧打开项目'
            : 'Open a project from the sidebar first'}
      </p>
      <textarea
        value={draft}
        disabled={!activeProjectDir || saving}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={
          language === 'zh'
            ? '写给当前项目的长期提示词，例如代码风格、约束、偏好或特殊上下文。发送时会作为项目上下文进入系统提示词，不会插入输入框。'
            : 'Write persistent instructions for this project. They are sent as project context for the system prompt, not inserted into the composer.'
        }
      />
      <div className="popover-actions">
        <button type="button" onClick={() => void save('')} disabled={saving || !activeProjectDir}>
          {language === 'zh' ? '清空' : 'Clear'}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void save(draft)}
          disabled={saving || !activeProjectDir}
        >
          {saving ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
          {language === 'zh' ? '保存' : 'Save'}
        </button>
      </div>
      {status && <p className="popover-status">{status}</p>}
    </div>
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


