import {
  Archive,
  ChevronDown,
  Clipboard,
  Code2,
  Edit3,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Network,
  Pin,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { samePath } from '../../shared/localPaths';
import type {
  AppLanguage,
  AppSection,
  ConversationSummary,
  ProjectItem,
} from '../../types';
import { sectionLabels } from '../appSections';
import { conversationProjectDir } from '../conversationWorkspace';
import { copyText } from '../messageFeedback';
import { ToolFileChangeView, type ConversationChangeReport } from '../tools';
export type ProjectAction =
  | 'pin'
  | 'open'
  | 'refreshGit'
  | 'newChat'
  | 'rename'
  | 'archive'
  | 'remove';

const sidebarMenuCloseEvent = 'cardbush-sidebar-menu-close';

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

export function ChatSidebar({
  language,
  section,
  activeConversationId,
  runningConversationIds,
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
  onOpenConversationChanges,
  onOpenSettings,
}: {
  language: AppLanguage;
  section: AppSection;
  activeConversationId: string;
  runningConversationIds?: Set<string>;
  projects: ProjectItem[];
  conversations: ConversationSummary[];
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onSectionChange: (value: AppSection) => void;
  onConversationChange: (id: string) => void;
  onCreateConversation: () => void;
  onAddProject: () => void;
  onProjectAction: (action: ProjectAction, project: ProjectItem) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onOpenConversationChanges: (conversationId: string) => void;
  onOpenSettings: () => void;
}) {
  const t = (id: AppSection) => sectionLabels[id][language];
  const [archivedConversationIds, setArchivedConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(['projects', 'conversations']),
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
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
  const isKnownProjectConversation = useCallback(
    (conversation: ConversationSummary) => {
      const projectDir = conversationProjectDir(conversation);
      return Boolean(
        projectDir &&
          visibleProjects.some((project) => samePath(project.rootPath, projectDir)),
      );
    },
    [visibleProjects],
  );

  useEffect(() => {
    const active = visibleConversations.find(
      (conversation) => conversation.id === activeConversationId,
    );
    if (!active) {
      return;
    }
    const activeProjectDir = conversationProjectDir(active);
    if (!activeProjectDir) {
      setExpandedSections((current) =>
        current.has('conversations') ? current : new Set(current).add('conversations'),
      );
      return;
    }
    const project = visibleProjects.find((item) => samePath(item.rootPath, activeProjectDir));
    if (!project) {
      setExpandedSections((current) =>
        current.has('conversations') ? current : new Set(current).add('conversations'),
      );
      return;
    }
    setExpandedSections((current) =>
      current.has('projects') ? current : new Set(current).add('projects'),
    );
    setExpandedProjectIds((current) =>
      current.has(project.id) ? current : new Set(current).add(project.id),
    );
  }, [activeConversationId, visibleConversations, visibleProjects]);

  const closeMenus = useCallback(() => {
    setOpenMenu(null);
    setContextMenu(null);
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
        onClick: () => onProjectAction('open', project),
      },
      {
        key: 'refresh',
        icon: <RefreshCw size={15} />,
        label: language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status',
        onClick: () => onProjectAction('refreshGit', project),
      },
      {
        key: 'new-chat',
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '新建项目会话' : 'New project chat',
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

  return (
    <aside className="sidebar" ref={sidebarRef}>
      <nav className="sidebar-nav">
        <NavRow
          icon={<Edit3 size={17} />}
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
          active={section === 'search'}
          icon={<Search size={17} />}
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
        <NavRow
          active={section === 'skills'}
          icon={<Puzzle size={17} />}
          label={t('skills')}
          onClick={() => onSectionChange('skills')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:skills', [
              {
                key: 'open',
                icon: <Puzzle size={15} />,
                label: language === 'zh' ? '打开技能' : 'Open skills',
                onClick: () => onSectionChange('skills'),
              },
            ])
          }
        />
        <NavRow
          active={section === 'subagents'}
          icon={<Network size={17} />}
          label={t('subagents')}
          onClick={() => onSectionChange('subagents')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:subagents', [
              {
                key: 'open',
                icon: <Network size={15} />,
                label: language === 'zh' ? '打开子 Agent' : 'Open subagents',
                onClick: () => onSectionChange('subagents'),
              },
            ])
          }
        />
        <NavRow
          active={section === 'team'}
          icon={<UsersRound size={17} />}
          label={t('team')}
          onClick={() => onSectionChange('team')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:team', [
              {
                key: 'open',
                icon: <UsersRound size={15} />,
                label: language === 'zh' ? '打开 Team' : 'Open Team',
                onClick: () => onSectionChange('team'),
              },
            ])
          }
        />
      </nav>

      <div className="sidebar-scroll">
        <SectionHeader
          title={language === 'zh' ? '项目' : 'Projects'}
          action={<FolderOpen size={14} />}
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
            ])
          }
        />
        {expandedSections.has('projects') && visibleProjects.map((project) => (
          <ProjectBlock
            key={project.id}
            project={project}
            conversations={visibleConversations.filter(
              (item) => {
                const projectDir = conversationProjectDir(item);
                return Boolean(projectDir && samePath(projectDir, project.rootPath));
              },
            )}
            activeConversationId={activeConversationId}
            runningConversationIds={runningConversationIds}
            menuOpen={openMenu === `project:${project.id}`}
            language={language}
            expanded={expandedProjectIds.has(project.id)}
            onToggleExpanded={() => toggleProject(project.id)}
            onContextMenu={(event) =>
              openContextMenu(event, `project:${project.id}`, projectMenuItems(project))
            }
            onMenuToggle={() =>
              toggleInlineMenu(`project:${project.id}`)
            }
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
            changeReportsByConversation={changeReportsByConversation}
            onOpenConversationChanges={onOpenConversationChanges}
            openMenu={openMenu}
          />
        ))}

        <div className="section-header-wrap">
          <SectionHeader
            title={language === 'zh' ? '对话' : 'Conversations'}
            action={<MoreHorizontal size={14} />}
            expanded={expandedSections.has('conversations')}
            onToggle={() => toggleSection('conversations')}
            onAction={() =>
              toggleInlineMenu('section:conversations')
            }
            onContextMenu={(event) =>
              openContextMenu(event, 'section:conversations', [
                {
                  key: 'toggle',
                  icon: <ChevronDown size={15} />,
                  label: expandedSections.has('conversations')
                    ? language === 'zh'
                      ? '收起对话'
                      : 'Collapse conversations'
                    : language === 'zh'
                      ? '展开对话'
                      : 'Expand conversations',
                  onClick: () => toggleSection('conversations'),
                },
                {
                  key: 'new-chat',
                  icon: <Edit3 size={15} />,
                  label: language === 'zh' ? '新建普通对话' : 'New chat',
                  onClick: onCreateConversation,
                },
                {
                  key: 'restore',
                  icon: <Archive size={15} />,
                  label: language === 'zh' ? '恢复归档对话' : 'Restore archived chats',
                  onClick: () => setArchivedConversationIds(new Set()),
                },
              ])
            }
          />
          {openMenu === 'section:conversations' && (
            <SidebarMenu>
              <SidebarMenuButton icon={<Edit3 size={15} />} onClick={onCreateConversation}>
                {language === 'zh' ? '新建普通对话' : 'New chat'}
              </SidebarMenuButton>
              <SidebarMenuButton
                icon={<Archive size={15} />}
                onClick={() => setArchivedConversationIds(new Set())}
              >
                {language === 'zh' ? '恢复归档对话' : 'Restore archived chats'}
              </SidebarMenuButton>
            </SidebarMenu>
          )}
        </div>
        {expandedSections.has('conversations') && visibleConversations
          .filter((item) => !isKnownProjectConversation(item))
          .map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeConversationId}
              running={runningConversationIds?.has(conversation.id) ?? false}
              menuOpen={openMenu === `conversation:${conversation.id}`}
              language={language}
              onMenuToggle={() =>
                toggleInlineMenu(`conversation:${conversation.id}`)
              }
              onArchive={() => toggleConversationArchive(conversation.id)}
              onDelete={() => onDeleteConversation(conversation.id)}
              changeReports={changeReportsByConversation[conversation.id] ?? []}
              onOpenChanges={() => onOpenConversationChanges(conversation.id)}
              onRename={() => {
                const nextTitle = window.prompt(
                  language === 'zh' ? '重命名对话' : 'Rename chat',
                  conversation.title,
                );
                if (nextTitle?.trim()) {
                  onRenameConversation(conversation.id, nextTitle);
                }
              }}
              onContextMenu={(event, options) =>
                openContextMenu(
                  event,
                  `conversation:${conversation.id}`,
                  conversationMenuItems(conversation, options),
                )
              }
              onClick={() => onConversationChange(conversation.id)}
            />
          ))}
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
}

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
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SectionHeader({
  title,
  action,
  expanded = true,
  onToggle,
  onAction,
  onContextMenu,
}: {
  title: string;
  action: React.ReactNode;
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
        onClick={(event) => {
          event.stopPropagation();
          onAction?.();
        }}
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
  changeReportsByConversation,
  onOpenConversationChanges,
}: {
  project: ProjectItem;
  conversations: ConversationSummary[];
  activeConversationId: string;
  runningConversationIds?: Set<string>;
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
  onRenameConversation: (conversationId: string, title: string) => void;
  onConversationContextMenu: (
    event: ReactMouseEvent,
    conversation: ConversationSummary,
    options: ConversationMenuOptions,
  ) => void;
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onOpenConversationChanges: (conversationId: string) => void;
}) {
  return (
    <div className="project-block">
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
        <Folder size={17} />
        <div className="project-title">
          <span>{project.title}</span>
        </div>
        <button
          className="row-new-chat"
          data-sidebar-menu-trigger="true"
          type="button"
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
            <SidebarMenuButton icon={<FolderOpen size={15} />} onClick={() => onProjectAction('open')}>
              {language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<RefreshCw size={15} />} onClick={() => onProjectAction('refreshGit')}>
              {language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Edit3 size={15} />} onClick={() => onProjectAction('newChat')}>
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
          nested
          menuOpen={openMenu === `conversation:${conversation.id}`}
          language={language}
          onMenuToggle={() => onConversationMenuToggle(conversation.id)}
          onArchive={() => onConversationArchive(conversation.id)}
          onDelete={() => onDeleteConversation(conversation.id)}
          changeReports={changeReportsByConversation[conversation.id] ?? []}
          onOpenChanges={() => onOpenConversationChanges(conversation.id)}
          onRename={() => {
            const nextTitle = window.prompt(
              language === 'zh' ? '重命名对话' : 'Rename chat',
              conversation.title,
            );
            if (nextTitle?.trim()) {
              onRenameConversation(conversation.id, nextTitle);
            }
          }}
          onContextMenu={(event, options) =>
            onConversationContextMenu(event, conversation, options)
          }
          onClick={() => onConversationChange(conversation.id)}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  running,
  nested,
  language,
  menuOpen,
  onMenuToggle,
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
  nested?: boolean;
  language: AppLanguage;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: () => void;
  onDelete: () => void;
  changeReports?: ConversationChangeReport[];
  onOpenChanges?: () => void;
  onRename: () => void;
  onContextMenu?: (event: ReactMouseEvent, options: ConversationMenuOptions) => void;
  onClick: () => void;
}) {
  const changeCount = changeReports?.reduce((sum, report) => sum + report.fileCount, 0) ?? 0;
  const menuOptions: ConversationMenuOptions = {
    changeCount,
    onOpenChanges,
    onRename,
    onArchive,
    onDelete,
  };
  return (
    <div
      className={`conversation-row ${nested ? 'nested' : ''} ${active ? 'active' : ''} ${running ? 'running' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={(event) => onContextMenu?.(event, menuOptions)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <span className="conversation-title">{conversation.title}</span>
      {running && (
        <span
          className="conversation-running-indicator"
          role="status"
          aria-label={language === 'zh' ? '会话运行中' : 'Session running'}
          title={language === 'zh' ? '会话运行中' : 'Session running'}
        />
      )}
      {changeCount > 0 && (
        <button
          className="conversation-change-badge"
          type="button"
          title={language === 'zh' ? '查看本会话 Diff' : 'View chat diff'}
          aria-label={language === 'zh' ? '查看本会话 Diff' : 'View chat diff'}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChanges?.();
          }}
        >
          <Code2 size={13} />
          <b>{changeCount}</b>
        </button>
      )}
      <button
        className="conversation-more"
        data-sidebar-menu-trigger="true"
        type="button"
        aria-label="conversation options"
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
        }}
        onContextMenu={(event) => {
          event.stopPropagation();
          onContextMenu?.(event, menuOptions);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {menuOpen && (
        <SidebarMenu>
          <SidebarMenuButton icon={<MessageSquare size={15} />} onClick={onClick}>
            {language === 'zh' ? '打开对话' : 'Open chat'}
          </SidebarMenuButton>
          {changeCount > 0 && (
            <SidebarMenuButton icon={<Code2 size={15} />} onClick={() => onOpenChanges?.()}>
              {language === 'zh' ? '查看 Diff' : 'View diff'}
            </SidebarMenuButton>
          )}
          <SidebarMenuButton icon={<Edit3 size={15} />} onClick={onRename}>
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
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`sidebar-menu-button ${danger ? 'danger' : ''}`}
      type="button"
      onClick={(event) => {
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
  notice,
  revertingChangeId,
  onClose,
  onRevert,
  onRevertAll,
}: {
  language: AppLanguage;
  conversation: ConversationSummary;
  reports: ConversationChangeReport[];
  notice: string;
  revertingChangeId: string;
  onClose: () => void;
  onRevert: (report: ConversationChangeReport) => Promise<void>;
  onRevertAll: () => Promise<void>;
}) {
  const totals = reports.reduce(
    (sum, report) => ({
      files: sum.files + report.fileCount,
      additions: sum.additions + report.additions,
      deletions: sum.deletions + report.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const allBusy = revertingChangeId === `conversation:${conversation.id}`;
  return (
    <div
      className="modal-backdrop change-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="change-review-dialog">
        <header>
          <div>
            <strong>{language === 'zh' ? '会话修改' : 'Chat changes'}</strong>
            <span>{conversation.title}</span>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="change-review-summary">
          <Code2 size={16} />
          <span>
            {language === 'zh'
              ? `${reports.length} 组修改，${totals.files} 个文件`
              : `${reports.length} change set(s), ${totals.files} file(s)`}
          </span>
          {totals.additions > 0 && <b className="diff-count add">+{totals.additions}</b>}
          {totals.deletions > 0 && <b className="diff-count del">-{totals.deletions}</b>}
          <button
            className="danger-soft-button"
            type="button"
            disabled={Boolean(revertingChangeId)}
            onClick={() => void onRevertAll()}
          >
            {allBusy ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
            <span>{language === 'zh' ? '撤回全部修改' : 'Revert all'}</span>
          </button>
        </div>
        {notice && <pre className="change-review-notice">{notice}</pre>}
        <div className="change-review-list">
          {reports.map((report, index) => {
            const busy = revertingChangeId === report.id;
            return (
              <section className="change-review-card" key={report.id}>
                <header>
                  <div>
                    <strong>
                      {language === 'zh'
                        ? `修改 ${index + 1}`
                        : `Change ${index + 1}`}
                    </strong>
                    <span>{formatChangeTimestamp(report.createdAt, language)}</span>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(revertingChangeId)}
                    onClick={() => void onRevert(report)}
                  >
                    {busy ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
                    <span>{language === 'zh' ? '撤回这组' : 'Revert set'}</span>
                  </button>
                </header>
                <div className="change-review-files">
                  {report.files.map((file, fileIndex) => (
                    <ToolFileChangeView
                      // eslint-disable-next-line react/no-array-index-key
                      key={`${report.id}-${file.path}-${fileIndex}`}
                      file={file}
                      language={language}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
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


