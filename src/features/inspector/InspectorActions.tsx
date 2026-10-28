import { uiText } from '../../i18n';
import { Clipboard, Clock3, Ellipsis, FolderOpen, PanelsTopLeft, Plus, Save } from 'lucide-react';
import { ShadowCloneIcon } from '../../components/ShadowCloneIcon';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useState } from 'react';
import { BrowserLibraryDialog } from '../browser/BrowserLibraryDialog';
import { BrowserStartBookmarks } from '../browser/BrowserStartBookmarks';
import { InspectorLayoutDialog } from './InspectorLayoutDialog';
import { useSavedInspectorLayouts } from './useSavedInspectorLayouts';
import type { SavedInspectorLayout } from './savedInspectorLayouts';

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
  onSaveLayout,
  onOpenLayout,
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
  onSaveLayout?: () => void;
  onOpenLayout?: (layout: SavedInspectorLayout) => void;
}) {

  const shortcuts = useKeyboardShortcuts();
  const [bookmarkDialog, setBookmarkDialog] = useState<'bookmarks' | 'import' | null>(null);
  const savedLayouts = useSavedInspectorLayouts();
  const [editingLayout, setEditingLayout] = useState<SavedInspectorLayout | null>(null);
  const actions = [
    ...(onOpenReview ? [{
      id: 'review', icon: <Clipboard size={16} aria-hidden="true" />,
      label: uiText(language)('app.review'), shortcut: shortcuts.label('openReview'), keyShortcut: shortcuts.aria('openReview'),
      description: uiText(language)('inspectorActions.reviewFileChangesAndWorkspaceActions'),
      unavailable: '', onClick: onOpenReview,
    }] : []),
    ...(onOpenHistory ? [{
      id: 'history', icon: <Clock3 size={16} aria-hidden="true" />,
      label: uiText(language)('browserMenu.history'), shortcut: '', keyShortcut: undefined,
      description: uiText(language)('inspectorActions.browseTurnDetailsAndToolActivity'),
      unavailable: '', onClick: onOpenHistory,
    }] : []),
    {
      id: 'files', icon: <FolderOpen size={16} aria-hidden="true" />,
      label: uiText(language)('inspectorActions.files'), shortcut: shortcuts.label('openFiles'), keyShortcut: shortcuts.aria('openFiles'),
      description: uiText(language)('inspectorActions.chooseOneOrMoreFiles'),
      unavailable: filesAvailable ? '' : uiText(language)('inspectorActions.localFileSelectionIsUnavailable'),
      onClick: onOpenFiles,
    },
    {
      id: 'shadow', icon: <ShadowCloneIcon size={16} />,
      label: uiText(language)('inspectorActions.shadowChat'), shortcut: shortcuts.label('openShadow'), keyShortcut: shortcuts.aria('openShadow'),
      description: uiText(language)('inspectorActions.freezeTheCurrentConversationHistory'),
      unavailable: shadowUnavailableReason, onClick: onOpenShadow,
    },
    ...(onMultiPage ? [{ id: 'multi-page', icon: <PanelsTopLeft size={16} aria-hidden="true" />,
      label: uiText(language)('inspectorActions.multiplePagesBeta', { value1: (multiPage ? uiText(language)('inspectorActions.exit') : '') }), shortcut: '', keyShortcut: undefined,
      description: uiText(language)('inspectorActions.arrangeMultipleInspectorPagesOnALarge'), unavailable: '', onClick: onMultiPage }] : []),
  ];
  return (
    <div className="right-inspector-start-actions" aria-label={uiText(language)('browserStartPage.newTab')}>
      <section className="inspector-start-tools" aria-label={uiText(language)('inspectorActions.tools')}>
      <h2>{uiText(language)('inspectorActions.tools')}</h2>
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
        <Plus size={16} aria-hidden="true"/><span><strong>{uiText(language)('inspectorActions.addPage')}</strong></span>
      </button>}
      {multiPage && onSaveLayout && <button type="button" data-inspector-action="save-layout" onClick={onSaveLayout}>
        <Save size={16} aria-hidden="true"/><span><strong>{uiText(language)('inspectorActions.saveLayout')}</strong></span>
      </button>}
      {onOpenLayout && savedLayouts.map(layout => <div key={layout.id} className="inspector-saved-layout" data-saved-layout={layout.id}>
        <button type="button" className="inspector-saved-layout-open" onClick={() => onOpenLayout(layout)}>
          <PanelsTopLeft size={16} aria-hidden="true"/><span><strong>{layout.name}</strong></span><small>{layout.pages.length}</small>
        </button>
        <button type="button" className="inspector-saved-layout-edit" aria-label={uiText(language)('inspectorActions.edit', { value1: layout.name })} onClick={() => setEditingLayout(layout)}><Ellipsis size={15} aria-hidden="true"/></button>
      </div>)}
      </section>
      {onOpenBookmark && <BrowserStartBookmarks language={language} onNavigate={onOpenBookmark}
        onImport={() => setBookmarkDialog('import')} onManage={() => setBookmarkDialog('bookmarks')}/>}
      {bookmarkDialog && <BrowserLibraryDialog kind={bookmarkDialog} language={language} onClose={() => setBookmarkDialog(null)} onNavigate={onOpenBookmark}/>}
      {editingLayout && <InspectorLayoutDialog language={language} saved={editingLayout} snapshot={null} onClose={() => setEditingLayout(null)}/>}
    </div>
  );
}
