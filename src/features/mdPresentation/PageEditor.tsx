import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Editor } from '@tiptap/core';
import type { SelectionBookmark } from '@tiptap/pm/state';
import { Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, Minus, Plus, Quote, Strikethrough, Table2, Type, UsersRound, X } from 'lucide-react';
import { pageEditorExtensions, pageMarkdownContent } from './pageEditorExtensions';

export type PageEditorHandle = { focus: () => void; insertMenu: (anchor?: HTMLElement) => void; image: () => void };
type Menu = { x: number; y: number; from: number; to: number; query: string; slash: boolean; bookmark: SelectionBookmark; anchor?: HTMLElement };
const popupEvent = 'cardbush-page-editor-popup';
export function PageEditor({ source, onChange, language, onNavigate, onActive, onReady, onSection, onTask, label }: {
  source: string; onChange: (source: string) => void; language: 'zh' | 'en'; onNavigate: (id: string) => void;
  onActive: () => void; onReady: (handle: PageEditorHandle | null) => void; onSection: () => void; onTask?: () => void; label: string;
}) {
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const host = useRef<HTMLDivElement>(null), instance = useRef<Editor>(null), menuRef = useRef<HTMLDivElement>(null), formatRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onNavigate, onActive, onReady, onSection, onTask }); callbacks.current = { onChange, onNavigate, onActive, onReady, onSection, onTask };
  const accepted = useRef(source), lastEmitted = useRef(source), composing = useRef(false);
  const suppressedSlash = useRef('');
  const [menu, setMenu] = useState<Menu>(), [active, setActive] = useState(0), [error, setError] = useState('');
  const [selection, setSelection] = useState<{ x: number; y: number }>(), [link, setLink] = useState<string>();
  const state = useRef({ menu, active }); state.current = { menu, active };
  const setCurrentMenu = (value: Menu | undefined) => { state.current.menu = value; setMenu(value); };
  const signature = (editor: Editor) => `${editor.state.selection.from}:${editor.state.selection.$from.parent.textContent}`;
  const dismiss = () => { if (instance.current) suppressedSlash.current = signature(instance.current); setCurrentMenu(undefined); setSelection(undefined); setLink(undefined); };
  const announce = (editor: Editor) => document.dispatchEvent(new CustomEvent(popupEvent, { detail: editor.view.dom }));
  const place = (editor: Editor, position: number, anchor?: HTMLElement) => {
    const at = anchor?.getBoundingClientRect() ?? editor.view.coordsAtPos(position);
    const width = Math.min(320, window.innerWidth - 24), height = Math.min(menuRef.current?.offsetHeight || 330, window.innerHeight - 24);
    const below = window.innerHeight - at.bottom - 20, above = at.top - 20;
    const y = below >= height || below >= above ? at.bottom + 8 : at.top - height - 8;
    return { x: Math.max(12, Math.min(at.left, window.innerWidth - width - 12)), y: Math.max(12, Math.min(y, window.innerHeight - height - 12)) };
  };
  const handle = (editor: Editor): PageEditorHandle => ({ focus: () => { if (!editor.isDestroyed) editor.commands.focus('start'); },
    insertMenu: anchor => {
      if (editor.isDestroyed) return;
      if (state.current.menu && state.current.menu.anchor === anchor && !state.current.menu.slash) { dismiss(); return; }
      announce(editor); setSelection(undefined); const { from, to } = editor.state.selection;
      setCurrentMenu({ ...place(editor, from, anchor), from, to, bookmark: editor.state.selection.getBookmark(), anchor, query: '', slash: false }); setActive(0);
    },
    image: () => {
      if (editor.isDestroyed) return;
      announce(editor); dismiss();
      // Inserting a second image or inserting after selected text must not replace existing content.
      editor.chain().focus().insertContentAt(editor.state.selection.to, { type: 'image', attrs: { src: '', alt: '' } }).run();
    } });
  const choices = (editor: Editor) => [
    { id: 'text', label: t('正文', 'Text'), keywords: 'text paragraph zhengwen', icon: Type, run: () => editor.chain().focus().setParagraph().run() },
    ...([1, 2, 3] as const).map((level, index) => ({ id: `heading-${level}`, label: t(`标题 ${level}`, `Heading ${level}`), keywords: `heading h${level} biaoti`, icon: [Heading1, Heading2, Heading3][index], run: () => editor.chain().focus().setHeading({ level }).run() })),
    { id: 'bullet', label: t('无序列表', 'Bullet list'), keywords: 'list bullet wuxuliebiao', icon: List, run: () => editor.chain().focus().toggleBulletList().run() },
    { id: 'ordered', label: t('有序列表', 'Numbered list'), keywords: 'list ordered youxuliebiao', icon: ListOrdered, run: () => editor.chain().focus().toggleOrderedList().run() },
    { id: 'check', label: t('任务清单', 'Checklist'), keywords: 'task todo checklist renwu', icon: ListChecks, run: () => editor.chain().focus().toggleTaskList().run() },
    { id: 'quote', label: t('引用', 'Quote'), keywords: 'quote blockquote yinyong', icon: Quote, run: () => editor.chain().focus().toggleBlockquote().run() },
    { id: 'code', label: t('代码块', 'Code block'), keywords: 'code daima', icon: Code, run: () => editor.chain().focus().toggleCodeBlock().run() },
    { id: 'table', label: t('插入表格', 'Table'), keywords: 'table biaoge', icon: Table2, run: () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'rule', label: t('水平分隔线', 'Divider'), keywords: 'divider line rule fengexian', icon: Minus, run: () => editor.chain().focus().setHorizontalRule().run() },
    { id: 'image', label: t('图像', 'Image'), keywords: 'image photo tuxiang tupian', icon: ImagePlus, run: () => handle(editor).image() },
    { id: 'section', label: t('可引用章节', 'Linked section'), keywords: 'section note zhangjie', icon: Link, run: () => callbacks.current.onSection() },
    ...(callbacks.current.onTask ? [{ id: 'team', label: t('Team 任务', 'Team task'), keywords: 'team agent task renwu', icon: UsersRound, run: () => callbacks.current.onTask?.() }] : []),
  ];
  const filtered = (editor: Editor, query: string) => choices(editor).filter(item => `${item.label} ${item.keywords}`.toLowerCase().includes(query.toLowerCase()));
  const execute = (index: number) => {
    const editor = instance.current, current = state.current.menu; if (!editor || !current) return;
    const choice = filtered(editor, current.query)[index]; if (!choice) return;
    suppressedSlash.current = signature(editor); setCurrentMenu(undefined);
    try {
      if (current.slash) editor.chain().focus().deleteRange({ from: current.from, to: current.to }).run();
      else editor.view.dispatch(editor.state.tr.setSelection(current.bookmark.resolve(editor.state.doc)));
      choice.run(); setCurrentMenu(undefined);
    } catch (caught) { setError(String((caught as Error).message)); }
  };
  const emit = (editor: Editor) => {
    if (composing.current || editor.view.composing) return;
    const value = editor.getMarkdown();
    try { lastEmitted.current = value; callbacks.current.onChange(value); accepted.current = value; setError(''); }
    catch (caught) { setError(String((caught as Error).message)); lastEmitted.current = accepted.current; editor.commands.setContent(pageMarkdownContent(editor, accepted.current), { emitUpdate: false }); }
  };
  useEffect(() => {
    if (!host.current) return;
    const syncSelection = (editor: Editor) => {
      if (!editor.view.dom.contains(document.activeElement) || editor.view.composing || composing.current) return;
      callbacks.current.onActive();
      const { from, to, $from, empty } = editor.state.selection;
      const match = !editor.isActive('codeBlock') && !editor.isActive('literalMarkdown') && /^\/([^\s/]*)$/.exec($from.parent.textBetween(0, $from.parentOffset));
      if (match && empty && suppressedSlash.current !== signature(editor)) {
        announce(editor); setCurrentMenu({ ...place(editor, from), from: from - match[0].length, to, bookmark: editor.state.selection.getBookmark(), query: match[1], slash: true }); setActive(0);
      } else if (state.current.menu?.slash) setCurrentMenu(undefined);
      if (!empty && editor.state.selection.$from.parent.isTextblock) {
        const point = editor.view.coordsAtPos(from); setSelection({ x: Math.max(12, Math.min(point.left, window.innerWidth - 270)), y: Math.max(12, point.top - 48) });
      } else { setSelection(undefined); setLink(undefined); }
    };
    const editor = new Editor({ element: host.current, extensions: pageEditorExtensions(id => callbacks.current.onNavigate(id), language), content: '',
      editorProps: { attributes: { class: 'bush-page-content md-prose', role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' },
        handleKeyDown: (_view, event) => {
          if (event.isComposing || composing.current || editor.view.composing || !state.current.menu) return false;
          const count = filtered(editor, state.current.menu.query).length;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => count ? (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count : 0); return true; }
          if (event.key === 'Enter' && count) { event.preventDefault(); execute(state.current.active); return true; }
          if (event.key === 'Escape') { event.preventDefault(); dismiss(); return true; } return false;
        },
      },
      onUpdate: ({ editor: value }) => { emit(value); syncSelection(value); },
      onSelectionUpdate: ({ editor: value }) => syncSelection(value),
      onFocus: ({ editor: value }) => { announce(value); callbacks.current.onActive(); syncSelection(value); },
    });
    instance.current = editor; editor.commands.setContent(pageMarkdownContent(editor, source), { emitUpdate: false });
    callbacks.current.onReady(handle(editor));
    const start = () => { composing.current = true; setCurrentMenu(undefined); setSelection(undefined); };
    const end = () => { composing.current = false; queueMicrotask(() => { if (!editor.isDestroyed) { emit(editor); syncSelection(editor); } }); };
    const outside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!menuRef.current?.contains(target) && !formatRef.current?.contains(target) && !state.current.menu?.anchor?.contains(target)) dismiss();
    };
    const otherPopup = (event: Event) => { if ((event as CustomEvent).detail !== editor.view.dom) dismiss(); };
    const reposition = () => {
      const current = state.current.menu;
      if (current) { const point = place(editor, Math.min(current.to, editor.state.doc.content.size), current.anchor); if (point.x !== current.x || point.y !== current.y) setCurrentMenu({ ...current, ...point }); }
    };
    const scroll = (event: Event) => {
      if (event.target instanceof globalThis.Node && menuRef.current?.contains(event.target)) return;
      setSelection(undefined);
      // ProseMirror scrolls the caret into view while typing; keep slash commands attached to it.
      if (state.current.menu?.slash) reposition(); else if (state.current.menu) dismiss();
    };
    editor.view.dom.addEventListener('compositionstart', start); editor.view.dom.addEventListener('compositionend', end);
    document.addEventListener('pointerdown', outside); document.addEventListener('scroll', scroll, true);
    document.addEventListener(popupEvent, otherPopup); window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); document.removeEventListener(popupEvent, otherPopup); window.removeEventListener('resize', reposition);
      callbacks.current.onReady(null); editor.destroy(); instance.current = null;
    };
  }, [language]);
  useEffect(() => { const editor = instance.current; if (editor && source.trim() !== lastEmitted.current.trim()) {
    accepted.current = source; lastEmitted.current = source; editor.commands.setContent(pageMarkdownContent(editor, source), { emitUpdate: false }); dismiss();
  } }, [source]);
  useLayoutEffect(() => {
    const current = state.current.menu, editor = instance.current;
    if (current && editor) { const point = place(editor, current.to, current.anchor); if (point.x !== current.x || point.y !== current.y) setCurrentMenu({ ...current, ...point }); }
  }, [menu?.anchor, menu?.query, menu?.slash]);
  useLayoutEffect(() => {
    if (!selection || !formatRef.current) return;
    const rect = formatRef.current.getBoundingClientRect();
    const x = Math.max(12, Math.min(selection.x, window.innerWidth - rect.width - 12)), y = Math.max(12, Math.min(selection.y, window.innerHeight - rect.height - 12));
    if (x !== selection.x || y !== selection.y) setSelection({ x, y });
  }, [selection, link]);
  useEffect(() => { menuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const editor = instance.current, items = editor && menu ? filtered(editor, menu.query) : [];
  const colors = host.current && getComputedStyle(host.current);
  const palette = { ...Object.fromEntries(['--surface-raised', '--text', '--border', '--accent'].map(name => [name, colors?.getPropertyValue(name)])), colorScheme: colors?.colorScheme } as CSSProperties;
  return <div className="bush-page-editor"><button type="button" className="bush-block-insert" aria-label={t('插入内容块', 'Insert block')} onMouseDown={event => event.preventDefault()} onClick={event => instance.current && handle(instance.current).insertMenu(event.currentTarget)}><Plus size={16}/></button>
    <div ref={host}/>{error && <p className="md-error" role="alert">{error}</p>}
    {menu && createPortal(<div ref={menuRef} className="bush-insert-menu" role="dialog" aria-label={t('插入内容', 'Insert content')} style={{ ...palette, left: menu.x, top: menu.y }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); editor?.commands.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => items.length ? (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length : 0); }
      if (event.key === 'Enter' && items.length) { event.preventDefault(); execute(active); }
    }}>
      {!menu.slash && <input autoFocus aria-label={t('查找内容块', 'Find block')} placeholder={t('查找内容块…', 'Find a block…')} value={menu.query} onChange={event => { setCurrentMenu({ ...menu, query: event.target.value }); setActive(0); }}/>}<small>{t('插入到当前位置', 'Insert at cursor')}</small>
      <div role="listbox">{items.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => execute(index)}><item.icon size={17}/>{item.label}</button>)}{!items.length && <p>{t('没有匹配的内容块', 'No matching blocks')}</p>}</div>
    </div>, document.body)}
    {selection && editor && createPortal(<div ref={formatRef} className="bush-format-menu" style={{ ...palette, left: selection.x, top: selection.y }} onMouseDown={event => event.preventDefault()}>
      {([{ icon: Bold, title: t('粗体', 'Bold'), run: () => editor.chain().focus().toggleBold().run() }, { icon: Italic, title: t('斜体', 'Italic'), run: () => editor.chain().focus().toggleItalic().run() },
        { icon: Strikethrough, title: t('删除线', 'Strike'), run: () => editor.chain().focus().toggleStrike().run() }, { icon: Code, title: t('行内代码', 'Inline code'), run: () => editor.chain().focus().toggleCode().run() },
        { icon: Link, title: t('链接', 'Link'), run: () => setLink(String(editor.getAttributes('link').href || '')) }]).map(item => <button type="button" key={item.title} aria-label={item.title} onClick={item.run}><item.icon size={16}/></button>)}
      {link !== undefined && <form onSubmit={event => { event.preventDefault(); if (!link) editor.chain().focus().unsetLink().run(); else if (/^(https?:\/\/|mailto:|#)/i.test(link)) editor.chain().focus().setLink({ href: link }).run(); setLink(undefined); }}>
        <input aria-label={t('链接地址', 'Link URL')} value={link} onMouseDown={event => event.stopPropagation()} onChange={event => setLink(event.target.value)} placeholder="https://"/><button type="submit">{t('确定', 'Apply')}</button><button type="button" aria-label={t('关闭', 'Close')} onClick={() => setLink(undefined)}><X size={14}/></button>
      </form>}
    </div>, document.body)}
  </div>;
}
