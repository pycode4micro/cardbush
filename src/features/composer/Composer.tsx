import {
  ArrowRight,
  ArrowUp,
  Bot,
  BookOpen,
  Boxes,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Code2,
  Edit3,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Lock,
  Network,
  Paperclip,
  Pause,
  Plus,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
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

import {
  basename,
  compactPath,
  fileUrl,
  isImagePath,
} from '../../shared/localPaths';
import type {
  AppLanguage,
  ChatMessage,
  PermissionMode,
  ReferencePlanMode,
  RuntimeProfileSummary,
  SkillSummary,
} from '../../types';
import { ImagePreviewDialog } from '../chatMessages';
import { modelLogoFor } from './modelLogos';
import { quickPayloadText, type QuickLoadPayload } from './quickLoad';

type ProjectFileSearchResult = {
  name: string;
  path: string;
  kind: 'file' | 'folder';
  relativePath: string;
};

type ComposerImageAttachment = {
  id: string;
  path: string;
  name: string;
  previewUrl: string;
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
  | 'tokens'
  | 'git'
  | 'skills'
  | 'runtime'
  | 'models'
  | 'permissions'
  | null;

type MorePanelMenu =
  | 'project'
  | 'runtime'
  | 'skills'
  | 'git'
  | 'tokens'
  | 'plan'
  | 'vision';

type ComposerCommandMode = 'slash' | 'mention';

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
  more: 520,
  project: 300,
  tokens: 214,
  git: 260,
  skills: 336,
  runtime: 310,
  models: 232,
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

function composerPopoverAnchorForMenu(
  anchor: ComposerPopoverAnchor | null,
  menu: Exclude<ComposerMenu, null>,
) {
  if (!anchor) {
    return null;
  }
  const padding = 10;
  const width = Math.min(
    composerPopoverWidths[menu],
    Math.max(180, window.innerWidth - padding * 2),
  );
  return {
    ...anchor,
    x: Math.max(padding, Math.min(anchor.x, window.innerWidth - width - padding)),
    width,
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
  language,
  draft,
  onDraftChange,
  sending,
  queuedMessageCount = 0,
  queuedMessagePreview = '',
  queuedMessages = [],
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  referencePlanMode,
  permissionMode,
  onModelChange,
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onSend,
  onCancel,
  messages = [],
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
}: {
  compact?: boolean;
  language: AppLanguage;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: ComposerQueuedMessage[];
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  onModelChange: (value: string) => void;
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  messages?: ChatMessage[];
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
}) {
  const composerStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [commandState, setCommandState] = useState<ComposerCommandState | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
  const [popoverAnchor, setPopoverAnchor] = useState<ComposerPopoverAnchor | null>(null);
  const [mentionFileResults, setMentionFileResults] = useState<ProjectFileSearchResult[]>([]);
  const [mentionSearchBusy, setMentionSearchBusy] = useState(false);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const hasContent = draft.trim().length > 0 || imageAttachments.length > 0;

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
  }, [compact, draft, imageAttachments.length, resizeComposerTextarea]);

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
    imageAttachments.length,
    updatePopoverMaxHeight,
  ]);

  async function submit() {
    if (sending && !hasContent) {
      await onCancel();
      return;
    }
    if (!hasContent) {
      return;
    }
    const imagePaths = imageAttachments.map((item) => `@${item.path}`);
    const value = [...imagePaths, draft.trimEnd()].filter(Boolean).join('\n');
    onDraftChange('');
    setImageAttachments([]);
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

  function openAnchoredMenu(menu: Exclude<ComposerMenu, null>) {
    setPopoverAnchor((current) => composerPopoverAnchorForMenu(current, menu));
    setActiveMenu(menu);
    setCommandState(null);
  }

  function loadPayload(payload: QuickLoadPayload) {
    onQuickLoad?.(payload);
    setActiveMenu(null);
    setPopoverAnchor(null);
    setCommandState(null);
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

  useEffect(() => {
    if (commandState?.mode !== 'mention') {
      setMentionFileResults([]);
      setMentionSearchBusy(false);
      return undefined;
    }
    const root = activeProjectDir?.trim();
    const searchFiles = window.cardbushDesktop?.searchProjectFiles;
    if (!root || !searchFiles) {
      setMentionFileResults([]);
      setMentionSearchBusy(false);
      return undefined;
    }
    let cancelled = false;
    setMentionSearchBusy(true);
    const timer = window.setTimeout(() => {
      void searchFiles(root, commandState.query)
        .then((results) => {
          if (!cancelled) {
            setMentionFileResults(results);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMentionFileResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setMentionSearchBusy(false);
          }
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProjectDir, commandState?.mode, commandState?.query]);

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
      const next = otherPaths.map((value) => `@${value}`).join('\n');
      onDraftChange(draft.trim() ? `${draft.trimEnd()}\n${next}` : next);
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

  function selectRuntimeProfile(profileId: string) {
    onRuntimeProfileChange(profileId);
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
      const modelItems: ComposerCommandItem[] = availableModels.map((model) => ({
        id: `/model ${model}`,
        title: `/model ${model}`,
        subtitle:
          language === 'zh'
            ? `切换到 ${model}`
            : `Switch to ${model}`,
        icon: <Bot size={16} />,
        run: () => selectModel(model),
        searchText: `/model ${model} model ${model}`,
      }));
      return [
        {
          id: '/help',
          title: '/help',
          subtitle:
            language === 'zh'
              ? '显示常用指令和 @ 文件引用方式'
              : 'Show common commands and @ file references',
          icon: <Circle size={16} />,
          value:
            language === 'zh'
              ? '请说明 CardBush 当前可用的 / 指令、@ 文件引用方式，以及我可以怎样组合使用它们。'
              : 'Explain the available CardBush / commands, @ file references, and how I can combine them.',
        },
        {
          id: '/clear',
          title: '/clear',
          subtitle:
            language === 'zh'
              ? '清空当前输入框内容'
              : 'Clear the current composer text',
          icon: <X size={16} />,
          run: () => onDraftChange(''),
        },
        {
          id: '/new',
          title: '/new',
          subtitle:
            language === 'zh'
              ? '在当前项目中开始新会话'
              : 'Start a fresh session in the current project',
          icon: <Edit3 size={16} />,
          run: () => onCreateConversation?.(),
        },
        {
          id: '/cd',
          title: '/cd <path>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：切换项目目录；在 CardBush 中可直接输入路径让助手处理'
              : 'CLI parity: change project directory; enter a path for the assistant',
          icon: <FolderOpen size={16} />,
          value: '/cd ',
        },
        {
          id: '/changedir',
          title: '/changedir <path>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：/cd 的完整写法'
              : 'CLI parity: long form of /cd',
          icon: <Folder size={16} />,
          value: '/changedir ',
        },
        {
          id: '/model',
          title: '/model',
          subtitle:
            language === 'zh'
              ? '列出或切换已配置模型'
              : 'List or switch configured models',
          icon: <Bot size={16} />,
          run: () => {
            if (availableModels.length === 0) {
              onConfigureModels();
              return;
            }
            setPopoverAnchor(null);
            setActiveMenu('models');
          },
        },
        ...modelItems,
        {
          id: '/skill',
          title: '/skill',
          subtitle:
            language === 'zh'
              ? '查看或选择当前启用的 skills'
              : 'View or choose currently enabled skills',
          icon: <Puzzle size={16} />,
          run: () => {
            setPopoverAnchor(null);
            setActiveMenu('skills');
          },
        },
        {
          id: '/skill-args',
          title: '/skill <all|none|names>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：设置 skill 白名单；GUI 中请到 Skills 面板开启/关闭'
              : 'CLI parity: set skill whitelist; use the Skills panel in the GUI',
          icon: <Puzzle size={16} />,
          run: () => {
            setPopoverAnchor(null);
            setActiveMenu('skills');
          },
        },
        {
          id: '/agents',
          title: '/agents',
          subtitle:
            language === 'zh'
              ? '查看子代理配置和可用场景'
              : 'Review subagent profiles and use cases',
          icon: <Network size={16} />,
          value:
            language === 'zh'
              ? '请帮我查看当前项目适合使用哪些子代理，并说明它们各自的使用场景。'
              : 'Review which subagents fit this project and explain when to use each one.',
        },
        {
          id: '/subagents',
          title: '/subagents',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：管理子代理配置'
              : 'CLI parity: manage subagent profiles',
          icon: <Network size={16} />,
          value:
            language === 'zh'
              ? '请帮我梳理当前可用的子代理配置，并给出推荐的启用策略。'
              : 'Summarize available subagent profiles and recommend an enablement strategy.',
        },
        {
          id: '/subagent',
          title: '/subagent <on|off>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：切换子代理；GUI 暂以对话方式确认'
              : 'CLI parity: toggle subagents; confirm through chat in the GUI',
          icon: <Network size={16} />,
          value: '/subagent ',
        },
        ...(gitAvailable
          ? [
              {
                id: '/git',
                title: '/git',
                subtitle:
                  language === 'zh'
                    ? '打开 Git 分支列表'
                    : 'Open Git branch list',
                icon: <GitBranch size={16} />,
                run: () => {
                  setPopoverAnchor(null);
                  setActiveMenu('git');
                },
              },
            ]
          : []),
        {
          id: '/attach',
          title: '/attach',
          subtitle:
            language === 'zh'
              ? '选择图片或文件插入输入框'
              : 'Pick images or files for this message',
          icon: <Paperclip size={16} />,
          run: () => void pickAttachments(),
        },
        ...(terminalAvailable && onOpenTerminalConsole
          ? [
              {
                id: '/terminal',
                title: '/terminal',
                subtitle:
                  language === 'zh'
                    ? '打开当前项目终端'
                    : 'Open the project terminal',
                icon: <Terminal size={16} />,
                run: () => onOpenTerminalConsole(),
              },
            ]
          : []),
      ];
    },
    [
      availableModels,
      gitAvailable,
      language,
      onConfigureModels,
      onCreateConversation,
      onDraftChange,
      onOpenTerminalConsole,
      selectModel,
      terminalAvailable,
    ],
  );

  const mentionCommands = useMemo<ComposerCommandItem[]>(
    () => {
      const root = activeProjectDir?.trim();
      if (!root) {
        return [
          {
            id: 'no-project',
            title: language === 'zh' ? '当前没有项目目录' : 'No project directory',
            subtitle:
              language === 'zh'
                ? '@ 只提示当前项目下的文件路径'
                : '@ only suggests files from the current project',
            icon: <FolderOpen size={16} />,
            disabled: true,
          },
        ];
      }
      return mentionFileResults.map((item) => {
        const relativePath = item.relativePath || item.name;
        const kindLabel =
          item.kind === 'folder'
            ? language === 'zh'
              ? '文件夹'
              : 'Folder'
            : language === 'zh'
              ? '文件'
              : 'File';
        return {
          id: item.path,
          title: `@${relativePath}`,
          subtitle: `${kindLabel} · ${compactPath(item.path)}`,
          icon: item.kind === 'folder' ? <Folder size={16} /> : <Code2 size={16} />,
          value: `@${item.path} `,
          searchText: `${relativePath} ${item.path} ${item.name}`,
        };
      });
    },
    [activeProjectDir, language, mentionFileResults],
  );

  const commandItems = useMemo(() => {
    if (!commandState) {
      return [];
    }
    const source = commandState.mode === 'slash' ? slashCommands : mentionCommands;
    return rankComposerCommandItems(source, commandState.query, commandState.mode)
      .slice(0, commandState.mode === 'slash' ? 12 : 10);
  }, [commandState, mentionCommands, slashCommands]);

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
    if (commandState?.mode === 'mention') {
      if (item.run) {
        removeCommandToken();
        void item.run();
        return;
      }
      replaceCommandToken(item.value ?? `${item.title} `);
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
  const modelLabel =
    selectedModel.trim() ||
    (language === 'zh' ? '待配置' : 'Configure');
  const runtimeProfileLabel = runtimeProfileDisplayName(
    selectedRuntimeProfile,
    runtimeProfiles,
    language,
  );
  const permissionLabel = permissionModeLabel(permissionMode, language);
  const permissionTitle = permissionModeDescription(permissionMode, language);
  const referencePlanEnabled = referencePlanMode === 'auto';
  const referencePlanLabel =
    language === 'zh' ? '复杂任务计划书' : 'Reference plan';
  const referencePlanDescription =
    language === 'zh'
      ? '开启后，复杂任务会让模型判断是否先生成 PLAN.md；可能增加一点耗时。'
      : 'When enabled, complex tasks let the model decide whether to generate PLAN.md first; this may take a little longer.';
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
      className={`composer-stack ${compact ? 'compact' : ''}`}
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
          mode={commandState.mode}
          query={commandState.query}
          items={commandItems}
          busy={commandState.mode === 'mention' && mentionSearchBusy}
          selectedIndex={commandIndex}
          onSelect={(item) => applyCommand(item)}
        />
      )}
      {activeMenu && (
        <ComposerPopover
          menu={activeMenu}
          language={language}
          messages={messages}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          visualInputAvailable={visualInputAvailable}
          visualInputEnabled={visualInputEnabled}
          gitAvailable={gitAvailable}
          selectedModel={selectedModel}
          availableModels={availableModels}
          selectedRuntimeProfile={selectedRuntimeProfile}
          runtimeProfiles={runtimeProfiles}
          permissionMode={permissionMode}
          referencePlanMode={referencePlanMode}
          activeProjectDir={activeProjectDir}
          projectContext={projectContext}
          onLoad={loadPayload}
          onToggleSkill={onToggleSkill}
          onVisualInputEnabledChange={onVisualInputEnabledChange}
          onSaveProjectContext={onSaveProjectContext}
          onSelectModel={selectModel}
          onSelectRuntimeProfile={selectRuntimeProfile}
          onSelectPermissionMode={onPermissionModeChange}
          onSelectReferencePlanMode={onReferencePlanModeChange}
          onOpenMenu={openAnchoredMenu}
          onConfigureModels={onConfigureModels}
          onClose={() => {
            setActiveMenu(null);
            setPopoverAnchor(null);
          }}
          anchor={popoverAnchor}
        />
      )}
      {previewImage && (
        <ImagePreviewDialog
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
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
        <textarea
          ref={textareaRef}
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
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            language === 'zh'
              ? compact
                ? '问 cardbush 任何事。输入 @ 引用项目文件'
                : '给 cardbush 发消息…'
              : compact
                ? 'Ask cardbush anything. Type @ to reference project files'
                : 'Message cardbush...'
          }
          rows={2}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <ToolChip
              icon={<Boxes size={14} />}
              label={language === 'zh' ? '更多工具' : 'More tools'}
              active={
                activeMenu === 'more' ||
                activeMenu === 'project' ||
                activeMenu === 'tokens' ||
                (gitAvailable && activeMenu === 'git') ||
                activeMenu === 'skills' ||
                activeMenu === 'runtime'
              }
              menuTrigger
              onClick={(event) => toggleMenu('more', event)}
            />
            <ToolChip
              icon={<Paperclip size={15} />}
              label={language === 'zh' ? '附件' : 'Attach'}
              onClick={() => void pickAttachments()}
            />
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
              className="model-select"
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
              <ModelLogoMark model={modelLabel} size={15} />
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
              title={
                sending && hasContent
                  ? language === 'zh'
                    ? '加入发送队列'
                    : 'Queue message'
                  : undefined
              }
              onClick={() => void submit()}
            >
              {sending && !hasContent ? <Pause size={17} /> : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
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
                  disabled={!onEditQueuedMessage}
                  onClick={() => onEditQueuedMessage?.(firstQueuedMessage)}
                >
                  <Edit3 size={12} />
                  <span>{language === 'zh' ? '编辑' : 'Edit'}</span>
                </button>
                <button
                  type="button"
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
  mode,
  query,
  items,
  busy,
  selectedIndex,
  onSelect,
}: {
  language: AppLanguage;
  mode: ComposerCommandMode;
  query: string;
  items: ComposerCommandItem[];
  busy?: boolean;
  selectedIndex: number;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const emptyLabel =
    mode === 'mention'
      ? language === 'zh'
        ? busy
          ? '正在搜索项目文件...'
          : '没有匹配的项目文件'
        : busy
          ? 'Searching project files...'
          : 'No matching project files'
      : language === 'zh'
        ? '没有匹配的指令'
        : 'No matching commands';
  useEffect(() => {
    const row = rowRefs.current[Math.max(0, selectedIndex)];
    row?.scrollIntoView({ block: 'nearest' });
  }, [items.length, selectedIndex]);
  return (
    <div className="composer-command-palette">
      <header>
        <strong>{mode === 'mention' ? '@' : '/'} {query}</strong>
        <span>
          {mode === 'mention'
            ? language === 'zh'
              ? '项目文件'
              : 'Project files'
            : language === 'zh'
              ? '指令'
              : 'Command'}
        </span>
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
  mode: ComposerCommandMode,
) {
  const query = normalizeCommandQuery(rawQuery);
  if (!query) {
    return items;
  }
  if (mode === 'mention') {
    return items.filter((item) =>
      normalizeFileQuery(item.searchText ?? `${item.id} ${item.title} ${item.subtitle}`)
        .includes(normalizeFileQuery(rawQuery)),
    );
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
  const commandName = normalizeCommandQuery(item.title.replace(/^\/+/, ''));
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

function normalizeFileQuery(value: string) {
  return value.toLowerCase().replaceAll('\\', '/').trim();
}

function detectComposerCommand(
  value: string,
  caret: number,
): ComposerCommandState | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const beforeCaret = value.slice(0, safeCaret);
  const lineStart = Math.max(beforeCaret.lastIndexOf('\n') + 1, 0);
  const linePrefix = beforeCaret.slice(lineStart);
  if (/^\/[^\s/]*$/.test(linePrefix)) {
    return {
      mode: 'slash',
      start: lineStart,
      end: safeCaret,
      query: linePrefix.slice(1),
    };
  }
  const mentionMatch = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
  if (!mentionMatch || mentionMatch.index == null) {
    return null;
  }
  const prefix = mentionMatch[1] ?? '';
  const start = mentionMatch.index + prefix.length;
  return {
    mode: 'mention',
    start,
    end: safeCaret,
    query: mentionMatch[2] ?? '',
  };
}

function ComposerPopover({
  menu,
  language,
  messages,
  skills,
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  gitAvailable,
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  permissionMode,
  referencePlanMode,
  activeProjectDir,
  projectContext,
  onLoad,
  onToggleSkill,
  onVisualInputEnabledChange,
  onSaveProjectContext,
  onSelectModel,
  onSelectRuntimeProfile,
  onConfigureModels,
  onSelectPermissionMode,
  onSelectReferencePlanMode,
  onOpenMenu,
  onClose,
  anchor,
}: {
  menu: Exclude<ComposerMenu, null>;
  language: AppLanguage;
  messages: ChatMessage[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  gitAvailable: boolean;
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  permissionMode: PermissionMode;
  referencePlanMode: ReferencePlanMode;
  activeProjectDir?: string;
  projectContext: string;
  onLoad: (payload: QuickLoadPayload) => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onSelectModel: (model: string) => void;
  onSelectRuntimeProfile: (profileId: string) => void;
  onConfigureModels: () => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  onSelectReferencePlanMode: (mode: ReferencePlanMode) => void;
  onOpenMenu: (menu: Exclude<ComposerMenu, null>) => void;
  onClose: () => void;
  anchor: ComposerPopoverAnchor | null;
}) {
  const content = messages.map((message) => message.content).join('\n');
  const chars = content.length;
  const estimatedTokens = Math.ceil(chars / 4);
  const models = Array.from(new Set([selectedModel, ...availableModels].filter(Boolean)));
  const profiles = normalizeRuntimeProfiles(runtimeProfiles, selectedRuntimeProfile);
  const pickerMenu = menu === 'models';
  const [morePanel, setMorePanel] = useState<MorePanelMenu>('project');
  const morePanelHoverTimerRef = useRef<number | null>(null);
  const referencePlanEnabled = referencePlanMode === 'auto';
  useEffect(() => {
    if (!gitAvailable && morePanel === 'git') {
      setMorePanel('project');
    }
  }, [gitAvailable, morePanel]);
  const selectPermission = (mode: PermissionMode) => {
    onSelectPermissionMode(mode);
    onClose();
  };
  const clearMorePanelHoverTimer = useCallback(() => {
    if (morePanelHoverTimerRef.current == null) {
      return;
    }
    window.clearTimeout(morePanelHoverTimerRef.current);
    morePanelHoverTimerRef.current = null;
  }, []);
  const previewMorePanel = useCallback(
    (panel: MorePanelMenu) => {
      clearMorePanelHoverTimer();
      morePanelHoverTimerRef.current = window.setTimeout(() => {
        setMorePanel(panel);
        morePanelHoverTimerRef.current = null;
      }, 70);
    },
    [clearMorePanelHoverTimer],
  );
  const selectMorePanel = useCallback(
    (panel: MorePanelMenu) => {
      clearMorePanelHoverTimer();
      setMorePanel(panel);
    },
    [clearMorePanelHoverTimer],
  );
  useEffect(() => clearMorePanelHoverTimer, [clearMorePanelHoverTimer]);
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
        <div className="more-hierarchy-menu">
          <div className="more-hierarchy-primary">
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
              onHover={() => previewMorePanel('project')}
              onClick={() => onOpenMenu('project')}
            />
            <MoreMenuRow
              active={morePanel === 'runtime'}
              icon={<SlidersHorizontal size={13} />}
              title={language === 'zh' ? '运行模式' : 'Runtime'}
              detail={runtimeProfileDisplayName(selectedRuntimeProfile, profiles, language)}
              onHover={() => previewMorePanel('runtime')}
              onClick={() => onOpenMenu('runtime')}
            />
            <div className="more-menu-separator" />
            <MoreMenuRow
              active={morePanel === 'plan'}
              icon={<ListChecks size={13} />}
              title={language === 'zh' ? '复杂任务' : 'Plan'}
              detail={referencePlanEnabled ? (language === 'zh' ? '开' : 'On') : (language === 'zh' ? '关' : 'Off')}
              onHover={() => previewMorePanel('plan')}
              onClick={() => selectMorePanel('plan')}
            />
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
              onHover={() => previewMorePanel('vision')}
              onClick={() => selectMorePanel('vision')}
            />
            <div className="more-menu-separator" />
            <MoreMenuRow
              active={morePanel === 'skills'}
              icon={<Brain size={13} />}
              title="Skills"
              detail={language === 'zh' ? `${skills.length} 个` : `${skills.length}`}
              onHover={() => previewMorePanel('skills')}
              onClick={() => onOpenMenu('skills')}
            />
            {gitAvailable && (
              <MoreMenuRow
                active={morePanel === 'git'}
                icon={<GitBranch size={13} />}
                title={language === 'zh' ? 'Git 分支' : 'Git'}
                detail={language === 'zh' ? '分支' : 'Branch'}
                onHover={() => previewMorePanel('git')}
                onClick={() => onOpenMenu('git')}
              />
            )}
            <div className="more-menu-separator" />
            <MoreMenuRow
              active={morePanel === 'tokens'}
              icon={<Gauge size={13} />}
              title="Tokens"
              detail={String(estimatedTokens)}
              onHover={() => previewMorePanel('tokens')}
              onClick={() => onOpenMenu('tokens')}
            />
          </div>
          <div className="more-hierarchy-divider" />
          <div className="more-hierarchy-panel">
            {morePanel === 'project' && (
              <ProjectContextEditor
                language={language}
                activeProjectDir={activeProjectDir}
                value={projectContext}
                onSave={onSaveProjectContext}
              />
            )}
            {morePanel === 'runtime' && (
              <div className="popover-list runtime-profile-list nested">
                {profiles.map((profile) => (
                  <button
                    className={`popover-row runtime-profile-row ${
                      profile.id === selectedRuntimeProfile ? 'active' : ''
                    }`}
                    type="button"
                    key={profile.id}
                    onClick={() => onSelectRuntimeProfile(profile.id)}
                  >
                    <RuntimeProfileIcon profileId={profile.id} size={14} />
                    <span>
                      <strong>{runtimeProfileDisplayName(profile.id, profiles, language)}</strong>
                      <small>{runtimeProfileDescription(profile, language)}</small>
                    </span>
                    {profile.id === selectedRuntimeProfile && <Check size={13} />}
                  </button>
                ))}
              </div>
            )}
            {morePanel === 'plan' && (
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
                    <strong>{language === 'zh' ? '复杂任务计划书' : 'Reference plan'}</strong>
                    <small>
                      {language === 'zh'
                        ? '复杂任务时允许先生成 PLAN.md。'
                        : 'Allow PLAN.md before complex tasks.'}
                    </small>
                  </span>
                </button>
                <p>
                  {language === 'zh'
                    ? '适合长任务、跨文件修改和需要复盘的工作；轻量问答建议关闭。'
                    : 'Best for long tasks, multi-file edits, and work that needs a clear checkpoint.'}
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
                          onClick={() =>
                            onLoad({
                              kind: 'text',
                              title: skill.name,
                              value: `@${skill.name}`,
                            })
                          }
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
            {morePanel === 'tokens' && (
              <div className="token-grid nested">
                <TokenStat label={language === 'zh' ? '消息数' : 'Messages'} value={messages.length} />
                <TokenStat label={language === 'zh' ? '字符数' : 'Characters'} value={chars} />
                <TokenStat label="Tokens" value={estimatedTokens} />
              </div>
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
      {menu === 'tokens' && (
        <div className="token-grid">
          <TokenStat label={language === 'zh' ? '消息数' : 'Messages'} value={messages.length} />
          <TokenStat label={language === 'zh' ? '字符数' : 'Characters'} value={chars} />
          <TokenStat label="Tokens" value={estimatedTokens} />
        </div>
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
                    onClick={() =>
                      onLoad({
                        kind: 'text',
                        title: skill.name,
                        value: `@${skill.name}`,
                      })
                    }
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
              <Bot size={15} />
              <span>{language === 'zh' ? '待配置，前往模型设置' : 'Configure models'}</span>
              <ArrowRight size={15} />
            </button>
          ) : (
            models.map((model) => (
              <button
                className={`model-picker-row ${model === selectedModel ? 'active' : ''}`}
                type="button"
                key={model}
                onClick={() => onSelectModel(model)}
              >
                <ModelLogoMark model={model} size={16} />
                <span>{model}</span>
                {model === selectedModel && <Check size={16} />}
              </button>
            ))
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
      {menu === 'runtime' && (
        <div className="popover-list runtime-profile-list">
          {profiles.map((profile) => (
            <button
              className={`popover-row runtime-profile-row ${
                profile.id === selectedRuntimeProfile ? 'active' : ''
              }`}
              type="button"
              key={profile.id}
              onClick={() => onSelectRuntimeProfile(profile.id)}
            >
              <RuntimeProfileIcon profileId={profile.id} size={16} />
              <span>
                <strong>{runtimeProfileDisplayName(profile.id, profiles, language)}</strong>
                <small>{runtimeProfileDescription(profile, language)}</small>
                <small>{runtimeProfileMetaLine(profile, language)}</small>
              </span>
              {profile.id === selectedRuntimeProfile && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function composerMenuTitle(menu: Exclude<ComposerMenu, null>, language: AppLanguage) {
  const labels: Record<Exclude<ComposerMenu, null>, { zh: string; en: string }> = {
    more: { zh: '更多', en: 'More' },
    project: { zh: '项目上下文', en: 'Project context' },
    tokens: { zh: 'Token 用量', en: 'Token usage' },
    git: { zh: 'Git 分支', en: 'Git branches' },
    skills: { zh: 'Skills', en: 'Skills' },
    runtime: { zh: '运行模式', en: 'Runtime' },
    models: { zh: '模型', en: 'Model' },
    permissions: { zh: '权限中心', en: 'Permissions' },
  };
  return labels[menu][language];
}

function RuntimeProfileIcon({
  profileId,
  size = 14,
}: {
  profileId: string;
  size?: number;
}) {
  const normalized = profileId.trim().toLowerCase();
  if (normalized.includes('review')) {
    return <CheckCircle2 size={size} />;
  }
  if (normalized.includes('research')) {
    return <Network size={size} />;
  }
  if (normalized.includes('code')) {
    return <Code2 size={size} />;
  }
  return <Bot size={size} />;
}

function MoreMenuRow({
  active,
  icon,
  title,
  detail,
  onHover,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  detail: string;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <button
      className={`more-menu-row ${active ? 'active' : ''}`}
      type="button"
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onClick}
    >
      {icon}
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={12} />
    </button>
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
    return <Bot className="model-logo-fallback" size={size} />;
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

function normalizeRuntimeProfiles(
  profiles: RuntimeProfileSummary[],
  selectedRuntimeProfile: string,
) {
  const merged = new Map<string, RuntimeProfileSummary>();
  for (const profile of [
    {
      id: 'general',
      label: 'General',
      description: 'General purpose assistant.',
      phases: [],
      allowedLanes: [],
      raw: { id: 'general' },
    },
    {
      id: 'code',
      label: 'Code',
      description: 'Programming workflow: inspect, edit, verify, final.',
      phases: ['inspect', 'edit', 'verify', 'final'],
      allowedLanes: ['code'],
      raw: { id: 'code' },
    },
    {
      id: 'code-review',
      label: 'Code Review',
      description: 'Read-only review focused on findings and risks.',
      phases: ['inspect', 'review', 'final'],
      allowedLanes: ['review'],
      raw: { id: 'code-review' },
    },
    {
      id: 'research',
      label: 'Research',
      description: 'Evidence-first research workflow.',
      phases: ['collect', 'compare', 'synthesize', 'final'],
      allowedLanes: ['research'],
      raw: { id: 'research' },
    },
    ...profiles,
  ]) {
    if (profile.id.trim()) {
      merged.set(profile.id, profile);
    }
  }
  if (selectedRuntimeProfile.trim() && !merged.has(selectedRuntimeProfile)) {
    merged.set(selectedRuntimeProfile, {
      id: selectedRuntimeProfile,
      label: selectedRuntimeProfile,
      description: '',
      phases: [],
      allowedLanes: [],
      raw: { id: selectedRuntimeProfile },
    });
  }
  return [...merged.values()];
}

function runtimeProfileDisplayName(
  profileId: string,
  profiles: RuntimeProfileSummary[],
  language: AppLanguage,
) {
  const normalized = profileId.trim() || 'general';
  if (language === 'zh') {
    const zhLabels: Record<string, string> = {
      general: '通用',
      code: '编程',
      'code-review': '审查',
      research: '研究',
    };
    if (zhLabels[normalized]) {
      return zhLabels[normalized];
    }
  }
  const profile = profiles.find((item) => item.id === normalized);
  return profile?.label?.trim() || normalized;
}

function runtimeProfileDescription(
  profile: RuntimeProfileSummary,
  language: AppLanguage,
) {
  if (language === 'zh') {
    const zhDescriptions: Record<string, string> = {
      general: '普通通用会话，适合问答、计划和轻量任务',
      code: '编程模式，按 inspect / edit / verify / final 推进',
      'code-review': '只读审查模式，优先输出问题、风险和测试缺口',
      research: '证据优先研究模式，强调来源、对照和结论',
    };
    if (zhDescriptions[profile.id]) {
      return zhDescriptions[profile.id];
    }
  }
  if (profile.description.trim()) {
    return profile.description;
  }
  if (profile.phases.length > 0) {
    return profile.phases.join(' / ');
  }
  return profile.defaultLane || profile.id;
}

function runtimeProfileMetaLine(profile: RuntimeProfileSummary, language: AppLanguage) {
  const segments = [
    profile.hookSet
      ? language === 'zh'
        ? `Hook: ${profile.hookSet}`
        : `Hook: ${profile.hookSet}`
      : '',
    profile.phases.length > 0
      ? language === 'zh'
        ? `流程: ${profile.phases.join(' / ')}`
        : `Flow: ${profile.phases.join(' / ')}`
      : '',
    profile.verificationPolicy
      ? language === 'zh'
        ? '含验证策略'
        : 'verification policy'
      : '',
  ].filter(Boolean);
  return segments.join(' · ') || (language === 'zh' ? '默认运行约束' : 'Default runtime constraints');
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

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="token-stat">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
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


