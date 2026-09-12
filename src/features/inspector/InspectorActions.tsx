import { Clipboard, Clock3, FolderOpen, Globe2 } from 'lucide-react';
import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import type { AppLanguage } from '../../types';

/** Shared entry points for the empty sidebar and the tab bar's add menu. */
export function InspectorActions({
  language,
  menu = false,
  filesAvailable,
  shadowUnavailableReason,
  onOpenReview,
  onOpenHistory,
  onOpenFiles,
  onOpenShadow,
  onOpenBrowser,
}: {
  language: AppLanguage;
  menu?: boolean;
  filesAvailable: boolean;
  shadowUnavailableReason: string;
  onOpenReview?: () => void;
  onOpenHistory?: () => void;
  onOpenFiles: () => void;
  onOpenShadow: () => void;
  onOpenBrowser: () => void;
}) {
  const zh = language === 'zh';
  const actions = [
    ...(onOpenReview ? [{
      id: 'review', icon: <Clipboard size={16} aria-hidden="true" />,
      label: zh ? '审查' : 'Review', shortcut: 'Ctrl+Shift+G', keyShortcut: 'Control+Shift+G',
      description: zh ? '查看文件修改与工作区操作' : 'Review file changes and workspace actions',
      unavailable: '', onClick: onOpenReview,
    }] : []),
    ...(onOpenHistory ? [{
      id: 'history', icon: <Clock3 size={16} aria-hidden="true" />,
      label: zh ? '历史记录' : 'History', shortcut: '', keyShortcut: undefined,
      description: zh ? '查看与切换回合执行详情' : 'Browse turn details and tool activity',
      unavailable: '', onClick: onOpenHistory,
    }] : []),
    {
      id: 'files', icon: <FolderOpen size={16} aria-hidden="true" />,
      label: zh ? '文件' : 'Files', shortcut: 'Ctrl+P', keyShortcut: 'Control+P',
      description: zh ? '选择一个或多个文件' : 'Choose one or more files',
      unavailable: filesAvailable ? '' : zh ? '当前环境不支持选择本地文件' : 'Local file selection is unavailable',
      onClick: onOpenFiles,
    },
    {
      id: 'shadow', icon: <ShadowCloneIcon size={16} />,
      label: zh ? 'Shadow 对话' : 'Shadow chat', shortcut: 'Ctrl+Alt+S', keyShortcut: 'Control+Alt+S',
      description: zh ? '基于当前会话冻结历史' : 'Freeze the current conversation history',
      unavailable: shadowUnavailableReason, onClick: onOpenShadow,
    },
    {
      id: 'browser', icon: <Globe2 size={16} aria-hidden="true" />,
      label: zh ? '浏览器' : 'Browser', shortcut: 'Ctrl+T', keyShortcut: 'Control+T',
      description: zh ? '打开可导航的空白页' : 'Open a navigable blank page',
      unavailable: '', onClick: onOpenBrowser,
    },
  ];
  return (
    <div className={menu ? 'right-inspector-add-menu' : 'right-inspector-start-actions'}
      role={menu ? 'menu' : 'group'} aria-label={zh ? '打开侧栏内容' : 'Open sidebar content'}>
      {actions.map((action) => (
        <button key={action.id} type="button" role={menu ? 'menuitem' : undefined}
          data-inspector-action={action.id}
          disabled={Boolean(action.unavailable)}
          title={action.unavailable || action.description}
          aria-keyshortcuts={action.unavailable ? undefined : action.keyShortcut}
          onClick={action.onClick}>
          {action.icon}
          <span>
            <strong>{action.label}</strong>
            {menu && <small>{action.description}</small>}
          </span>
          {action.shortcut && <kbd>{action.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
