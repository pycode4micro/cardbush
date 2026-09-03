import {
  Archive,
  CircleAlert,
  CircleCheck,
  ChevronDown,
  Clipboard,
  Cloud,
  Code2,
  Edit3,
  Folder,
  FolderOpen,
  LoaderCircle,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { fetchRuntimeTurnToolExecutionDetails } from '../../backend/api';
import { basename, samePath } from '../../shared/localPaths';
import { recordUiPerformanceMetric } from '../../shared/uiPerformanceTrace';
import type {
  AppLanguage,
  AppSection,
  ConversationSummary,
  ProjectItem,
  SessionAttentionState,
} from '../../types';
import { sectionLabels } from '../appSections';
import { FileTypeIcon } from '../chatMessages/FileTypeIcon';
import {
  conversationProjectDir,
  isOnlyTalkConversation,
} from '../conversationWorkspace';
import { conversationProjectId } from '../conversationScope';
import { copyText } from '../messageFeedback';
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

const sidebarMenuCloseEvent = 'cardbush-sidebar-menu-close';
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
  danger?: boolean;
  disabled?: boolean;
  children?: SidebarContextMenuItem[];
  onClick?: () => void;
};

type SidebarContextMenuState = {
  id: string;
  x: number;
  y: number;
  items: SidebarContextMenuItem[];
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

function sidebarContextMenuPosition(clientX: number, clientY: number, itemCount: number) {
  const menuWidth = 188;
  const menuHeight = Math.min(300, Math.max(1, itemCount) * 30 + 10);
  const padding = 8;
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
  onlyTalkMode,
  onOnlyTalkModeChange,
  onSectionChange,
  onConversationChange,
  onCreateConversation,
  onAddProject,
  onProjectAction,
  onDeleteConversation,
  onRenameConversation,
  onOpenConversationChanges,
  onOpenSettings,
  softVisible = true,
}: {
  language: AppLanguage;
  section: AppSection;
  activeConversationId: string;
  runningConversationIds?: Set<string>;
  attentionByConversation?: Record<string, SessionAttentionState>;
  projects: ProjectItem[];
  conversations: ConversationSummary[];
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onlyTalkMode: boolean;
  onOnlyTalkModeChange: (enabled: boolean) => void;
  onSectionChange: (value: AppSection) => void;
  onConversationChange: (id: string) => void;
  onCreateConversation: () => void;
  onAddProject: () => void;
  onProjectAction: (action: ProjectAction, project: ProjectItem) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<boolean>;
  onOpenConversationChanges: (conversationId: string) => void;
  onOpenSettings: () => void;
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
  const [archivedConversationIds, setArchivedConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(['pinned', 'projects']),
  );
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
  const onlyTalkConversations = useMemo(() => {
    const taskConversations = visibleConversations.filter(isOnlyTalkConversation);
    return [
      ...taskConversations.filter((conversation) => pinnedConversationIds.has(conversation.id)),
      ...taskConversations.filter((conversation) => !pinnedConversationIds.has(conversation.id)),
    ];
  }, [pinnedConversationIds, visibleConversations]);
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
    setOpenMenu(null);
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

  const toggleInlineMenu = useCallback((id: string) => {
    setContextMenu(null);
    setOpenMenu((current) => (current === id ? null : id));
  }, []);

  useEffect(() => {
    function closeFromMenuSelection() {
      closeMenus();
    }
    window.addEventListener(sidebarMenuCloseEvent, closeFromMenuSelection);
    return () => {
      window.removeEventListener(sidebarMenuCloseEvent, closeFromMenuSelection);
    };
  }, [closeMenus]);

  useEffect(() => {
    if (!openMenu && !contextMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.sidebar-menu') ||
        target.closest('.sidebar-context-menu') ||
        target.closest('[data-sidebar-menu-trigger="true"]') ||
        target.closest('.row-more') ||
        target.closest('.conversation-more')
      ) {
        return;
      }
      closeMenus();
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [closeMenus, contextMenu, openMenu]);

  function openContextMenu(
    event: ReactMouseEvent,
    id: string,
    items: SidebarContextMenuItem[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    const position = sidebarContextMenuPosition(event.clientX, event.clientY, items.length);
    setOpenMenu(null);
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
    setArchivedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
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
        label: language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer',
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
    items.push(
      {
        key: 'rename',
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
      <ProjectBlock
        key={project.id}
        project={project}
        conversations={regularConversations.filter((item) => {
          const projectId = conversationProjectId(item);
          if (projectId) return projectId === project.id;
          const projectDir = conversationProjectDir(item);
          return Boolean(projectDir && samePath(projectDir, project.rootPath));
        })}
        activeConversationId={activeConversationId}
        runningConversationIds={runningConversationIds}
        attentionByConversation={attentionByConversation}
        unreadConversationIds={unreadConversationIds}
        menuOpen={openMenu === `project:${project.id}`}
        language={language}
        expanded={expandedProjectIds.has(project.id)}
        onToggleExpanded={() => toggleProject(project.id)}
        onContextMenu={(event) =>
          openContextMenu(event, `project:${project.id}`, projectMenuItems(project))
        }
        onMenuToggle={() => toggleInlineMenu(`project:${project.id}`)}
        onProjectAction={(action) => {
          setOpenMenu(null);
          onProjectAction(action, project);
        }}
        onConversationChange={onConversationChange}
        onConversationMenuToggle={(conversationId) =>
          toggleInlineMenu(`conversation:${conversationId}`)
        }
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
        openMenu={openMenu}
      />
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
        menuOpen={openMenu === `conversation:${conversation.id}`}
        language={language}
        onMenuToggle={() => toggleInlineMenu(`conversation:${conversation.id}`)}
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
    >
      <nav className="sidebar-nav">
        <div className="new-chat-mode-row">
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
          <button
            className={`only-talk-toggle${onlyTalkMode ? ' active' : ''}`}
            type="button"
            aria-pressed={onlyTalkMode}
            aria-label={
              onlyTalkMode
                ? language === 'zh' ? '切换到项目' : 'Switch to projects'
                : language === 'zh' ? '切换到仅会话' : 'Switch to only talk'
            }
            title={
              onlyTalkMode
                ? language === 'zh' ? '当前：仅会话；点击切换到项目' : 'Current: only talk; switch to projects'
                : language === 'zh' ? '当前：项目；点击切换到仅会话' : 'Current: projects; switch to only talk'
            }
            onClick={() => onOnlyTalkModeChange(!onlyTalkMode)}
          >
            {onlyTalkMode ? <Cloud size={12} /> : <Folder size={12} />}
            <span>
              {onlyTalkMode
                ? language === 'zh' ? '仅会话' : 'Only talk'
                : language === 'zh' ? '项目' : 'Projects'}
            </span>
          </button>
        </div>
        <NavRow
          active={section === 'search'}
          icon={<Search size={14} />}
          label={t('search')}
          onClick={() => onSectionChange('search')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:search', [
              {
                key: 'open',
                icon: <Search size={15} />,
                label: language === 'zh' ? '打开搜索' : 'Open search',
                onClick: () => onSectionChange('search'),
              },
            ])
          }
        />
      </nav>

      <div className="sidebar-scroll">
        <div
          key={onlyTalkMode ? 'only-talk' : 'projects'}
          className={`sidebar-mode-content ${onlyTalkMode ? 'only-talk' : 'projects'}`}
        >
          {onlyTalkMode ? (
            onlyTalkConversations.length > 0 ? (
              <div className="only-talk-conversation-list">
                {onlyTalkConversations.map(renderStandaloneConversation)}
              </div>
            ) : (
              <div className="only-talk-empty">
                <MessageSquare size={16} />
                <span>
                  {language === 'zh'
                    ? '还没有普通对话，点击上方“新会话”开始'
                    : 'No chats yet. Use New chat above to begin.'}
                </span>
              </div>
            )
          ) : (
            <>
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
                      label: language === 'zh' ? '恢复归档对话' : 'Restore archived chats',
                      disabled: archivedConversationIds.size === 0,
                      onClick: () => setArchivedConversationIds(new Set()),
                    },
                  ])
                }
              />
              {expandedSections.has('projects') && regularProjects.map(renderProjectBlock)}
            </>
          )}
        </div>
      </div>

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
      {contextMenu && (
        createPortal(
          <SidebarContextMenu
            menu={contextMenu}
            onSelect={runContextMenuItem}
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
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
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
        <ChevronDown className={expanded ? '' : 'collapsed'} size={14} />
        {title}
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
  menuOpen,
  openMenu,
  onToggleExpanded,
  onContextMenu,
  onMenuToggle,
  onProjectAction,
  onConversationChange,
  onConversationMenuToggle,
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
  menuOpen: boolean;
  openMenu: string | null;
  onToggleExpanded: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onMenuToggle: () => void;
  onProjectAction: (action: ProjectAction) => void;
  onConversationChange: (id: string) => void;
  onConversationMenuToggle: (conversationId: string) => void;
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
          className="row-more"
          data-sidebar-menu-trigger="true"
          type="button"
          aria-label="project options"
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            onMenuToggle();
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            onContextMenu(event);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <SidebarMenu>
            <SidebarMenuButton icon={<Pin size={15} />} onClick={() => onProjectAction('pin')}>
              {project.pinned
                ? language === 'zh'
                  ? '取消置顶'
                  : 'Unpin'
                : language === 'zh'
                  ? '置顶项目'
                  : 'Pin project'}
            </SidebarMenuButton>
            <SidebarMenuButton disabled={project.missing} icon={<FolderOpen size={15} />} onClick={() => onProjectAction('open')}>
              {language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer'}
            </SidebarMenuButton>
            <SidebarMenuButton disabled={project.missing} icon={<RefreshCw size={15} />} onClick={() => onProjectAction('refreshGit')}>
              {language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status'}
            </SidebarMenuButton>
            <SidebarMenuButton disabled={project.missing} icon={<Edit3 size={15} />} onClick={() => onProjectAction('newChat')}>
              {language === 'zh' ? '新建项目会话' : 'New project chat'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Edit3 size={15} />} onClick={() => onProjectAction('rename')}>
              {language === 'zh' ? '重命名项目' : 'Rename project'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Archive size={15} />} onClick={() => onProjectAction('archive')}>
              {language === 'zh' ? '归档项目' : 'Archive project'}
            </SidebarMenuButton>
            <SidebarMenuButton danger icon={<X size={15} />} onClick={() => onProjectAction('remove')}>
              {language === 'zh' ? '移除' : 'Remove'}
            </SidebarMenuButton>
          </SidebarMenu>
        )}
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
          menuOpen={openMenu === `conversation:${conversation.id}`}
          language={language}
          onMenuToggle={() => onConversationMenuToggle(conversation.id)}
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
  pinned,
  language,
  menuOpen,
  onMenuToggle,
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
  pinned: boolean;
  language: AppLanguage;
  menuOpen: boolean;
  onMenuToggle: () => void;
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
  const [editingTitle, setEditingTitle] = useState(false);
  const [renameDraft, setRenameDraft] = useState(conversation.title);
  const [renamePending, setRenamePending] = useState(false);
  const [renameFailed, setRenameFailed] = useState(false);
  const changeCount = changeReports?.reduce((sum, report) => sum + report.fileCount, 0) ?? 0;
  const beginRename = useCallback(() => {
    setRenameDraft(conversation.title);
    setRenameFailed(false);
    setEditingTitle(true);
  }, [conversation.title]);
  const cancelRename = useCallback(() => {
    if (renamePending) return;
    setRenameDraft(conversation.title);
    setRenameFailed(false);
    setEditingTitle(false);
  }, [conversation.title, renamePending]);
  const submitRename = useCallback(async () => {
    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setRenameFailed(true);
      renameInputRef.current?.focus();
      return;
    }
    if (nextTitle === conversation.title.trim()) {
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
  }, [conversation.title, onRename, renameDraft]);

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
      className={`conversation-row ${nested ? 'nested' : ''} ${active ? 'active' : ''} ${running ? 'running' : ''} ${unread ? 'unread' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={(event) => {
        event.preventDefault();
        beginRename();
      }}
      onContextMenu={(event) => onContextMenu?.(event, menuOptions)}
      onKeyDown={(event) => {
        if (event.key === 'F2') {
          event.preventDefault();
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
        <ScrollingConversationTitle title={conversation.title} />
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
      {!editingTitle && <button
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
      {!editingTitle && <button
        className="conversation-more"
        data-sidebar-menu-trigger="true"
        type="button"
        aria-label={language === 'zh' ? '对话操作' : 'Conversation options'}
        title={language === 'zh' ? '对话操作' : 'Conversation options'}
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
          event.currentTarget.blur();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.stopPropagation();
          onContextMenu?.(event, menuOptions);
        }}
      >
        <MoreHorizontal size={15} />
      </button>}
      {!editingTitle && menuOpen && (
        <SidebarMenu>
          <SidebarMenuButton icon={<MessageSquare size={15} />} onClick={onClick}>
            {language === 'zh' ? '打开对话' : 'Open chat'}
          </SidebarMenuButton>
          <SidebarMenuButton icon={<Pin size={15} />} onClick={onTogglePin}>
            {pinned
              ? language === 'zh' ? '取消置顶' : 'Unpin chat'
              : language === 'zh' ? '置顶对话' : 'Pin chat'}
          </SidebarMenuButton>
          <SidebarMenuButton
            icon={unread ? <MailOpen size={15} /> : <Mail size={15} />}
            onClick={onToggleRead}
          >
            {unread
              ? language === 'zh' ? '标记为已读' : 'Mark as read'
              : language === 'zh' ? '标记为未读' : 'Mark as unread'}
          </SidebarMenuButton>
          {changeCount > 0 && (
            <SidebarMenuButton icon={<Code2 size={15} />} onClick={() => onOpenChanges?.()}>
              {language === 'zh' ? '查看 Diff' : 'View diff'}
            </SidebarMenuButton>
          )}
          <SidebarMenuButton icon={<Edit3 size={15} />} onClick={beginRename}>
            {language === 'zh' ? '重命名对话' : 'Rename chat'}
          </SidebarMenuButton>
          <SidebarMenuButton
            icon={<Clipboard size={15} />}
            onClick={() => void copyText(conversation.id)}
          >
            {language === 'zh' ? '复制会话 ID' : 'Copy session ID'}
          </SidebarMenuButton>
          <SidebarMenuButton icon={<Archive size={15} />} onClick={onArchive}>
            {language === 'zh' ? '归档对话' : 'Archive chat'}
          </SidebarMenuButton>
          <SidebarMenuButton danger icon={<Trash2 size={15} />} onClick={onDelete}>
            {language === 'zh' ? '删除对话' : 'Delete chat'}
          </SidebarMenuButton>
        </SidebarMenu>
      )}
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
      const menu = row?.querySelector<HTMLElement>('.conversation-more') ?? null;
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
  const travelWidth = overflowWidth > 0 ? overflowWidth + 16 : 0;
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

function SidebarMenu({ children }: { children: React.ReactNode }) {
  return <div className="sidebar-menu">{children}</div>;
}

function SidebarContextMenu({
  menu,
  onSelect,
}: {
  menu: SidebarContextMenuState;
  onSelect: (item: SidebarContextMenuItem) => void;
}) {
  return (
    <div
      className="sidebar-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.key}
          className={`sidebar-menu-button ${item.danger ? 'danger' : ''}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function SidebarMenuButton({
  icon,
  danger,
  disabled,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`sidebar-menu-button ${danger ? 'danger' : ''}`}
      type="button"
      disabled={disabled}
      onClick={(event) => {
        if (disabled) return;
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(sidebarMenuCloseEvent));
        onClick();
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function ConversationChangeDialog({
  language,
  conversation,
  reports,
  initialFilePath = '',
  notice,
  revertingChangeId,
  revertedChangeIds,
  onClose,
  onRevert,
  onRevertAll,
  revertAvailable = true,
  embedded = false,
}: {
  language: AppLanguage;
  conversation: ConversationSummary;
  reports: ConversationChangeReport[];
  initialFilePath?: string;
  notice: string;
  revertingChangeId: string;
  revertedChangeIds: ReadonlySet<string>;
  onClose: () => void;
  onRevert: (report: ConversationChangeReport) => Promise<void>;
  onRevertAll: () => Promise<void>;
  revertAvailable?: boolean;
  embedded?: boolean;
}) {
  const [hydratedReports, setHydratedReports] = useState<
    Map<string, ToolChangeReport>
  >(() => new Map());
  const [detailRequests, setDetailRequests] = useState<
    Map<string, 'loading' | 'loaded' | 'failed'>
  >(() => new Map());
  const resolvedReports = useMemo(
    () => reports.map((report) => {
      const hydrated = hydratedReports.get(reviewDetailKey(conversation.id, report.id));
      return hydrated ? { ...report, ...hydrated } : report;
    }),
    [conversation.id, hydratedReports, reports],
  );
  const reviewGroups = useMemo(
    () => groupChangeReportsByTurn(resolvedReports),
    [resolvedReports],
  );
  const reviewItems = useMemo(
    () => reviewGroups.flatMap((group) => group.items),
    [reviewGroups],
  );
  const [selectedKey, setSelectedKey] = useState(reviewItems[0]?.key ?? '');
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(
    () => new Set(reviewGroups[0] ? [reviewGroups[0].id] : []),
  );
  const [fileNavWidth, setFileNavWidth] = useState(() => {
    const stored = Number.parseFloat(window.localStorage.getItem('cardbush.review_file_nav_width') ?? '');
    return Number.isFinite(stored) ? Math.min(420, Math.max(150, stored)) : 210;
  });
  const beginFileNavResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const workspace = event.currentTarget.parentElement;
    if (!workspace) return;
    document.body.classList.add('change-review-resizing');
    const move = (moveEvent: PointerEvent) => {
      const bounds = workspace.getBoundingClientRect();
      const maximum = Math.max(150, Math.min(420, bounds.width * 0.48));
      const next = Math.round(Math.min(maximum, Math.max(150, bounds.right - moveEvent.clientX)));
      setFileNavWidth(next);
      window.localStorage.setItem('cardbush.review_file_nav_width', String(next));
    };
    const finish = () => {
      document.body.classList.remove('change-review-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  }, []);
  const selectedItem = reviewItems.find((item) => item.key === selectedKey) ??
    reviewItems[0] ?? null;
  const selectedDetailKey = selectedItem
    ? reviewDetailKey(conversation.id, selectedItem.report.id)
    : '';
  const selectedDetailStatus = selectedDetailKey
    ? detailRequests.get(selectedDetailKey)
    : undefined;
  useEffect(() => {
    if (!selectedItem || !selectedDetailKey || selectedDetailStatus) return undefined;
    const { report, file } = selectedItem;
    const turnId = report.turnId?.trim() ?? '';
    const executionIds = new Set(
      (report.executionIds ?? []).map((value) => value.trim()).filter(Boolean),
    );
    const missingKnownDetails =
      file.lines.length === 0 &&
      (report.detailsDeferred === true || file.additions > 0 || file.deletions > 0);
    if (!missingKnownDetails || !turnId || executionIds.size === 0) return undefined;

    const turnReports = reports.filter(
      (candidate) =>
        candidate.turnId?.trim() === turnId &&
        (candidate.executionIds?.length ?? 0) > 0,
    );
    const turnDetailKeys = turnReports.map((candidate) =>
      reviewDetailKey(conversation.id, candidate.id),
    );
    let cancelled = false;
    setDetailRequests((current) => {
      const next = new Map(current);
      for (const key of turnDetailKeys) {
        if (!next.has(key)) next.set(key, 'loading');
      }
      return next;
    });
    void fetchRuntimeTurnToolExecutionDetails({
      sessionId: conversation.id,
      turnId,
    })
      .then((details) => {
        if (cancelled) return;
        const hydratedByKey = turnReports.map((candidate) => ({
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
        if (!cancelled) {
          setDetailRequests((current) => new Map(current).set(selectedDetailKey, 'failed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conversation.id, reports, selectedDetailKey, selectedDetailStatus, selectedItem]);
  useEffect(() => {
    if (reviewItems.length === 0) {
      setSelectedKey('');
      return;
    }
    if (!reviewItems.some((item) => item.key === selectedKey)) {
      setSelectedKey(reviewItems[0]?.key ?? '');
    }
  }, [reviewItems, selectedKey]);
  useEffect(() => {
    const normalized = initialFilePath.trim().replaceAll('\\', '/').toLowerCase();
    if (!normalized) return;
    const item = reviewItems.find((candidate) =>
      candidate.file.path.trim().replaceAll('\\', '/').toLowerCase() === normalized,
    );
    if (!item) return;
    setSelectedKey(item.key);
    const group = reviewGroups.find((candidate) =>
      candidate.items.some((groupItem) => groupItem.key === item.key),
    );
    if (group) {
      setExpandedGroupIds((current) => new Set(current).add(group.id));
    }
  }, [initialFilePath, reviewGroups, reviewItems]);
  const newestGroupId = reviewGroups[0]?.id ?? '';
  useEffect(() => {
    const availableIds = new Set(reviewGroups.map((group) => group.id));
    setExpandedGroupIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      if (newestGroupId) next.add(newestGroupId);
      return next;
    });
  }, [newestGroupId, reviewGroups]);
  const totals = resolvedReports.reduce(
    (sum, report) => ({
      additions: sum.additions + report.additions,
      deletions: sum.deletions + report.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const uniqueFileCount = new Set(
    reviewItems
      .map((item) => item.file.path.trim().replaceAll('\\', '/').toLowerCase())
      .filter(Boolean),
  ).size;
  const allBusy = revertingChangeId === `conversation:${conversation.id}`;
  const allReverted = resolvedReports.every((report) => revertedChangeIds.has(report.id));
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
        <div className="change-review-summary">
          <Code2 size={16} />
          <span>
            {language === 'zh'
              ? `${reviewGroups.length} 轮修改，${uniqueFileCount} 个文件 · ${reviewItems.length} 次变更`
              : `${reviewGroups.length} turn(s), ${uniqueFileCount} file(s) · ${reviewItems.length} change record(s)`}
          </span>
          {totals.additions > 0 && <b className="diff-count add">+{totals.additions}</b>}
          {totals.deletions > 0 && <b className="diff-count del">-{totals.deletions}</b>}
          {revertAvailable && (
            <button
              className="danger-soft-button"
              type="button"
              disabled={Boolean(revertingChangeId) || allReverted}
              onClick={() => void onRevertAll()}
            >
              {allBusy ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
              <span>
                {allReverted
                  ? (language === 'zh' ? '已全部撤回' : 'All reverted')
                  : (language === 'zh' ? '撤回全部修改' : 'Revert all')}
              </span>
            </button>
          )}
        </div>
        {notice && <pre className="change-review-notice">{notice}</pre>}
        <div
          className="change-review-workspace"
          style={{ '--change-file-nav-width': `${fileNavWidth}px` } as React.CSSProperties}
        >
          <section className="change-review-diff-pane">
            {selectedItem ? (
              <>
                <header>
                  <FileTypeIcon path={selectedItem.file.path} />
                  <div>
                    <strong title={selectedItem.file.path}>{selectedItem.file.path}</strong>
                    <span>
                      {language === 'zh'
                        ? `第 ${selectedItem.turnIndex} 轮 · ${formatChangeTimestamp(selectedItem.report.createdAt, language)}`
                        : `Turn ${selectedItem.turnIndex} · ${formatChangeTimestamp(selectedItem.report.createdAt, language)}`}
                    </span>
                  </div>
                  {revertAvailable && (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={
                        Boolean(revertingChangeId) ||
                        revertedChangeIds.has(selectedItem.report.id)
                      }
                      onClick={() => void onRevert(selectedItem.report)}
                    >
                      {revertingChangeId === selectedItem.report.id
                        ? <LoaderCircle size={14} />
                        : <RotateCcw size={14} />}
                      <span>
                        {revertedChangeIds.has(selectedItem.report.id)
                          ? (language === 'zh' ? '已撤回' : 'Reverted')
                          : (language === 'zh' ? '撤回这组' : 'Revert set')}
                      </span>
                    </button>
                  )}
                </header>
                {selectedDetailStatus === 'loading' && selectedItem.file.lines.length === 0 ? (
                  <p className="tool-change-details-loading">
                    <LoaderCircle size={14} />
                    <span>{language === 'zh' ? '正在加载改动详情' : 'Loading change details'}</span>
                  </p>
                ) : (
                  <ToolFileChangeView file={selectedItem.file} language={language} />
                )}
              </>
            ) : (
              <div className="change-review-empty">
                {language === 'zh' ? '正在等待文件级 diff。' : 'Waiting for a file diff.'}
              </div>
            )}
          </section>
          <div
            className="change-review-column-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={language === 'zh' ? '调整文件列表宽度' : 'Resize file list'}
            title={language === 'zh' ? '拖动调整 Diff 和文件列表宽度' : 'Drag to resize diff and files'}
            onPointerDown={beginFileNavResize}
          />
          <aside className="change-review-file-nav">
            <header>
              <strong>{language === 'zh' ? '按轮次查看' : 'By turn'}</strong>
              <span>{reviewGroups.length}</span>
            </header>
            <div className="change-review-file-groups">
              {reviewGroups.map((group) => {
                const expanded = expandedGroupIds.has(group.id);
                return (
                  <section className="change-review-file-group" key={group.id}>
                    <button
                      className="change-review-group-toggle"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedGroupIds((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })}
                    >
                      <ChevronDown size={13} className={expanded ? 'expanded' : ''} />
                      <span>
                        <strong>
                          {language === 'zh'
                            ? `第 ${group.turnIndex} 轮`
                            : `Turn ${group.turnIndex}`}
                        </strong>
                        <small title={group.userPrompt || undefined}>
                          {group.userPrompt || formatChangeTimestamp(group.createdAt, language)}
                        </small>
                      </span>
                      <em>
                        {language === 'zh'
                          ? `${group.uniqueFileCount} 个文件`
                          : `${group.uniqueFileCount} file(s)`}
                      </em>
                    </button>
                    {expanded && (
                      <div className="change-review-group-files">
                        {group.items.map((item) => (
                          <button
                            key={item.key}
                            className={`change-review-file-item${item.key === selectedItem?.key ? ' active' : ''}`}
                            type="button"
                            title={item.file.path}
                            onClick={() => setSelectedKey(item.key)}
                          >
                            <FileTypeIcon path={item.file.path} />
                            <span>
                              <strong>{basename(item.file.path)}</strong>
                              <small>{item.file.path}</small>
                            </span>
                            <b className="diff-count add">+{item.file.additions}</b>
                            <b className="diff-count del">-{item.file.deletions}</b>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </aside>
        </div>
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

function formatChangeTimestamp(value: string | undefined, language: AppLanguage) {
  if (!value) {
    return language === 'zh' ? '完成后' : 'After completion';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return language === 'zh' ? '完成后' : 'After completion';
  }
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}


