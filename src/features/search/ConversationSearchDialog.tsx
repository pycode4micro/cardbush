import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { Edit3, FolderOpen, LoaderCircle, MessageSquare, Search } from 'lucide-react';
import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AppLanguage, ConversationSummary, ProjectItem } from '../../types';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { basename, samePath } from '../../shared/localPaths';
import { conversationProjectId } from '../conversationScope';
import { conversationProjectDir } from '../conversationWorkspace';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import './conversationSearch.css';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

export const ConversationSearchDialog = memo(function ConversationSearchDialog({
  language, conversations, projects, runningConversationIds, onClose,
  onOpenConversation, onCreateConversation, onAddProject, onOpenFiles,
}: {
  language: AppLanguage;
  conversations: ConversationSummary[];
  projects: ProjectItem[];
  runningConversationIds?: Set<string>;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
  onCreateConversation: () => void;
  onAddProject?: () => void;
  onOpenFiles?: () => void;
}) {

  const shortcuts = useKeyboardShortcuts();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<() => void>(() => {});
  const pointerStartedOutside = useRef(false);
  const id = useId();
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const entries = useMemo(() => conversations.map(conversation => {
    const title = conversationDisplayTitle(conversation.title) || (uiText(language)('conversationSearchDialog.untitledChat'));
    const projectDir = conversationProjectDir(conversation);
    const projectId = conversationProjectId(conversation);
    const project = projects.find(item => item.id === projectId || Boolean(projectDir && samePath(item.rootPath, projectDir)));
    const projectTitle = project?.title || basename(projectDir);
    return { conversation, title, projectTitle, projectDir,
      text: normalize(`${title} ${conversation.preview} ${projectTitle} ${projectDir}`),
      updated: Date.parse(conversation.updatedAt) || 0 };
  }).sort((a, b) => b.updated - a.updated), [conversations, projects, language]);
  const matches = useMemo(() => {
    const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
    return terms.length ? entries.filter(entry => terms.every(term => entry.text.includes(term))) : entries;
  }, [entries, query]);
  const results = matches.slice(0, query.trim() ? 50 : 9);
  const actions = [
    { key: 'new', title: uiText(language)('conversationSearchDialog.newChat'), icon: <Edit3 size={15} />, run: onCreateConversation },
    ...(onAddProject ? [{ key: 'project', title: uiText(language)('conversationSearchDialog.openFolder'), icon: <FolderOpen size={15} />, run: onAddProject }] : []),
    ...(onOpenFiles ? [{ key: 'files', title: uiText(language)('conversationSearchDialog.openFiles'), icon: <Search size={15} />, run: onOpenFiles,
      shortcut: shortcuts.label('openFiles').replaceAll(' + ', '+') }] : []),
  ];
  const keys = [...results.map(item => `chat:${item.conversation.id}`), ...actions.map(item => item.key)];
  const selectedIndex = Math.max(0, keys.indexOf(selectedKey));
  const activeKey = keys[selectedIndex];
  const activeOptionId = `${id}-option-${selectedIndex}`;

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textInput = previous instanceof HTMLTextAreaElement || previous instanceof HTMLInputElement ? previous : null;
    const textSelection = textInput?.selectionStart != null
      ? { start: textInput.selectionStart, end: textInput.selectionEnd, direction: textInput.selectionDirection } : null;
    const selection = window.getSelection();
    const range = previous?.isContentEditable && selection?.rangeCount && previous.contains(selection.anchorNode)
      ? selection.getRangeAt(0).cloneRange() : null;
    let restored = false;
    const restoreFocus = () => {
      if (restored) return;
      restored = true;
      if (!previous?.isConnected) return;
      previous.focus({ preventScroll: true });
      if (textInput && textSelection) textInput.setSelectionRange(textSelection.start, textSelection.end, textSelection.direction ?? undefined);
      else if (range?.startContainer.isConnected && range.endContainer.isConnected) {
        const currentSelection = window.getSelection();
        currentSelection?.removeAllRanges(); currentSelection?.addRange(range);
      }
    };
    restoreFocusRef.current = restoreFocus;
    // Native modal focus containment leaves the transcript mounted and its scroll untouched.
    dialog.showModal();
    inputRef.current?.focus({ preventScroll: true });
    return () => { dialog.close(); restoreFocus(); };
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    const option = document.getElementById(activeOptionId);
    if (!list || !option) return;
    const container = list.getBoundingClientRect();
    const item = option.getBoundingClientRect();
    // Scroll this list only, never the underlying conversation or document.
    if (item.top < container.top) list.scrollTop -= container.top - item.top;
    else if (item.bottom > container.bottom) list.scrollTop += item.bottom - container.bottom;
  }, [activeOptionId, activeKey, query]);

  function finish(action?: () => void) {
    dialogRef.current?.close();
    restoreFocusRef.current();
    onClose();
    action?.();
  }

  function activate(index: number) {
    const result = results[index];
    if (result) finish(() => onOpenConversation(result.conversation.id));
    else finish(actions[index - results.length]?.run);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); return; }
    if (event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation();
      const closeButton = dialogRef.current?.querySelector<HTMLButtonElement>('.conversation-search-close');
      (event.target === inputRef.current ? closeButton : inputRef.current)?.focus({ preventScroll: true });
      return;
    }
    if (shortcuts.matches('searchConversations', event.nativeEvent)) {
      event.preventDefault(); event.stopPropagation(); inputRef.current?.select(); return;
    }
    if (onOpenFiles && shortcuts.matches('openFiles', event.nativeEvent)) {
      event.preventDefault(); event.stopPropagation(); finish(onOpenFiles); return;
    }
    if (event.ctrlKey || event.metaKey) {
      const index = Number(event.key) - 1;
      if (!event.altKey && !event.shiftKey && !event.repeat && /^[1-9]$/.test(event.key) && results[index]) {
        event.preventDefault(); event.stopPropagation(); activate(index);
      }
      return;
    }
    if (event.altKey || event.shiftKey || event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      setSelectedKey(keys[(selectedIndex + (event.key === 'ArrowDown' ? 1 : keys.length - 1)) % keys.length]);
    } else if (event.key === 'Enter' && !event.repeat) {
      event.preventDefault(); event.stopPropagation(); activate(selectedIndex);
    }
  }

  function outside(event: { clientX: number; clientY: number }) {
    const rect = dialogRef.current!.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }

  return <dialog ref={dialogRef} className="conversation-search-dialog" data-conversation-search role="dialog" aria-modal="true"
    aria-label={uiText(language)('conversationSearchDialog.searchChats')} onKeyDown={onKeyDown}
    onCancel={dialogEventHandler(event => { event.preventDefault(); finish(); })}
    onPointerDown={event => { pointerStartedOutside.current = event.target === event.currentTarget && outside(event); }}
    onClick={event => { if (pointerStartedOutside.current && event.target === event.currentTarget && outside(event)) finish(); }}>
    <header className="conversation-search-header">
      <Search size={17} aria-hidden="true" />
      <input ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded="true"
        aria-controls={`${id}-list`} aria-activedescendant={activeOptionId}
        aria-label={uiText(language)('conversationSearchDialog.searchChats')} placeholder={uiText(language)('conversationSearchDialog.searchChats')}
        value={query} onChange={event => { setQuery(event.target.value); setSelectedKey(''); }} />
      <button type="button" className="conversation-search-close" aria-label={uiText(language)('conversationSearchDialog.closeSearch')} onClick={() => finish()}><kbd>{uiText(language)('conversationSearchDialog.esc')}</kbd></button>
    </header>
    <div className="conversation-search-list" ref={listRef} id={`${id}-list`} role="listbox" aria-label={uiText(language)('conversationSearchDialog.chatsAndQuickActions')}>
      <div role="group" aria-label={uiText(language)('conversationSearchDialog.chats')}>
        <div className="conversation-search-label" aria-hidden="true">{query.trim() ? (uiText(language)('conversationSearchDialog.chats')) : (uiText(language)('conversationSearchDialog.recentChats'))}</div>
        {results.map((item, index) => <button type="button" role="option" tabIndex={-1}
          id={`${id}-option-${index}`} key={item.conversation.id} data-search-conversation={item.conversation.id}
          className="conversation-search-option" aria-selected={selectedIndex === index}
          title={item.title} onPointerMove={() => setSelectedKey(`chat:${item.conversation.id}`)}
          onMouseDown={event => event.preventDefault()} onClick={() => activate(index)}>
          <span className="conversation-search-icon">{runningConversationIds?.has(item.conversation.id)
            ? <LoaderCircle size={14} className="spin" aria-label={uiText(language)('cardlingWindow.running')} /> : <MessageSquare size={14} aria-hidden="true" />}</span>
          <span className="conversation-search-title">{item.title}</span>
          {item.projectTitle && <span className="conversation-search-project" title={item.projectDir || item.projectTitle}>{item.projectTitle}</span>}
          {index < 9 && <kbd aria-hidden="true">{uiText(language)('conversationSearchDialog.ctrl')}{index + 1}</kbd>}
        </button>)}
        {!results.length && <p className="conversation-search-empty" role="status">{query.trim()
          ? (uiText(language)('conversationSearchDialog.noMatchingChats')) : (uiText(language)('conversationSearchDialog.noChatsYet'))}</p>}
        {query.trim() && matches.length > results.length && <p className="conversation-search-empty" role="status">{uiText(language)('conversationSearchDialog.showing50ResultsKeepTypingToNarrow')}</p>}
      </div>
      <div role="group" aria-label={uiText(language)('conversationSearchDialog.quickActions')}>
        <div className="conversation-search-label" aria-hidden="true">{uiText(language)('conversationSearchDialog.quickActions')}</div>
        {actions.map((action, index) => <button type="button" role="option" tabIndex={-1}
          id={`${id}-option-${results.length + index}`} key={action.key} data-search-action={action.key}
          className="conversation-search-option" aria-selected={activeKey === action.key}
          onPointerMove={() => setSelectedKey(action.key)} onMouseDown={event => event.preventDefault()} onClick={() => finish(action.run)}>
          <span className="conversation-search-icon">{action.icon}</span>
          <span className="conversation-search-title">{action.title}</span>
          {'shortcut' in action && action.shortcut ? <kbd>{action.shortcut}</kbd> : null}
        </button>)}
      </div>
    </div>
  </dialog>;
});
