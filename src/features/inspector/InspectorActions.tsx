import { Clipboard, Clock3, FolderOpen, PanelsTopLeft, Plus } from 'lucide-react';
import { useBrowserBookmarks } from './useBrowserBookmarks';
import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useState } from 'react';
import { BrowserLibraryDialog } from '../browser/BrowserLibraryDialog';
import { BrowserSiteIcon } from '../browser/BrowserSiteIcon';
import { BrowserStartBookmarks } from '../browser/BrowserStartBookmarks';

/** Local new-tab content; navigation continues in the same browser tab. */
export function InspectorActions({
  language,
  filesAvailable,
  shadowUnavailableReason,
  onOpenReview,
  onOpenHistory,
  onOpenFiles,
  onOpenShadow,
  onAddPage,
  onOpenBookmark,
  onMultiPage,
  multiPage = false,
}: {
  language: AppLanguage;
  filesAvailable: boolean;
  shadowUnavailableReason: string;
  onOpenReview?: () => void;
  onOpenHistory?: () => void;
  onOpenFiles: () => void;
  onOpenShadow: () => void;
  onAddPage?: () => void;
  onOpenBookmark?: (url: string) => void;
  onMultiPage?: () => void;
  multiPage?: boolean;
}) {
  const zh = language === 'zh';
  const shortcuts = useKeyboardShortcuts();
  const bookmarks = useBrowserBookmarks();
  const [bookmarkDialog, setBookmarkDialog] = useState<'bookmarks' | 'import' | null>(null);
  const actions = [
    ...(onOpenReview ? [{
      id: 'review', icon: <Clipboard size={16} aria-hidden="true" />,
      label: zh ? '审查' : 'Review', shortcut: shortcuts.label('openReview'), keyShortcut: shortcuts.aria('openReview'),
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
      label: zh ? '文件' : 'Files', shortcut: shortcuts.label('openFiles'), keyShortcut: shortcuts.aria('openFiles'),
      description: zh ? '选择一个或多个文件' : 'Choose one or more files',
      unavailable: filesAvailable ? '' : zh ? '当前环境不支持选择本地文件' : 'Local file selection is unavailable',
      onClick: onOpenFiles,
    },
    {
      id: 'shadow', icon: <ShadowCloneIcon size={16} />,
      label: zh ? 'Shadow 对话' : 'Shadow chat', shortcut: shortcuts.label('openShadow'), keyShortcut: shortcuts.aria('openShadow'),
      description: zh ? '基于当前会话冻结历史' : 'Freeze the current conversation history',
      unavailable: shadowUnavailableReason, onClick: onOpenShadow,
    },
    ...(onMultiPage ? [{ id: 'multi-page', icon: <PanelsTopLeft size={16} aria-hidden="true" />,
      label: zh ? `${multiPage ? '退出' : ''}多页面 (Beta)` : `${multiPage ? 'Exit ' : ''}Multiple pages (Beta)`, shortcut: '', keyShortcut: undefined,
      description: zh ? '适用于大屏，同时排列多个侧栏页面' : 'Arrange multiple inspector pages on a large display', unavailable: '', onClick: onMultiPage }] : []),
  ];
  return (
    <div className="right-inspector-start-actions" aria-label={zh ? '新标签页' : 'New tab'}>
      <section className="inspector-start-tools" aria-label={zh ? '工具' : 'Tools'}>
      <h2>{zh ? '工具' : 'Tools'}</h2>
      {actions.map((action) => (
        <button key={action.id} type="button"
          data-inspector-action={action.id}
          disabled={Boolean(action.unavailable)}
          title={action.unavailable || undefined}
          aria-description={action.description}
          aria-keyshortcuts={action.unavailable ? undefined : action.keyShortcut}
          onClick={action.onClick}>
          {action.icon}
          <span>
            <strong>{action.label}</strong>
          </span>
          {action.shortcut && <kbd>{action.shortcut.replaceAll(' + ', '+')}</kbd>}
        </button>
      ))}
      {onAddPage && <button type="button" className="inspector-add-page" onClick={onAddPage}>
        <Plus size={16} aria-hidden="true"/><span><strong>{zh ? '添加页面' : 'Add page'}</strong></span>
      </button>}
      </section>
      {onOpenBookmark && <section className="inspector-start-bookmarks" aria-label={zh ? '常用网站' : 'Shortcuts'}>
        <h2>{zh ? '常用网站' : 'Shortcuts'}</h2>
        <div className="inspector-start-sites">
          {(bookmarks.length ? bookmarks.slice(0, 12) : [{id:'google',title:'Google',url:'https://www.google.com/'}]).map(bookmark =>
            <button key={bookmark.id} type="button" className="inspector-bookmark-entry" title={`${bookmark.title}\n${bookmark.url}`} onClick={() => onOpenBookmark(bookmark.url)}>
              <BrowserSiteIcon url={bookmark.url} size={27}/><strong>{bookmark.title}</strong>
            </button>)}
        </div>
      </section>}
      {onOpenBookmark && <BrowserStartBookmarks language={language} onNavigate={onOpenBookmark}
        onImport={() => setBookmarkDialog('import')} onManage={() => setBookmarkDialog('bookmarks')}/>}
      {bookmarkDialog && <BrowserLibraryDialog kind={bookmarkDialog} language={language} onClose={() => setBookmarkDialog(null)} onNavigate={onOpenBookmark}/>}
    </div>
  );
}
