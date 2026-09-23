import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import type { AgentConnectionsController } from '../agents/useAgentConnections';
import { setConversationsArchived, useConversationArchives } from './conversationArchives';
import { showUiError } from '../../shared/showUiError';
import { ConversationExtractionContext, CONVERSATION_DRAG_TYPE, ExtractionMenuIcon } from '../chat/ConversationExtraction';
import { Fragment, useContext } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { WORKSPACE_REVIEW_TURN_LIMIT } from '@cardbush/bush-protocol';
import {
  Archive,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Code2,
  Edit3,
  Eye,
  FolderTree,
  Folder,
  FolderOpen,
  LoaderCircle,
  Mail,
  MailOpen,
  MessageSquare,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { McpLogoIcon } from '../../components/McpLogoIcon';

import { fetchRuntimeTurnToolExecutionDetails } from '../../backend/api';
import { basename, samePath } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { recordUiPerformanceMetric } from '../../shared/uiPerformanceTrace';
import type {
  AppLanguage,
  AppSection,
  ConversationSummary,
  ProjectItem,
  SessionAttentionState,
} from '../../types';
import { sectionLabels } from '../appSections';
import { useAutomationUnreadCount } from '../automations/useAutomationUnreadCount';
import { FileTypeIcon } from '../chatMessages/FileTypeIcon';
import { conversationProjectDir, conversationWorkspaceRoot } from '../conversationWorkspace';
import { ReviewFilePreview } from './ReviewFilePreview';
import { DeferredResizePreview } from '../inspector/DeferredResizePreview';
import { resolveFilePreview } from '../inspector/filePreviewRegistry';
import { ReviewFileTree } from './ReviewFileTree';
import { reviewPathKey, type ReviewTurn } from './reviewModel';
import { conversationMatchesScope } from '../conversationScope';
import { copyText } from '../messageFeedback';
import { useReviewFileNav } from './useReviewFileNav';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { ReviewCommentsFooter, ReviewCommentsScope, type ReviewCommentsChange } from './ReviewComments';
import { reviewRevision, type ReviewComment, type ReviewCommentState } from './reviewCommentModel';
import {
  groupChangeReportsByTurn,
  hydrateConversationChangeReport,
  ToolFileChangeView,
  type ConversationChangeReport,
  type ToolChangeReport,
} from '../tools';
export type ProjectAction =
  | 'pin'
  | 'open'
  | 'refreshGit'
  | 'newChat'
  | 'rename'
  | 'archive'
  | 'remove';

const pinnedConversationStorageKey = 'cardbush_pinned_conversation_ids';
const conversationReadStateStorageKey = 'cardbush_conversation_read_state_v1';

type ConversationReadReceipt = {
  updatedAt: string;
  attentionUpdatedAt: string;
  forcedUnread: boolean;
};

type ConversationReadState = {
  initialized: boolean;
  receipts: Record<string, ConversationReadReceipt>;
};

function readConversationReadState(): ConversationReadState {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(conversationReadStateStorageKey) ?? 'null',
    ) as Partial<ConversationReadState> | null;
    if (!parsed || parsed.initialized !== true || !parsed.receipts) {
      return { initialized: false, receipts: {} };
    }
    const receipts = Object.fromEntries(
      Object.entries(parsed.receipts).flatMap(([conversationId, value]) => {
        if (!value || typeof value !== 'object') return [];
        const receipt = value as Partial<ConversationReadReceipt>;
        return [[conversationId, {
          updatedAt: String(receipt.updatedAt ?? ''),
          attentionUpdatedAt: String(receipt.attentionUpdatedAt ?? ''),
          forcedUnread: receipt.forcedUnread === true,
        } satisfies ConversationReadReceipt]];
      }),
    );
    return { initialized: true, receipts };
  } catch {
    return { initialized: false, receipts: {} };
  }
}

function conversationReadReceipt(
  conversation: ConversationSummary,
  attention?: SessionAttentionState,
  forcedUnread = false,
): ConversationReadReceipt {
  return {
    updatedAt: conversation.updatedAt ?? '',
    attentionUpdatedAt: attention?.updatedAt ?? '',
    forcedUnread,
  };
}

function readPinnedConversationIds() {
  try {
    const value = JSON.parse(window.localStorage.getItem(pinnedConversationStorageKey) ?? '[]');
    return new Set(
      Array.isArray(value)
        ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

type SidebarContextMenuItem = {
  key: string;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: SidebarContextMenuItem[];
  onClick?: () => void;
};

type SidebarContextMenuState = {
  id: string;
  x: number;
  y: number;
  items: SidebarContextMenuItem[];
  anchor?: HTMLButtonElement;
  focusFirst?: boolean;
};

type ConversationMenuOptions = {
  changeCount: number;
  pinned: boolean;
  unread: boolean;
  onTogglePin: () => void;
  onToggleRead: () => void;
  onOpenChanges?: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

function sidebarContextMenuPosition(clientX: number, clientY: number, items: SidebarContextMenuItem[]) {
  const padding = 8;
  const menuWidth = Math.min(280, window.innerWidth - padding * 2);
  const separators = items.filter((item, index) => index > 0 && item.separatorBefore).length;
  const menuHeight = Math.min(window.innerHeight - padding * 2, Math.max(1, items.length) * 34 + separators * 21 + 18);
  const pointerOffset = 2;
  const targetX = clientX + pointerOffset;
  const targetY = clientY + pointerOffset;
  return {
    x: Math.max(padding, Math.min(targetX, window.innerWidth - menuWidth - padding)),
    y: Math.max(padding, Math.min(targetY, window.innerHeight - menuHeight - padding)),
  };
}

export const ChatSidebar = memo(function ChatSidebar({
  language,
  section,
  activeConversationId,
  runningConversationIds,
  attentionByConversation,
  projects: projectItems,
  conversations: conversationItems,
  changeReportsByConversation,
  onSectionChange,
  onConversationChange,
  onCreateConversation,
  onAddProject,
  onProjectAction,
  onDeleteConversation,
  onRenameConversation,
  onConversationWorkspaceChange,
  onOpenConversationChanges,
  onOpenSettings,
  onOpenArchives,
  onOpenPlugins,
  onOpenSearch,
  softVisible = true,
  agents = [],
  activeAgentId,
  onAgentSelect,
  agentSessions,
}: {
  agents?: Array<{ id: string; name: string }>;
  activeAgentId?: string;
  onAgentSelect?: (id: string, sessionId?: string, view?: 'chat' | 'settings') => void;
  agentSessions?: AgentConnectionsController;
  language: AppLanguage;
  section: AppSection;
  activeConversationId: string;
  runningConversationIds?: Set<string>;
  attentionByConversation?: Record<string, SessionAttentionState>;
  projects: ProjectItem[];
  conversations: ConversationSummary[];
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onSectionChange: (value: AppSection) => void;
  onConversationChange: (id: string) => void;
  onCreateConversation: () => void;
  onAddProject: () => void;
  onProjectAction: (action: ProjectAction, project: ProjectItem) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<boolean>;
  onConversationWorkspaceChange?: (conversationId: string, project: ProjectItem | null) => Promise<void>;
  onOpenConversationChanges: (conversationId: string) => void;
  onOpenSettings: () => void;
  onOpenArchives?: () => void;
  onOpenPlugins: () => void;
  onOpenSearch: () => void;
  softVisible?: boolean;
}) {
  const sidebarRenderStartedAt = performance.now();
  useLayoutEffect(() => {
    recordUiPerformanceMetric('sidebar_commit_ms', {
      sessionId: activeConversationId,
      value: performance.now() - sidebarRenderStartedAt,
    });
  });
  const t = (id: AppSection) => sectionLabels[id][language];
  const keyboardShortcuts = useKeyboardShortcuts();
  const searchLabel = language === 'zh' ? '搜索会话' : 'Search chats';
  const searchShortcut = keyboardShortcuts.label('searchConversations');
  const unreadAutomations = useAutomationUnreadCount();
  const archivedConversationIds = useConversationArchives();
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const extraction = useContext(ConversationExtractionContext);
  const extractionShortcuts = useKeyboardShortcuts();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(['agents', 'pinned', 'projects', 'recent']),
  );
  const [expandedAgentIds, setExpandedAgentIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (activeAgentId) setExpandedAgentIds(current => new Set([...current, activeAgentId]));
  }, [activeAgentId]);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pinnedConversationIds, setPinnedConversationIds] = useState<Set<string>>(
    readPinnedConversationIds,
  );
  const [conversationReadState, setConversationReadState] = useState<ConversationReadState>(
    readConversationReadState,
  );
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [draggedConversationId, setDraggedConversationId] = useState('');
  const [workspaceDropTarget, setWorkspaceDropTarget] = useState<string | null>(null);
  const [movingConversations, setMovingConversations] = useState<Set<string>>(() => new Set());
  const workspaceMovesRef = useRef(new Set<string>());

  async function moveConversation(conversationId: string, project: ProjectItem | null) {
    if (!onConversationWorkspaceChange || workspaceMovesRef.current.has(conversationId) || runningConversationIds?.has(conversationId) || project?.missing || project?.archived) return;
    const conversation = conversationItems.find(item => item.id === conversationId);
    if (!conversation) return;
    if (project ? conversationMatchesScope(conversation, { mode: 'project', projectId: project.id, projectDir: project.rootPath }) : !conversationProjectDir(conversation)) return;
    workspaceMovesRef.current.add(conversationId);
    setMovingConversations(new Set(workspaceMovesRef.current));
    try {
      await onConversationWorkspaceChange(conversationId, project);
      if (project) setExpandedProjectIds(current => new Set([...current, project.id]));
      setExpandedSections(current => new Set([...current, project ? (project.pinned ? 'pinned' : 'projects') : 'recent']));
    } catch (error) {
      void showUiError(language === 'zh' ? '切换工作区失败' : 'Workspace switch failed', String(error));
    } finally {
      workspaceMovesRef.current.delete(conversationId);
      setMovingConversations(new Set(workspaceMovesRef.current));
    }
  }

  function workspaceDropHandlers(project: ProjectItem | null) {
    const key = project?.id ?? 'recent';
    const accepts = (event: React.DragEvent) => Boolean(onConversationWorkspaceChange && draggedConversationId &&
      event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE) && !runningConversationIds?.has(draggedConversationId) &&
      !movingConversations.has(draggedConversationId) && !project?.missing && !project?.archived);
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
        setWorkspaceDropTarget(key);
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setWorkspaceDropTarget(null);
      },
      onDrop: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault(); event.stopPropagation();
        const id = event.dataTransfer.getData(CONVERSATION_DRAG_TYPE);
        setWorkspaceDropTarget(null); setDraggedConversationId('');
        if (id === draggedConversationId) void moveConversation(id, project);
      },
    };
  }
  const visibleProjects = useMemo(
    () => projectItems.filter((project) => !project.archived),
    [projectItems],
  );
  const visibleConversations = useMemo(
    () =>
      conversationItems.filter(
        (conversation) => !archivedConversationIds.has(conversation.id),
      ),
    [archivedConversationIds, conversationItems],
  );
  const pinnedProjects = useMemo(
    () => visibleProjects.filter((project) => project.pinned),
    [visibleProjects],
  );
  const regularProjects = useMemo(
    () => visibleProjects.filter((project) => !project.pinned),
    [visibleProjects],
  );
  const pinnedConversations = useMemo(
    () => visibleConversations.filter((conversation) => pinnedConversationIds.has(conversation.id)),
    [pinnedConversationIds, visibleConversations],
  );
  const regularConversations = useMemo(
    () => visibleConversations.filter((conversation) => !pinnedConversationIds.has(conversation.id)),
    [pinnedConversationIds, visibleConversations],
  );
  const recentConversations = useMemo(
    () => regularConversations.filter(conversation => !projectItems.some(project =>
      conversationMatchesScope(conversation, { mode: 'project', projectId: project.id, projectDir: project.rootPath }),
    )),
    [projectItems, regularConversations],
  );
  const unreadConversationIds = useMemo(() => {
    if (!conversationReadState.initialized) return new Set<string>();
    return new Set(
      conversationItems.flatMap((conversation) => {
        const receipt = conversationReadState.receipts[conversation.id];
        const attentionUpdatedAt = attentionByConversation?.[conversation.id]?.updatedAt ?? '';
        const unread = !receipt || receipt.forcedUnread ||
          receipt.updatedAt !== (conversation.updatedAt ?? '') ||
          receipt.attentionUpdatedAt !== attentionUpdatedAt;
        return unread ? [conversation.id] : [];
      }),
    );
  }, [attentionByConversation, conversationItems, conversationReadState]);

  const setConversationUnread = useCallback((conversationId: string, unread: boolean) => {
    const conversation = conversationItems.find((item) => item.id === conversationId);
    if (!conversation) return;
    const receipt = conversationReadReceipt(
      conversation,
      attentionByConversation?.[conversationId],
      unread,
    );
    setConversationReadState((current) => ({
      initialized: true,
      receipts: { ...current.receipts, [conversationId]: receipt },
    }));
  }, [attentionByConversation, conversationItems]);

  useEffect(() => {
    if (conversationReadState.initialized || conversationItems.length === 0) return;
    setConversationReadState({
      initialized: true,
      receipts: Object.fromEntries(conversationItems.map((conversation) => [
        conversation.id,
        conversationReadReceipt(conversation, attentionByConversation?.[conversation.id]),
      ])),
    });
  }, [attentionByConversation, conversationItems, conversationReadState.initialized]);

  useEffect(() => {
    if (!conversationReadState.initialized) return;
    window.localStorage.setItem(
      conversationReadStateStorageKey,
      JSON.stringify(conversationReadState),
    );
  }, [conversationReadState]);

  useEffect(() => {
    if (!conversationReadState.initialized || !activeConversationId) return;
    const markVisibleConversationRead = () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const active = conversationItems.find((item) => item.id === activeConversationId);
      if (!active) return;
      const nextReceipt = conversationReadReceipt(
        active,
        attentionByConversation?.[activeConversationId],
      );
      setConversationReadState((current) => {
        const previous = current.receipts[activeConversationId];
        if (
          previous && !previous.forcedUnread &&
          previous.updatedAt === nextReceipt.updatedAt &&
          previous.attentionUpdatedAt === nextReceipt.attentionUpdatedAt
        ) {
          return current;
        }
        return {
          initialized: true,
          receipts: { ...current.receipts, [activeConversationId]: nextReceipt },
        };
      });
    };
    markVisibleConversationRead();
    window.addEventListener('focus', markVisibleConversationRead);
    document.addEventListener('visibilitychange', markVisibleConversationRead);
    return () => {
      window.removeEventListener('focus', markVisibleConversationRead);
      document.removeEventListener('visibilitychange', markVisibleConversationRead);
    };
  }, [
    activeConversationId,
    attentionByConversation,
    conversationItems,
    conversationReadState.initialized,
  ]);
  useEffect(() => {
    const active = visibleConversations.find(
      (conversation) => conversation.id === activeConversationId,
    );
    if (!active) {
      return;
    }
    const activeProjectDir = conversationProjectDir(active);
    if (!activeProjectDir) return;
    const project = visibleProjects.find((item) => samePath(item.rootPath, activeProjectDir));
    if (!project) return;
    const targetSection = project.pinned ? 'pinned' : 'projects';
    setExpandedSections((current) =>
      current.has(targetSection) ? current : new Set(current).add(targetSection),
    );
    setExpandedProjectIds((current) =>
      current.has(project.id) ? current : new Set(current).add(project.id),
    );
  }, [activeConversationId, visibleConversations, visibleProjects]);

  const closeMenus = useCallback(() => {
    setContextMenu(null);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      pinnedConversationStorageKey,
      JSON.stringify([...pinnedConversationIds]),
    );
  }, [pinnedConversationIds]);

  const toggleConversationPin = useCallback((conversationId: string) => {
    setPinnedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.sidebar-context-menu') ||
        target.closest('[data-sidebar-menu-trigger="true"]')
      ) {
        return;
      }
      closeMenus();
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [closeMenus, contextMenu]);

  function openContextMenu(
    event: ReactMouseEvent,
    id: string,
    items: SidebarContextMenuItem[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    const position = sidebarContextMenuPosition(event.clientX, event.clientY, items);
    setContextMenu({ id, items, ...position });
  }

  function runContextMenuItem(item: SidebarContextMenuItem) {
    if (item.disabled) {
      return;
    }
    if (item.children?.length) {
      return;
    }
    closeMenus();
    item.onClick?.();
  }

  function toggleConversationArchive(conversationId: string) {
    closeMenus();
    try {
      setConversationsArchived([conversationId], !archivedConversationIds.has(conversationId));
    } catch (error) {
      void showUiError(language === 'zh' ? '归档失败' : 'Archive failed', String(error));
    }
  }

  function toggleSection(sectionId: string) {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function projectMenuItems(project: ProjectItem): SidebarContextMenuItem[] {
    return [
      {
        key: 'pin',
        icon: <Pin size={15} />,
        label: project.pinned
          ? language === 'zh'
            ? '取消置顶'
            : 'Unpin'
          : language === 'zh'
            ? '置顶项目'
            : 'Pin project',
        onClick: () => onProjectAction('pin', project),
      },
      {
        key: 'open',
        icon: <FolderOpen size={15} />,
        label: project.rootPath.startsWith('ssh://')
          ? language === 'zh' ? '选择远程目录…' : 'Choose remote directory…'
          : language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer',
        disabled: project.missing,
        onClick: () => onProjectAction('open', project),
      },
      {
        key: 'refresh',
        icon: <RefreshCw size={15} />,
        label: language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status',
        disabled: project.missing,
        onClick: () => onProjectAction('refreshGit', project),
      },
      {
        key: 'new-chat',
        separatorBefore: true,
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '新建项目会话' : 'New project chat',
        disabled: project.missing,
        onClick: () => onProjectAction('newChat', project),
      },
      {
        key: 'rename',
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '重命名项目' : 'Rename project',
        onClick: () => onProjectAction('rename', project),
      },
      {
        key: 'archive',
        separatorBefore: true,
        icon: <Archive size={15} />,
        label: language === 'zh' ? '归档项目' : 'Archive project',
        onClick: () => onProjectAction('archive', project),
      },
      {
        key: 'remove',
        icon: <X size={15} />,
        label: language === 'zh' ? '移除' : 'Remove',
        danger: true,
        onClick: () => onProjectAction('remove', project),
      },
    ];
  }

  function conversationMenuItems(
    conversation: ConversationSummary,
    options: ConversationMenuOptions,
  ): SidebarContextMenuItem[] {
    const items: SidebarContextMenuItem[] = [
      {
        key: 'open',
        icon: <MessageSquare size={15} />,
        label: language === 'zh' ? '打开对话' : 'Open chat',
        onClick: () => onConversationChange(conversation.id),
      },
      {
        key: 'pin',
        icon: <Pin size={15} />,
        label: options.pinned
          ? language === 'zh' ? '取消置顶' : 'Unpin chat'
          : language === 'zh' ? '置顶对话' : 'Pin chat',
        onClick: options.onTogglePin,
      },
      {
        key: options.unread ? 'mark-read' : 'mark-unread',
        icon: options.unread ? <MailOpen size={15} /> : <Mail size={15} />,
        label: options.unread
          ? language === 'zh' ? '标记为已读' : 'Mark as read'
          : language === 'zh' ? '标记为未读' : 'Mark as unread',
        onClick: options.onToggleRead,
      },
    ];
    if (options.changeCount > 0) {
      items.push({
        key: 'diff',
        icon: <Code2 size={15} />,
        label: language === 'zh' ? '查看 Diff' : 'View diff',
        onClick: options.onOpenChanges,
      });
    }
    if (onConversationWorkspaceChange) items.push({
      key: 'workspace', icon: <FolderOpen size={15} />, label: language === 'zh' ? '切换工作区' : 'Switch workspace',
      disabled: Boolean(runningConversationIds?.has(conversation.id) || movingConversations.has(conversation.id)),
      children: [
        ...visibleProjects.filter(project => !project.missing).map(project => ({
          key: `workspace:${project.id}`, icon: <Folder size={15} />, label: project.title,
          disabled: conversationMatchesScope(conversation, { mode: 'project' as const, projectId: project.id, projectDir: project.rootPath }),
          onClick: () => { void moveConversation(conversation.id, project); },
        })),
        { key: 'workspace:none', icon: <MessageSquare size={15} />, label: language === 'zh' ? '独立工作区（不关联项目）' : 'Task workspace (no project)',
          disabled: !conversationProjectDir(conversation), onClick: () => { void moveConversation(conversation.id, null); } },
      ],
    });
    items.push(
      {
        separatorBefore: true,
        key: 'extract', icon: <ExtractionMenuIcon />, label: language === 'zh' ? '提取对话' : 'Extract conversation', shortcut: extractionShortcuts.label('extractConversation'),
        disabled: !extraction, onClick: () => extraction?.open(conversation.id),
      },
      {
        key: 'fork', icon: <ExtractionMenuIcon fork />, label: language === 'zh' ? 'Fork 会话' : 'Fork conversation',
        disabled: !extraction, onClick: () => extraction?.fork(conversation.id),
      },
      {
        key: 'rename',
        separatorBefore: true,
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '重命名对话' : 'Rename chat',
        onClick: options.onRename,
      },
      {
        key: 'copy-id',
        icon: <Clipboard size={15} />,
        label: language === 'zh' ? '复制会话 ID' : 'Copy session ID',
        onClick: () => void copyText(conversation.id),
      },
      {
        key: 'archive',
        separatorBefore: true,
        icon: <Archive size={15} />,
        label: language === 'zh' ? '归档对话' : 'Archive chat',
        onClick: options.onArchive,
      },
      {
        key: 'delete',
        icon: <Trash2 size={15} />,
        label: language === 'zh' ? '删除对话' : 'Delete chat',
        danger: true,
        onClick: options.onDelete,
      },
    );
    return items;
  }

  function renderProjectBlock(project: ProjectItem) {
    return (
      <div key={project.id} data-workspace-drop={project.id}
        className={`workspace-drop-target${workspaceDropTarget === project.id ? ' workspace-drop-active' : ''}`}
        {...workspaceDropHandlers(project)}>
      <ProjectBlock
        key={project.id}
        project={project}
        conversations={regularConversations.filter(item => conversationMatchesScope(item, {
          mode: 'project', projectId: project.id, projectDir: project.rootPath,
        }))}
        activeConversationId={activeConversationId}
        runningConversationIds={runningConversationIds}
        attentionByConversation={attentionByConversation}
        unreadConversationIds={unreadConversationIds}
        language={language}
        expanded={expandedProjectIds.has(project.id)}
        onToggleExpanded={() => toggleProject(project.id)}
        onContextMenu={(event) =>
          openContextMenu(event, `project:${project.id}`, projectMenuItems(project))
        }
        onProjectAction={(action) => {
          closeMenus();
          onProjectAction(action, project);
        }}
        onConversationChange={onConversationChange}
        onConversationArchive={toggleConversationArchive}
        onDeleteConversation={onDeleteConversation}
        onRenameConversation={onRenameConversation}
        onConversationContextMenu={(event, conversation, options) =>
          openContextMenu(
            event,
            `conversation:${conversation.id}`,
            conversationMenuItems(conversation, options),
          )
        }
        pinnedConversationIds={pinnedConversationIds}
        onToggleConversationPin={toggleConversationPin}
        onToggleConversationRead={(conversationId) =>
          setConversationUnread(conversationId, !unreadConversationIds.has(conversationId))
        }
        changeReportsByConversation={changeReportsByConversation}
        onOpenConversationChanges={onOpenConversationChanges}
      />
      </div>
    );
  }

  function renderStandaloneConversation(conversation: ConversationSummary) {
    return (
      <ConversationRow
        key={conversation.id}
        conversation={conversation}
        active={conversation.id === activeConversationId}
        running={runningConversationIds?.has(conversation.id) ?? false}
        attention={attentionByConversation?.[conversation.id]}
        unread={unreadConversationIds.has(conversation.id)}
        pinned={pinnedConversationIds.has(conversation.id)}
        language={language}
        onTogglePin={() => toggleConversationPin(conversation.id)}
        onToggleRead={() =>
          setConversationUnread(conversation.id, !unreadConversationIds.has(conversation.id))
        }
        onArchive={() => toggleConversationArchive(conversation.id)}
        onDelete={() => onDeleteConversation(conversation.id)}
        changeReports={changeReportsByConversation[conversation.id] ?? []}
        onOpenChanges={() => onOpenConversationChanges(conversation.id)}
        onRename={(nextTitle) => onRenameConversation(conversation.id, nextTitle)}
        onContextMenu={(event, options) =>
          openContextMenu(
            event,
            `conversation:${conversation.id}`,
            conversationMenuItems(conversation, options),
          )
        }
        onClick={() => {
          setConversationUnread(conversation.id, false);
          onConversationChange(conversation.id);
        }}
      />
    );
  }

  return (
    <aside
      className={`sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      ref={sidebarRef}
      aria-hidden={!softVisible}
      inert={softVisible ? undefined : true}
      onDragStart={event => setDraggedConversationId(event.dataTransfer.getData(CONVERSATION_DRAG_TYPE))}
      onDragEnd={() => { setDraggedConversationId(''); setWorkspaceDropTarget(null); }}
      aria-busy={movingConversations.size > 0}
    >
      <div className="sidebar-panel-content">
      <nav className="sidebar-nav">
        <NavRow
          icon={<Edit3 size={14} />}
          label={language === 'zh' ? '新会话' : 'New chat'}
          onClick={onCreateConversation}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:new-chat', [
              {
                key: 'new-chat',
                icon: <Edit3 size={15} />,
                label: language === 'zh' ? '新建普通对话' : 'New chat',
                onClick: onCreateConversation,
              },
            ])
          }
        />
        <NavRow
          active={section === 'plugins'}
          icon={<McpLogoIcon size={16} />}
          label={language === 'zh' ? '插件' : 'Plugins'}
          onClick={onOpenPlugins}
        />
        <NavRow active={section === 'automations'} icon={<CalendarClock size={14}/>} label={t('automations')} trailing={unreadAutomations > 0 ? <span className="automation-nav-count" aria-label={language === 'zh' ? `${unreadAutomations} 条未读结果` : `${unreadAutomations} unread results`}>{unreadAutomations > 99 ? '99+' : unreadAutomations}</span> : undefined} onClick={() => onSectionChange('automations')} />
      </nav>

      <div className="sidebar-scroll">
        <div className="sidebar-sections">
              <SectionHeader
                title={language === 'zh' ? '置顶' : 'Pinned'}
                action={<Pin size={14} />}
                actionLabel={language === 'zh' ? '置顶内容' : 'Pinned items'}
                expanded={expandedSections.has('pinned')}
                onToggle={() => toggleSection('pinned')}
              />
              {expandedSections.has('pinned') && (
                pinnedProjects.length > 0 || pinnedConversations.length > 0
                  ? <>{pinnedProjects.map(renderProjectBlock)}{pinnedConversations.map(renderStandaloneConversation)}</>
                  : (
                    <div className="sidebar-pinned-empty">
                      {language === 'zh' ? '右键项目或对话即可置顶' : 'Right-click a project or chat to pin it'}
                    </div>
                  )
              )}

              <SectionHeader title="Agents" action={<Plus size={14}/>} actionLabel={language === 'zh' ? '管理 Agents' : 'Manage Agents'} expanded={expandedSections.has('agents')} onToggle={() => toggleSection('agents')} onAction={() => onAgentSelect ? onAgentSelect('') : onSectionChange('agents')} />
              {expandedSections.has('agents') && <div className="sidebar-agent-list">
                {agents.map(agent => {
                  const expanded = expandedAgentIds.has(agent.id);
                  const list = agentSessions?.sessionsByAgent[agent.id];
                  const visibleSessions = list?.sessions.filter(session => !session.metadata?.archived) ?? [];
                  const active = section === 'agents' && activeAgentId === agent.id;
                  const create = () => { onAgentSelect?.(agent.id, ''); void agentSessions?.createSession(agent.id, language === 'zh' ? '新对话' : 'New conversation'); };
                  const manage = () => onAgentSelect?.(agent.id, undefined, 'settings');
                  const toggle = () => {
                    setExpandedAgentIds(current => { const next = new Set(current); if (expanded) next.delete(agent.id); else next.add(agent.id); return next; });
                    if (!expanded) { onAgentSelect?.(agent.id); void agentSessions?.refreshSessions(agent.id).catch(() => undefined); }
                  };
                  return <div key={agent.id} className="project-block agent-sidebar-group" data-agent-id={agent.id}>
                    <div className={`project-row agent-sidebar-row${active ? ' active' : ''}`} role="button" tabIndex={0} aria-expanded={expanded} onClick={toggle}
                      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } }}
                      onContextMenu={event => openContextMenu(event, `agent:${agent.id}`, [
                        { key: 'new', icon: <Plus size={15}/>, label: language === 'zh' ? '新建会话' : 'New chat', disabled: list?.creating, onClick: create },
                        { key: 'manage', icon: <Settings size={15}/>, label: language === 'zh' ? '管理此 Agent' : 'Manage Agent', onClick: manage },
                      ])}>
                      <ChevronRight size={14} className={`agent-tree-chevron${expanded ? ' expanded' : ''}`} aria-hidden="true"/>
                      <div className="project-title"><span>{agent.name}</span></div>
                      <button className="row-new-chat" type="button" disabled={list?.creating} aria-label={language === 'zh' ? `在 ${agent.name} 新建会话` : `New chat in ${agent.name}`} onClick={event => { event.stopPropagation(); create(); }}><Plus size={14}/></button>
                      <button className="row-archive" type="button" aria-label={language === 'zh' ? `管理 ${agent.name}` : `Manage ${agent.name}`} onClick={event => { event.stopPropagation(); manage(); }}><Settings size={14}/></button>
                    </div>
                    {expanded && <>
                      {visibleSessions
                        .sort((a, b) => Number(Boolean(b.metadata?.pinned)) - Number(Boolean(a.metadata?.pinned)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
                        .map(session => {
                        const pinned = session.metadata?.pinned === true;
                        const unread = session.metadata?.forcedUnread === true || (typeof session.metadata?.readAt === 'string' && String(session.updatedAt) > session.metadata.readAt);
                        const update = (patch: Record<string, unknown>) => { if (list?.management) void agentSessions?.updateSession(agent.id, session.sessionId, patch); };
                        const open = () => { onAgentSelect?.(agent.id, session.sessionId); update({ readAt: new Date().toISOString(), forcedUnread: false }); };
                        return <ConversationRow key={session.sessionId}
                        conversation={{ id: session.sessionId, title: String(session.metadata?.title || (language === 'zh' ? '新对话' : 'Conversation')), preview: '', updatedAt: session.updatedAt ?? '' }}
                        active={active && agentSessions?.views[agent.id] !== 'settings' && agentSessions?.selectedSessions[agent.id] === session.sessionId}
                        nested remote unread={unread} pinned={pinned} language={language}
                        onTogglePin={() => update({ pinned: !pinned })} onToggleRead={() => update({ forcedUnread: !unread, ...(!unread ? {} : { readAt: new Date().toISOString() }) })} onArchive={() => update({ archived: true })}
                        onRename={title => agentSessions!.renameSession(agent.id, session.sessionId, title)}
                        onDelete={() => void agentSessions?.deleteSession(agent.id, session.sessionId)}
                        onClick={open}
                        onContextMenu={(event, options) => openContextMenu(event, `agent:${agent.id}:${session.sessionId}`, [
                          { key: 'open', icon: <MessageSquare size={15}/>, label: language === 'zh' ? '打开对话' : 'Open chat', onClick: open },
                          ...(list?.management ? [
                            { key: 'pin', icon: <Pin size={15}/>, label: pinned ? (language === 'zh' ? '取消置顶' : 'Unpin chat') : (language === 'zh' ? '置顶对话' : 'Pin chat'), onClick: options.onTogglePin },
                            { key: 'read', icon: unread ? <MailOpen size={15}/> : <Mail size={15}/>, label: unread ? (language === 'zh' ? '标记为已读' : 'Mark as read') : (language === 'zh' ? '标记为未读' : 'Mark as unread'), onClick: options.onToggleRead },
                            { key: 'workspace', icon: <FolderOpen size={15}/>, label: language === 'zh' ? '切换工作区' : 'Switch workspace', children: [
                              ...(list.projects ?? []).map(project => ({ key: project.id, label: project.name, icon: <Folder size={15}/>, disabled: session.metadata?.projectId === project.id, onClick: () => void agentSessions?.bindSession(agent.id, session.sessionId, project.id) })),
                              { key: 'none', icon: <MessageSquare size={15}/>, label: language === 'zh' ? '独立工作区（不关联项目）' : 'Task workspace (no project)', disabled: !session.metadata?.projectId, onClick: () => void agentSessions?.bindSession(agent.id, session.sessionId, null) },
                            ] },
                            { key: 'fork', icon: <ExtractionMenuIcon fork/>, label: language === 'zh' ? 'Fork 会话' : 'Fork conversation', onClick: () => void agentSessions?.forkSession(agent.id, session.sessionId) },
                          ] : []),
                          { key: 'rename', icon: <Edit3 size={15}/>, label: language === 'zh' ? '重命名对话' : 'Rename chat', onClick: options.onRename },
                          { key: 'copy', icon: <Clipboard size={15}/>, label: language === 'zh' ? '复制会话 ID' : 'Copy chat ID', onClick: () => void copyText(session.sessionId) },
                          { key: 'copy-chat', icon: <Clipboard size={15}/>, label: language === 'zh' ? '复制对话' : 'Copy conversation', onClick: () => void agentSessions?.copySession(agent.id, session.sessionId) },
                          ...(list?.management ? [{ key: 'archive', icon: <Archive size={15}/>, label: language === 'zh' ? '归档对话' : 'Archive chat', separatorBefore: true, onClick: options.onArchive }] : []),
                          { key: 'delete', icon: <Trash2 size={15}/>, label: language === 'zh' ? '删除对话' : 'Delete chat', separatorBefore: true, danger: true, onClick: options.onDelete },
                        ])}
                      />; })}
                      {list?.loading && !visibleSessions.length && <div className="agent-sidebar-notice" role="status">{language === 'zh' ? '正在加载会话…' : 'Loading chats…'}</div>}
                      {!list?.loading && !list?.error && !visibleSessions.length && <button className="conversation-row nested agent-sidebar-empty" onClick={create} disabled={list?.creating}>{language === 'zh' ? '新建会话' : 'New chat'}</button>}
                      {list?.error && <div className="agent-sidebar-notice" role="alert"><span>{list.error}</span><button onClick={() => void agentSessions?.refreshSessions(agent.id).catch(() => undefined)}>{language === 'zh' ? '重试' : 'Retry'}</button></div>}
                    </>}
                  </div>;
                })}
                {agents.length === 0 && <button className="conversation-row agent-sidebar-empty" onClick={() => onSectionChange('agents')}><Plus size={15}/><span>{language === 'zh' ? '连接 Agent' : 'Connect an Agent'}</span></button>}
              </div>}

              <SectionHeader
                title={language === 'zh' ? '项目' : 'Projects'}
                action={<FolderOpen size={14} />}
                actionLabel={language === 'zh' ? '添加项目' : 'Add project'}
                expanded={expandedSections.has('projects')}
                onToggle={() => toggleSection('projects')}
                onAction={onAddProject}
                onContextMenu={(event) =>
                  openContextMenu(event, 'section:projects', [
                    {
                      key: 'toggle',
                      icon: <ChevronDown size={15} />,
                      label: expandedSections.has('projects')
                        ? language === 'zh'
                          ? '收起项目'
                          : 'Collapse projects'
                        : language === 'zh'
                          ? '展开项目'
                          : 'Expand projects',
                      onClick: () => toggleSection('projects'),
                    },
                    {
                      key: 'add-project',
                      icon: <FolderOpen size={15} />,
                      label: language === 'zh' ? '添加项目' : 'Add project',
                      onClick: onAddProject,
                    },
                    {
                      key: 'restore-conversations',
                      icon: <Archive size={15} />,
                      label: language === 'zh' ? '管理归档' : 'Manage archives',
                      onClick: onOpenArchives ?? onOpenSettings,
                    },
                  ])
                }
              />
              {expandedSections.has('projects') && regularProjects.map(renderProjectBlock)}
              <div data-workspace-drop="recent" className={`workspace-drop-target${workspaceDropTarget === 'recent' ? ' workspace-drop-active' : ''}`}
                {...workspaceDropHandlers(null)}>
              <SectionHeader
                title={language === 'zh' ? '最近' : 'Recent'}
                action={<MessageSquare size={14} />}
                actionLabel={language === 'zh' ? '最近会话' : 'Recent chats'}
                expanded={expandedSections.has('recent')}
                onToggle={() => toggleSection('recent')}
              />
              {expandedSections.has('recent') && (
                recentConversations.length > 0 ? (
                  <div className="sidebar-conversation-list">
                    {recentConversations.map(renderStandaloneConversation)}
                  </div>
                ) : (
                  <div className="sidebar-conversation-empty">
                    {language === 'zh' ? '点击上方“新会话”开始' : 'Use New chat above to begin.'}
                  </div>
                )
              )}
              </div>
        </div>
      </div>

      <div className="sidebar-footer">
      <button
        className="settings-dock"
        type="button"
        onClick={onOpenSettings}
        onContextMenu={(event) =>
          openContextMenu(event, 'settings', [
            {
              key: 'open-settings',
              icon: <Settings size={15} />,
              label: language === 'zh' ? '打开设置' : 'Open settings',
              onClick: onOpenSettings,
            },
          ])
        }
      >
        <Settings size={17} />
        <span>{language === 'zh' ? '设置' : 'Settings'}</span>
      </button>
      <button className="sidebar-search-button" type="button" onClick={onOpenSearch}
        aria-label={searchLabel} aria-haspopup="dialog" aria-keyshortcuts={keyboardShortcuts.aria('searchConversations')}
        title={searchShortcut ? `${searchLabel} (${searchShortcut})` : searchLabel}>
        <Search size={17} aria-hidden="true" />
      </button>
      </div>
      </div>
      {contextMenu && (
        createPortal(
          <SidebarContextMenu
            menu={contextMenu}
            onSelect={runContextMenuItem}
            onClose={closeMenus}
            onDismiss={closeMenus}
          />,
          sidebarRef.current?.closest('.app') ?? document.body,
        )
      )}
    </aside>
  );
});

function NavRow({
  active,
  icon,
  label,
  onClick,
  onContextMenu,
  trailing,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      className={`nav-row ${active ? 'active' : ''}`}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="nav-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      {trailing}
    </button>
  );
}

function SectionHeader({
  title,
  action,
  actionLabel,
  expanded = true,
  onToggle,
  onAction,
  onContextMenu,
}: {
  title: string;
  action: React.ReactNode;
  actionLabel: string;
  expanded?: boolean;
  onToggle?: () => void;
  onAction?: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
}) {
  const interactive = Boolean(onToggle);
  return (
    <div
      className={`section-header ${interactive ? 'interactive' : ''}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-expanded={interactive ? expanded : undefined}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (!interactive || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }
        event.preventDefault();
        onToggle?.();
      }}
      onContextMenu={onContextMenu}
    >
      <span
        className="section-title"
      >
        {title}
        <ChevronDown className={`section-chevron${expanded ? '' : ' collapsed'}`} size={14} aria-hidden="true" />
      </span>
      <button
        className="section-action"
        data-sidebar-menu-trigger="true"
        type="button"
        aria-label={actionLabel}
        title={actionLabel}
        onClick={(event) => {
          event.stopPropagation();
          onAction?.();
          event.currentTarget.blur();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        disabled={!onAction}
      >
        {action}
      </button>
    </div>
  );
}

function ProjectBlock({
  project,
  conversations: projectConversations,
  activeConversationId,
  runningConversationIds,
  attentionByConversation,
  unreadConversationIds,
  language,
  expanded,
  onToggleExpanded,
  onContextMenu,
  onProjectAction,
  onConversationChange,
  onConversationArchive,
  onDeleteConversation,
  onRenameConversation,
  onConversationContextMenu,
  pinnedConversationIds,
  onToggleConversationPin,
  onToggleConversationRead,
  changeReportsByConversation,
  onOpenConversationChanges,
}: {
  project: ProjectItem;
  conversations: ConversationSummary[];
  activeConversationId: string;
  runningConversationIds?: Set<string>;
  attentionByConversation?: Record<string, SessionAttentionState>;
  unreadConversationIds: ReadonlySet<string>;
  language: AppLanguage;
  expanded: boolean;
  onToggleExpanded: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onProjectAction: (action: ProjectAction) => void;
  onConversationChange: (id: string) => void;
  onConversationArchive: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<boolean>;
  onConversationContextMenu: (
    event: ReactMouseEvent,
    conversation: ConversationSummary,
    options: ConversationMenuOptions,
  ) => void;
  pinnedConversationIds: ReadonlySet<string>;
  onToggleConversationPin: (conversationId: string) => void;
  onToggleConversationRead: (conversationId: string) => void;
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onOpenConversationChanges: (conversationId: string) => void;
}) {
  return (
    <div className={`project-block${project.missing ? ' missing' : ''}`}>
      <div
        className="project-row"
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpanded();
          }
        }}
      >
        <span className="project-row-icon" aria-hidden="true">
          <Folder size={14} />
        </span>
        <div className="project-title">
          <span title={project.missing
            ? language === 'zh' ? '项目文件夹不存在' : 'Project folder is missing'
            : undefined}
          >
            {project.title}
          </span>
        </div>
        <button
          className="row-new-chat"
          data-sidebar-menu-trigger="true"
          type="button"
          disabled={project.missing}
          aria-label={language === 'zh' ? '新建项目会话' : 'New project chat'}
          title={language === 'zh' ? '新建项目会话' : 'New project chat'}
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            onProjectAction('newChat');
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            onContextMenu(event);
          }}
        >
          <Plus size={14} />
        </button>
        <button
          className="row-archive"
          type="button"
          aria-label={language === 'zh' ? '归档项目' : 'Archive project'}
          title={language === 'zh' ? '归档项目' : 'Archive project'}
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            onProjectAction('archive');
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.stopPropagation();
            onContextMenu(event);
          }}
        >
          <Archive size={15} />
        </button>
      </div>
      {expanded && projectConversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          active={conversation.id === activeConversationId}
          running={runningConversationIds?.has(conversation.id) ?? false}
          attention={attentionByConversation?.[conversation.id]}
          unread={unreadConversationIds.has(conversation.id)}
          nested
          pinned={pinnedConversationIds.has(conversation.id)}
          language={language}
          onTogglePin={() => onToggleConversationPin(conversation.id)}
          onToggleRead={() => onToggleConversationRead(conversation.id)}
          onArchive={() => onConversationArchive(conversation.id)}
          onDelete={() => onDeleteConversation(conversation.id)}
          changeReports={changeReportsByConversation[conversation.id] ?? []}
          onOpenChanges={() => onOpenConversationChanges(conversation.id)}
          onRename={(nextTitle) => onRenameConversation(conversation.id, nextTitle)}
          onContextMenu={(event, options) =>
            onConversationContextMenu(event, conversation, options)
          }
          onClick={() => {
            if (unreadConversationIds.has(conversation.id)) {
              onToggleConversationRead(conversation.id);
            }
            onConversationChange(conversation.id);
          }}
        />
      ))}
    </div>
  );
}

function sessionAttentionLabel(
  attention: SessionAttentionState,
  language: AppLanguage,
) {
  if (attention.kind === 'waiting') {
    return language === 'zh' ? '等待你的处理' : 'Waiting for your input';
  }
  if (attention.kind === 'error') {
    return language === 'zh' ? '需要关注' : 'Needs attention';
  }
  return language === 'zh' ? '已完成，待查看' : 'Complete, not viewed';
}

function ConversationRow({
  conversation,
  active,
  running,
  attention,
  unread,
  nested,
  remote = false,
  pinned,
  language,
  onTogglePin,
  onToggleRead,
  onArchive,
  onDelete,
  changeReports,
  onOpenChanges,
  onRename,
  onContextMenu,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  running?: boolean;
  attention?: SessionAttentionState;
  unread: boolean;
  nested?: boolean;
  remote?: boolean;
  pinned: boolean;
  language: AppLanguage;
  onTogglePin: () => void;
  onToggleRead: () => void;
  onArchive: () => void;
  onDelete: () => void;
  changeReports?: ConversationChangeReport[];
  onOpenChanges?: () => void;
  onRename: (title: string) => Promise<boolean>;
  onContextMenu?: (event: ReactMouseEvent, options: ConversationMenuOptions) => void;
  onClick: () => void;
}) {
  const renameInputRef = useRef<HTMLInputElement>(null);
  const keyboardShortcuts = useKeyboardShortcuts();
  const extraction = useContext(ConversationExtractionContext);
  const displayTitle = conversationDisplayTitle(conversation.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [renameDraft, setRenameDraft] = useState(displayTitle);
  const [renamePending, setRenamePending] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  const changeCount = changeReports?.reduce((sum, report) => sum + report.fileCount, 0) ?? 0;
  const beginRename = useCallback(() => {
    setRenameDraft(displayTitle);
    setRenameFailed(false);
    setEditingTitle(true);
  }, [displayTitle]);
  const cancelRename = useCallback(() => {
    if (renamePending) return;
    setRenameDraft(displayTitle);
    setRenameFailed(false);
    setEditingTitle(false);
  }, [displayTitle, renamePending]);
  const submitRename = useCallback(async () => {
    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setRenameFailed(true);
      renameInputRef.current?.focus();
      return;
    }
    if (nextTitle === displayTitle) {
      setEditingTitle(false);
      setRenameFailed(false);
      return;
    }
    setRenamePending(true);
    setRenameFailed(false);
    const saved = await onRename(nextTitle);
    setRenamePending(false);
    setRenameFailed(!saved);
    if (saved) setEditingTitle(false);
    else renameInputRef.current?.focus();
  }, [displayTitle, onRename, renameDraft]);

  useEffect(() => {
    if (!editingTitle) return;
    const input = renameInputRef.current;
    input?.focus();
    input?.select();
  }, [editingTitle]);

  const menuOptions: ConversationMenuOptions = {
    changeCount,
    pinned,
    unread,
    onTogglePin,
    onToggleRead,
    onOpenChanges,
    onRename: beginRename,
    onArchive,
    onDelete,
  };
  return (
    <div
      className={`conversation-row ${nested ? 'nested' : ''} ${active ? 'active' : ''} ${running ? 'running' : ''} ${unread ? 'unread' : ''}${remote ? ' remote-conversation' : ''}`}
      draggable={!remote && !editingTitle}
      onDragStart={event => { event.dataTransfer.effectAllowed = 'copyMove'; event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, conversation.id); }}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={(event) => {
        event.preventDefault();
        beginRename();
      }}
      onContextMenu={(event) => onContextMenu?.(event, menuOptions)}
      onKeyDown={(event) => {
        if (keyboardShortcuts.matches('extractConversation', event) && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); if (!remote) extraction?.open(conversation.id); return;
        }
        if (keyboardShortcuts.matches('renameConversation', event) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          beginRename();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {unread && !editingTitle && (
        <span
          className="conversation-unread-indicator"
          role="status"
          aria-label={language === 'zh' ? '未读对话' : 'Unread chat'}
          title={language === 'zh' ? '未读' : 'Unread'}
        />
      )}
      {editingTitle ? (
        <form
          className={`conversation-rename-form${renameFailed ? ' invalid' : ''}`}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              cancelRename();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRename();
            }
          }}
        >
          <input
            ref={renameInputRef}
            value={renameDraft}
            maxLength={160}
            disabled={renamePending}
            aria-label={language === 'zh' ? '对话标题' : 'Chat title'}
            aria-invalid={renameFailed}
            title={renameFailed
              ? language === 'zh' ? '标题不能为空或保存失败，请重试' : 'Title is empty or could not be saved'
              : undefined}
            onChange={(event) => {
              setRenameDraft(event.target.value);
              setRenameFailed(false);
            }}
          />
          <button
            type="submit"
            disabled={renamePending || !renameDraft.trim()}
            aria-label={language === 'zh' ? '保存标题' : 'Save title'}
            title={language === 'zh' ? '保存' : 'Save'}
          >
            {renamePending ? <LoaderCircle className="spin" size={12} /> : <CircleCheck size={12} />}
          </button>
          <button
            type="button"
            disabled={renamePending}
            aria-label={language === 'zh' ? '取消重命名' : 'Cancel rename'}
            title={language === 'zh' ? '取消' : 'Cancel'}
            onClick={cancelRename}
          >
            <X size={12} />
          </button>
        </form>
      ) : (
        <ScrollingConversationTitle title={displayTitle} />
      )}
      {!editingTitle && running && (
        <span
          className="conversation-running-indicator"
          role="status"
          aria-label={language === 'zh' ? '会话运行中' : 'Session running'}
          title={language === 'zh' ? '会话运行中' : 'Session running'}
        >
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
      {!editingTitle && !running && attention && (
        <span
          className={`conversation-attention-indicator ${attention.kind}`}
          role="status"
          aria-label={sessionAttentionLabel(attention, language)}
          title={sessionAttentionLabel(attention, language)}
        >
          {attention.kind === 'completed'
            ? <CircleCheck size={15} />
            : <CircleAlert size={15} />}
        </span>
      )}
      {!remote && !editingTitle && <button
        className={`conversation-pin${pinned ? ' is-pinned' : ''}`}
        type="button"
        aria-label={pinned
          ? language === 'zh' ? '取消置顶对话' : 'Unpin chat'
          : language === 'zh' ? '置顶对话' : 'Pin chat'}
        title={pinned
          ? language === 'zh' ? '取消置顶' : 'Unpin'
          : language === 'zh' ? '置顶' : 'Pin'}
        aria-pressed={pinned}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin();
          event.currentTarget.blur();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <Pin size={14} />
      </button>}
      {!remote && !editingTitle && <button
        className="conversation-archive"
        type="button"
        aria-label={language === 'zh' ? '归档对话' : 'Archive chat'}
        title={language === 'zh' ? '归档对话' : 'Archive chat'}
        onClick={(event) => {
          event.stopPropagation();
          onArchive();
          event.currentTarget.blur();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.stopPropagation();
          onContextMenu?.(event, menuOptions);
        }}
      >
        <Archive size={15} />
      </button>}
    </div>
  );
}

function ScrollingConversationTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const lastLayoutLogRef = useRef('');
  const [restOverflowWidth, setRestOverflowWidth] = useState(0);
  const [overflowWidth, setOverflowWidth] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const measure = () => {
      const viewportStyle = window.getComputedStyle(viewport);
      const inlinePadding =
        (Number.parseFloat(viewportStyle.paddingLeft) || 0) +
        (Number.parseFloat(viewportStyle.paddingRight) || 0);
      const viewportContentWidth = Math.max(0, viewport.clientWidth - inlinePadding);
      const hoverActionsWidth =
        Number.parseFloat(viewportStyle.getPropertyValue('--conversation-title-hover-actions')) || 0;
      const hoverViewportContentWidth = Math.max(0, viewportContentWidth - hoverActionsWidth);
      const restNext = Math.max(0, Math.ceil(content.scrollWidth - viewportContentWidth));
      const next = Math.max(0, Math.ceil(content.scrollWidth - hoverViewportContentWidth));
      setRestOverflowWidth((current) => current === restNext ? current : restNext);
      setOverflowWidth((current) => current === next ? current : next);
      const row = viewport.closest<HTMLElement>('.conversation-row');
      const menu = row?.querySelector<HTMLElement>('.conversation-archive') ?? null;
      if (row) {
        const rowBounds = row.getBoundingClientRect();
        const titleBounds = viewport.getBoundingClientRect();
        const menuBounds = menu?.getBoundingClientRect();
        const overlapsMenu = Boolean(
          menuBounds && titleBounds.right > menuBounds.left,
        );
        const fingerprint = [
          Math.round(rowBounds.width),
          Math.round(viewportContentWidth),
          Math.round(hoverViewportContentWidth),
          content.scrollWidth,
          restNext,
          next,
          menu ? Math.round(menu.getBoundingClientRect().width) : 0,
          overlapsMenu,
        ].join(':');
        if (fingerprint !== lastLayoutLogRef.current && (next > 0 || overlapsMenu)) {
          lastLayoutLogRef.current = fingerprint;
          console.info('[cardbush:sidebar-title-layout]', {
            titleLength: title.length,
            rowWidth: Math.round(rowBounds.width),
            titleViewportWidth: Math.round(viewportContentWidth),
            titleHoverViewportWidth: Math.round(hoverViewportContentWidth),
            titleContentWidth: content.scrollWidth,
            restOverflowWidth: restNext,
            overflowWidth: next,
            menuWidth: menuBounds ? Math.round(menuBounds.width) : 0,
            reservedRight: Math.round(rowBounds.right - titleBounds.right),
            overlapsMenu,
          });
        }
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [title]);

  // Move once at a readable pace, including the trailing fade lane so the
  // final glyphs stop in the fully visible area instead of under the mask.
  const travelWidth = overflowWidth > 0 ? overflowWidth + 6 : 0;
  const duration = Math.min(9, Math.max(2.6, travelWidth / 42 + 0.9));
  return (
    <span
      ref={viewportRef}
      className={`conversation-title${restOverflowWidth > 0 ? ' is-overflowing' : ''}${overflowWidth > 0 ? ' is-hover-scrollable' : ''}`}
      aria-label={title}
      data-rest-overflow-width={restOverflowWidth}
      data-overflow-width={overflowWidth}
      style={{
        '--conversation-title-overflow': `${overflowWidth}px`,
        '--conversation-title-travel': `${travelWidth}px`,
        '--conversation-title-duration': `${duration}s`,
      } as React.CSSProperties}
    >
      <span ref={contentRef} className="conversation-title-text">
        {title}
      </span>
    </span>
  );
}

function SidebarContextMenu({
  menu,
  onSelect,
  onClose,
  onDismiss,
}: {
  menu: SidebarContextMenuState;
  onSelect: (item: SidebarContextMenuItem) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<SidebarContextMenuState | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setSubmenu(null);
    const anchor = menu.anchor?.getBoundingClientRect();
    let left = anchor ? anchor.right : menu.x;
    if (anchor && left + node.offsetWidth > window.innerWidth - 8) left = anchor.left - node.offsetWidth;
    node.style.left = Math.max(8, Math.min(left, window.innerWidth - node.offsetWidth - 8)) + 'px';
    node.style.top = Math.max(8, Math.min(anchor ? anchor.top - 8 : menu.y, window.innerHeight - node.offsetHeight - 8)) + 'px';
    if (menu.focusFirst) node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    else if (!menu.anchor) node.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    window.addEventListener('resize', onDismiss);
    return () => window.removeEventListener('resize', onDismiss);
  }, [onDismiss]);

  function expand(item: SidebarContextMenuItem, anchor: HTMLButtonElement, focusFirst = false) {
    if (item.disabled || !item.children?.length) { setSubmenu(null); return; }
    setSubmenu({ id: item.key, x: 0, y: 0, items: item.children, anchor, focusFirst });
  }

  return <>
    <div
      ref={ref}
      className="sidebar-context-menu"
      role="menu"
      tabIndex={-1}
      aria-label={menu.anchor?.textContent ?? undefined}
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
      onScroll={() => setSubmenu(null)}
      onKeyDown={event => {
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); setSubmenu(null);
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[index]?.focus();
        } else if (event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation();
          const item = menu.items.find(item => item.key === buttons[current]?.dataset.sidebarMenuItem);
          if (item && buttons[current]) expand(item, buttons[current], true);
        } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); onClose();
        } else if (event.key === 'Tab') {
          event.preventDefault(); onDismiss();
        }
      }}
    >
      {menu.items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && item.separatorBefore && <div className="sidebar-menu-separator" role="separator" />}
          <button
            className={'sidebar-menu-button ' + (item.danger ? 'danger' : '')}
            data-sidebar-menu-item={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-haspopup={item.children?.length ? 'menu' : undefined}
            aria-expanded={item.children?.length ? submenu?.id === item.key : undefined}
            onPointerEnter={event => expand(item, event.currentTarget)}
            onClick={event => {
              event.stopPropagation();
              if (item.children?.length) expand(item, event.currentTarget, event.detail === 0);
              else onSelect(item);
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
            {Boolean(item.children?.length) && <ChevronRight className="sidebar-menu-chevron" size={16} aria-hidden="true" />}
          </button>
        </Fragment>
      ))}
    </div>
    {submenu && <SidebarContextMenu menu={submenu} onSelect={onSelect} onDismiss={onDismiss}
      onClose={() => { setSubmenu(null); submenu.anchor?.focus({ preventScroll: true }); }} />}
  </>;
}

export function ConversationChangeDialog({
  language,
  conversation,
  reports,
  turns,
  initialFilePath = '',
  initialTurnId = '',
  selectionRequestId,
  notice,
  revertingChangeId,
  revertedChangeIds,
  onClose,
  onRevert,
  revertAvailable = true,
  embedded = false,
  workspaceControls,
  reviewComments,
  onReviewCommentsChange,
  onComposeReviewComments,
}: {
  language: AppLanguage;
  conversation: ConversationSummary;
  reports: ConversationChangeReport[];
  turns?: ReviewTurn[];
  initialFilePath?: string;
  initialTurnId?: string;
  selectionRequestId?: string;
  notice: string;
  revertingChangeId: string;
  revertedChangeIds: ReadonlySet<string>;
  onClose: () => void;
  onRevert: (report: ConversationChangeReport) => Promise<void>;
  revertAvailable?: boolean;
  embedded?: boolean;
  workspaceControls?: React.ReactNode;
  reviewComments?: ReviewCommentState;
  onReviewCommentsChange?: ReviewCommentsChange;
  onComposeReviewComments?: (comments: ReviewComment[]) => void;
}) {
  const host = useContext(ConversationHostContext);
  const recentTurns = useMemo(() => turns?.slice(0, WORKSPACE_REVIEW_TURN_LIMIT) ?? [...new Map([...reports].reverse().map(report => [report.turnId || report.id,
    { id: report.turnId || report.id, prompt: report.userPrompt, createdAt: report.createdAt }])).values()].slice(0, WORKSPACE_REVIEW_TURN_LIMIT), [turns, reports]);
  const [chosenTurn, setChosenTurn] = useState(initialTurnId);
  const selectedTurnId = recentTurns.some(turn => turn.id === chosenTurn) ? chosenTurn : recentTurns[0]?.id ?? '';
  const selectedTurn = recentTurns.find(turn => turn.id === selectedTurnId);
  const selectedTurnIsLatest = selectedTurnId === recentTurns[0]?.id;
  const retainedReports = useMemo(() => reports.filter(report => recentTurns.some(turn => turn.id === (report.turnId || report.id))), [reports, recentTurns]);
  const turnReports = useMemo(() => retainedReports.filter(report => (report.turnId || report.id) === selectedTurnId), [retainedReports, selectedTurnId]);
  const workspaceRoot = conversationWorkspaceRoot(conversation);
  const [selectedPath, setSelectedPath] = useState(initialFilePath);
  const [previewPath, setPreviewPath] = useState('');
  const [hydratedReports, setHydratedReports] = useState<
    Map<string, ToolChangeReport>
  >(() => new Map());
  const [detailRequests, setDetailRequests] = useState<
    Map<string, 'loading' | 'loaded' | 'failed'>
  >(() => new Map());
  const [detailRetryRevision, setDetailRetryRevision] = useState(0);
  const detailViewMountedRef = useRef(true);
  const retainedReportKeysRef = useRef(new Set<string>());
  retainedReportKeysRef.current = new Set(retainedReports.map(report => reviewDetailKey(conversation.id, report.id)));
  const detailRequestsInFlightRef = useRef(new Set<string>());
  useEffect(() => {
    detailViewMountedRef.current = true;
    return () => {
      detailViewMountedRef.current = false;
    };
  }, []);
  const resolvedReports = useMemo(
    () => turnReports.map((report) => {
      const hydrated = hydratedReports.get(reviewDetailKey(conversation.id, report.id));
      return hydrated ? { ...report, ...hydrated, reverted: report.reverted } : report;
    }),
    [conversation.id, hydratedReports, turnReports],
  );
  const reviewGroups = useMemo(
    () => groupChangeReportsByTurn(resolvedReports),
    [resolvedReports],
  );
  const reviewItems = useMemo(
    () => reviewGroups.flatMap((group) => group.items).sort((left, right) => right.reportIndex - left.reportIndex),
    [reviewGroups],
  );
  const changedPaths = useMemo(() => [...new Map(reviewItems.map(item => [reviewPathKey(item.file.path), item.file.path])).values()], [reviewItems]);
  const appliedFileSelectionRef = useRef<{ path: string; requestId?: string } | null>(null);
  const lastSession = useRef(conversation.id);
  useEffect(() => {
    if (lastSession.current === conversation.id) return;
    lastSession.current = conversation.id;
    appliedFileSelectionRef.current = null;
    setChosenTurn('');
    setPreviewPath('');
    setSelectedPath(initialFilePath);
  }, [conversation.id, initialFilePath]);
  const fileNav = useReviewFileNav();
  const fileNavId = useId();
  const fileNavToggleRef = useRef<HTMLButtonElement>(null);
  const fileNavToggleLabel = fileNav.collapsed
    ? (language === 'zh' ? '展开文件列表' : 'Show file list')
    : (language === 'zh' ? '收起文件列表' : 'Hide file list');
  const selectedItem = reviewItems.find(item => reviewPathKey(item.file.path) === reviewPathKey(selectedPath)) ?? null;
  const selectedAdapter = resolveFilePreview(selectedPath);
  const nativeFilePreview = !!selectedAdapter && selectedAdapter.renderer !== 'text'
    && selectedAdapter.renderer !== 'markdown' && selectedAdapter.id !== 'html' && !/\.svg$/i.test(selectedPath);
  const showCurrentContents = nativeFilePreview || previewPath === selectedPath;
  const selectedReport = selectedItem?.report ?? resolvedReports.at(-1);
  const selectedReverted = !!selectedReport && revertedChangeIds.has(selectedReport.id);
  const canRevert = revertAvailable && !revertingChangeId && !!selectedReport && selectedReport.fileCount > 0;
  const commentRevision = useMemo(() => reviewRevision(selectedItem?.file.lines ?? []), [selectedItem?.file.lines]);
  useEffect(() => {
    const allowed = new Set(retainedReports.map(report => reviewDetailKey(conversation.id, report.id)));
    setHydratedReports(previous => new Map([...previous].filter(([key]) => allowed.has(key))));
    setDetailRequests(previous => new Map([...previous].filter(([key]) => allowed.has(key))));
  }, [conversation.id, retainedReports]);
  const selectedDetailKey = selectedItem
    ? reviewDetailKey(conversation.id, selectedItem.report.id)
    : '';
  const selectedDetailStatus = selectedDetailKey
    ? detailRequests.get(selectedDetailKey)
    : undefined;
  const selectedDetailTurnId = selectedItem?.report.turnId?.trim() ?? '';
  const selectedDetailRequired = Boolean(
    selectedItem &&
    !showCurrentContents &&
    selectedDetailKey &&
    selectedDetailTurnId &&
    (selectedItem.report.executionIds?.length ?? 0) > 0 &&
    selectedItem.file.lines.length === 0 &&
    (
      selectedItem.report.detailsDeferred === true ||
      selectedItem.file.additions > 0 ||
      selectedItem.file.deletions > 0
    ),
  );
  const selectedDetailRequestKey = selectedDetailRequired
    ? `${conversation.id}\u0000${selectedDetailTurnId}`
    : '';
  useEffect(() => {
    if (
      !selectedDetailRequestKey ||
      !selectedDetailKey ||
      selectedDetailStatus ||
      detailRequestsInFlightRef.current.has(selectedDetailRequestKey)
    ) return;

    const turnReports = retainedReports.filter(
      (candidate) =>
        candidate.turnId?.trim() === selectedDetailTurnId &&
        (candidate.executionIds?.length ?? 0) > 0,
    );
    const turnDetailKeys = turnReports.map((candidate) =>
      reviewDetailKey(conversation.id, candidate.id),
    );
    detailRequestsInFlightRef.current.add(selectedDetailRequestKey);
    setDetailRequests((current) => {
      const next = new Map(current);
      for (const key of turnDetailKeys) {
        if (!next.has(key)) next.set(key, 'loading');
      }
      return next;
    });
    void (host ? host.toolDetails(conversation.id, selectedDetailTurnId) : fetchRuntimeTurnToolExecutionDetails({
      sessionId: conversation.id,
      turnId: selectedDetailTurnId,
    }))
      .then((details) => {
        if (!detailViewMountedRef.current) return;
        const hydratedByKey = turnReports.filter(candidate => retainedReportKeysRef.current.has(reviewDetailKey(conversation.id, candidate.id))).map((candidate) => ({
          key: reviewDetailKey(conversation.id, candidate.id),
          report: hydrateConversationChangeReport(candidate, details),
        }));
        setHydratedReports((current) => {
          const next = new Map(current);
          for (const hydrated of hydratedByKey) {
            if (hydrated.report) next.set(hydrated.key, hydrated.report);
          }
          return next;
        });
        setDetailRequests((current) => {
          const next = new Map(current);
          for (const hydrated of hydratedByKey) {
            next.set(hydrated.key, hydrated.report ? 'loaded' : 'failed');
          }
          return next;
        });
      })
      .catch(() => {
        if (!detailViewMountedRef.current) return;
        setDetailRequests((current) => {
          const next = new Map(current);
          for (const key of turnDetailKeys) if (retainedReportKeysRef.current.has(key)) next.set(key, 'failed');
          return next;
        });
      })
      .finally(() => {
        detailRequestsInFlightRef.current.delete(selectedDetailRequestKey);
      });
  }, [
    host,
    conversation.id,
    detailRetryRevision,
    retainedReports,
    selectedDetailKey,
    selectedDetailRequestKey,
    selectedDetailStatus,
    selectedDetailTurnId,
  ]);
  const retrySelectedDetails = useCallback(() => {
    if (!selectedDetailTurnId) return;
    setDetailRequests((current) => {
      const next = new Map(current);
      for (const report of retainedReports) {
        if (report.turnId?.trim() === selectedDetailTurnId) {
          next.delete(reviewDetailKey(conversation.id, report.id));
        }
      }
      return next;
    });
    setDetailRetryRevision((current) => current + 1);
  }, [conversation.id, retainedReports, selectedDetailTurnId]);
  useEffect(() => {
    if (!selectedPath && reviewItems[0]) setSelectedPath(reviewItems[0].file.path);
  }, [reviewItems, selectedPath]);
  useEffect(() => {
    const normalized = initialFilePath.trim().replaceAll('\\', '/').toLowerCase();
    if (!normalized) return;
    const applied = appliedFileSelectionRef.current;
    if (applied?.path === normalized && applied.requestId === selectionRequestId) return;
    appliedFileSelectionRef.current = { path: normalized, requestId: selectionRequestId };
    setSelectedPath(initialFilePath);
  }, [initialFilePath, selectionRequestId]);
  const dialog = (
      <section className={`change-review-dialog${embedded ? ' embedded' : ''}`}>
        {!embedded && (
          <header>
            <div>
              <strong>{language === 'zh' ? '会话修改' : 'Chat changes'}</strong>
              <span>{conversation.title}</span>
            </div>
            <button type="button" onClick={onClose}>
              <X size={16} />
            </button>
          </header>
        )}
        <div className="change-review-summary change-review-file-heading">
          <div className="change-review-file-heading-copy">
            <strong title={selectedPath} onContextMenu={host ? undefined : event => selectedPath && openFileContextMenu(event, selectedPath, { language })}>
              {selectedPath ? <><FileTypeIcon path={selectedPath} /><span>{basename(selectedPath)}</span></> : (language === 'zh' ? '文件' : 'Files')}
            </strong>
          </div>
          {recentTurns.length > 0 && <div className="change-review-version-picker" title={selectedTurn?.prompt}>
            <SettingsDropdown label={language === 'zh' ? '审查轮次' : 'Review turn'} value={selectedTurnId} onChange={setChosenTurn} minMenuWidth={144}
              options={recentTurns.map((turn, index) => ({ value: turn.id,
                label: index === 0 ? (language === 'zh' ? '本轮' : 'Current turn') : (language === 'zh' ? '上一轮' : 'Previous turn') }))} />
          </div>}
          {selectedItem && selectedAdapter && !nativeFilePreview && <button
            className="change-review-preview-toggle" type="button" aria-pressed={showCurrentContents}
            title={showCurrentContents ? (language === 'zh' ? '查看改动' : 'Show changes') : (language === 'zh' ? '预览当前文件' : 'Preview current file')}
            aria-label={showCurrentContents ? (language === 'zh' ? '查看改动' : 'Show changes') : (language === 'zh' ? '预览当前文件' : 'Preview current file')}
            onClick={() => setPreviewPath(showCurrentContents ? '' : selectedPath)}>
            {showCurrentContents ? <Code2 size={15} /> : <Eye size={15} />}
          </button>}
          <button className="secondary-button change-review-revert" type="button"
            disabled={!canRevert} onClick={() => { if (canRevert && selectedReport) void onRevert(selectedReport); }}
            title={!selectedReport || !selectedReport.fileCount ? (language === 'zh' ? '所选轮次没有可撤回的修改' : 'No changes to revert in this turn')
              : !revertAvailable || revertingChangeId ? (language === 'zh' ? '正在处理，请稍后撤回' : 'Busy; revert will be available when processing finishes')
              : selectedReverted ? (language === 'zh' ? '取消撤回所选轮次' : 'Undo revert of selected turn')
              : selectedTurnIsLatest ? (language === 'zh' ? '撤回本轮' : 'Revert current turn') : (language === 'zh' ? '撤回上一轮' : 'Revert previous turn')}>
            {selectedReport && revertingChangeId === selectedReport.id ? <LoaderCircle size={14} /> : selectedReverted ? <RotateCw size={14} /> : <RotateCcw size={14} />}
            <span>{selectedReverted
              ? (language === 'zh' ? '取消撤回' : 'Undo revert')
              : (language === 'zh' ? '撤回' : 'Revert')}</span>
          </button>
          <button className="change-review-nav-toggle" ref={fileNavToggleRef} type="button"
            title={fileNavToggleLabel} aria-label={fileNavToggleLabel} aria-expanded={!fileNav.collapsed}
            aria-controls={fileNavId} onClick={() => fileNav.changeCollapsed(!fileNav.collapsed)}>
            <FolderTree size={16} />
          </button>
        </div>
        {workspaceControls}
        {notice && <pre className="change-review-notice">{notice}</pre>}
        <div
          ref={fileNav.workspaceRef}
          className="change-review-workspace"
          data-file-nav-collapsed={fileNav.collapsed}
          style={{ '--change-file-nav-width': `${fileNav.width}px` } as React.CSSProperties}
        >
          <section className="change-review-diff-pane">
            {selectedItem && !showCurrentContents ? (
              <DeferredResizePreview className="change-review-diff-content">
                {selectedDetailStatus === 'failed' && selectedItem.file.lines.length === 0 ? (
                  <div className="tool-change-details-failed" role="alert">
                    <span>{language === 'zh' ? '改动详情加载失败' : 'Unable to load change details'}</span>
                    <button type="button" onClick={retrySelectedDetails}>
                      <RefreshCw size={13} />
                      <span>{language === 'zh' ? '重试' : 'Retry'}</span>
                    </button>
                  </div>
                ) : selectedDetailStatus === 'loading' && selectedItem.file.lines.length === 0 ? (
                  <p className="tool-change-details-loading">
                    <LoaderCircle size={14} />
                    <span>{language === 'zh' ? '正在加载改动详情' : 'Loading change details'}</span>
                  </p>
                ) : (
                  <ReviewCommentsScope language={language} path={selectedItem.file.path} turnId={selectedTurnId}
                    lines={selectedItem.file.lines} state={reviewComments} onChange={onReviewCommentsChange}>
                    <ToolFileChangeView file={selectedItem.file} language={language} />
                  </ReviewCommentsScope>
                )}
              </DeferredResizePreview>
            ) : selectedPath ? (
              <ReviewFilePreview key={selectedPath} path={selectedPath} language={language} changed={!!selectedItem} />
            ) : (
              <div className="change-review-empty">
                {language === 'zh' ? '选择文件查看内容或本轮修改。' : 'Select a file to view its contents or changes.'}
              </div>
            )}
          </section>
          <div
            id={fileNavId}
            className={`change-review-file-nav-viewport soft-panel-motion ${fileNav.presence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
            hidden={!fileNav.presence.mounted}
            aria-hidden={!fileNav.presence.visible}
            inert={!fileNav.presence.visible ? true : undefined}
          >
            <div
              className="change-review-column-resizer"
              role="separator"
              hidden={fileNav.collapsed}
              tabIndex={fileNav.collapsed ? -1 : 0}
              aria-orientation="vertical"
              aria-label={language === 'zh' ? '调整文件列表宽度' : 'Resize file list'}
              aria-controls={fileNavId}
              aria-valuemin={0} aria-valuemax={420} aria-valuenow={fileNav.collapsed ? 0 : fileNav.width}
              title={language === 'zh' ? '拖动调整宽度，拖向右侧边缘收起文件列表' : 'Drag to resize; drag toward the right edge to hide files'}
              onPointerDown={fileNav.beginResize}
              onKeyDown={event => {
                if (fileNav.resizeWithKeyboard(event)) fileNavToggleRef.current?.focus({ preventScroll: true });
              }}
            />
            <aside className="change-review-file-nav">
              <ReviewFileTree rootPath={workspaceRoot} selectedPath={selectedPath} changedPaths={changedPaths}
                language={language} revision={conversation.updatedAt} onSelect={setSelectedPath} />
            </aside>
          </div>
        </div>
        {reviewComments && onReviewCommentsChange && onComposeReviewComments && <ReviewCommentsFooter
          state={reviewComments} onChange={onReviewCommentsChange} onCompose={onComposeReviewComments} language={language}
          path={selectedItem?.file.path ?? selectedPath} turnId={selectedTurnId} revision={commentRevision}
          onSelect={anchor => {
            setSelectedPath(anchor.path);
            if (recentTurns.some(turn => turn.id === anchor.turnId)) setChosenTurn(anchor.turnId);
          }} />}
      </section>
  );
  if (embedded) {
    return dialog;
  }
  return (
    <div
      className="modal-backdrop change-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      {dialog}
    </div>
  );
}

function reviewDetailKey(conversationId: string, reportId: string) {
  return `${conversationId}\u0000${reportId}`;
}
