import { Node, type Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { fromMarkdown } from 'mdast-util-from-markdown';

const WikiReference = Node.create<{ navigate: (id: string) => void }>({
  name: 'wikiReference', inline: true, group: 'inline', atom: true,
  addOptions: () => ({ navigate: () => {} }),
  addAttributes: () => ({ target: { default: '' }, label: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-wiki-reference]', getAttrs: element => ({ target: element.getAttribute('data-wiki-reference') || '', label: element.textContent || '' }) }],
  renderHTML: ({ node }) => ['span', { 'data-wiki-reference': node.attrs.target, class: 'md-wiki-link' }, node.attrs.label],
  markdownTokenizer: {
    name: 'wikiReference', level: 'inline', start: source => source.indexOf('[[#'),
    tokenize: source => { const match = /^\[\[#([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(source);
      return match ? { type: 'wikiReference', raw: match[0], target: match[1].trim(), label: match[2] || match[1].trim() } : undefined; },
  },
  parseMarkdown: (token, helpers) => helpers.createNode('wikiReference', { target: token.target, label: token.label }),
  renderMarkdown: node => `[[#${node.attrs?.target}${node.attrs?.label === node.attrs?.target ? '' : `|${node.attrs?.label}`}]]`,
  addNodeView() { return ({ node }) => {
    const dom = document.createElement('span'); dom.className = 'md-wiki-link'; dom.textContent = node.attrs.label;
    dom.setAttribute('role', 'link'); dom.tabIndex = 0; dom.contentEditable = 'false';
    dom.onclick = () => this.options.navigate(node.attrs.target);
    dom.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.options.navigate(node.attrs.target); } };
    return { dom };
  }; },
});

// Unsupported Markdown stays editable and is exported verbatim, rather than silently dropped by a rich-text schema.
const LiteralMarkdown = Node.create({
  name: 'literalMarkdown', group: 'block', content: 'text*', marks: '', code: true, defining: true,
  parseHTML: () => [{ tag: 'pre[data-markdown-literal]' }],
  renderHTML: () => ['pre', { 'data-markdown-literal': '', class: 'md-literal-markdown' }, ['code', 0]],
  renderMarkdown: node => (node.content || []).map(child => child.text || '').join(''),
  addKeyboardShortcuts() { return { Enter: () => this.editor.isActive(this.name) ? this.editor.commands.insertContent('\n') : false }; },
});

export function pageMarkdownContent(editor: Editor, source: string): JSONContent {
  const unsupported = (node: { type: string; children?: unknown[] }): boolean =>
    ['html', 'definition', 'linkReference', 'imageReference'].includes(node.type) || (node.children || []).some(child => unsupported(child as typeof node));
  const ranges = fromMarkdown(source).children.filter(unsupported).map(node => ({ start: node.position!.start.offset!, end: node.position!.end.offset! }));
  if (!ranges.length) return editor.markdown!.parse(source);
  const content: JSONContent[] = []; let cursor = 0;
  const append = (chunk: string) => { if (chunk.trim()) content.push(...(editor.markdown!.parse(chunk.trim()).content || [])); };
  for (const range of ranges) {
    if (range.start > cursor) append(source.slice(cursor, range.start));
    content.push({ type: 'literalMarkdown', content: [{ type: 'text', text: source.slice(range.start, range.end) }] }); cursor = range.end;
  }
  if (cursor < source.length) append(source.slice(cursor));
  return { type: 'doc', content };
}

export function pageEditorExtensions(navigate: (id: string) => void, language: 'zh' | 'en') {
  const zh = language === 'zh';
  const PageImage = Image.extend({
    addNodeView() { return ({ node, getPos, editor }) => {
      const dom = document.createElement('figure'); dom.className = 'bush-page-image'; dom.contentEditable = 'false';
      const image = document.createElement('img'); image.draggable = false;
      const panel = document.createElement('div'); panel.className = 'bush-image-slot';
      const upload = document.createElement('button'); upload.type = 'button'; upload.textContent = zh ? '＋ 添加图片' : '+ Add image';
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp,image/gif'; file.hidden = true;
      const url = document.createElement('input'); url.type = 'url'; url.placeholder = zh ? '或粘贴图片链接，按 Enter' : 'Or paste an image URL and press Enter';
      url.setAttribute('aria-label', zh ? '图片链接' : 'Image URL');
      const status = document.createElement('small'); status.setAttribute('role', 'status');
      const valid = (value: string) => /^https?:\/\//i.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(value);
      const save = (src: string) => { const position = getPos(); if (typeof position === 'number' && dom.isConnected) editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, src })); };
      upload.onclick = () => file.click();
      file.onchange = () => {
        const selected = file.files?.[0]; if (!selected) return;
        if (selected.size > 700 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(selected.type)) { status.textContent = zh ? '请选择 700 KB 内的 PNG、JPEG、WebP 或 GIF。' : 'Choose a PNG, JPEG, WebP or GIF under 700 KB.'; return; }
        const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === 'string') save(reader.result); }; reader.readAsDataURL(selected);
      };
      url.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (valid(url.value.trim())) save(url.value.trim()); else status.textContent = zh ? '请输入 http 或 https 图片地址。' : 'Enter an http or https image URL.'; } };
      panel.append(upload, url, file, status); dom.append(image, panel);
      const render = () => { const src = String(node.attrs.src || ''); image.hidden = !valid(src); panel.hidden = valid(src);
        if (valid(src)) { if (image.getAttribute('src') !== src) image.src = src; image.alt = String(node.attrs.alt || ''); } else image.removeAttribute('src'); };
      image.onerror = () => { image.hidden = true; panel.hidden = false; status.textContent = zh ? '图片未能加载，可重新选择。' : 'Image could not load. Choose another image.'; };
      render();
      return { dom, stopEvent: event => event.target instanceof HTMLElement && Boolean(event.target.closest('input,button')), ignoreMutation: () => true,
        update: next => { if (next.type !== node.type) return false; node = next; render(); return true; } };
    }; },
  }).configure({ allowBase64: true });
  return [StarterKit.configure({ link: { openOnClick: false }, underline: false }), Markdown, TableKit, TaskList, TaskItem.configure({ nested: true }),
    PageImage, LiteralMarkdown, WikiReference.configure({ navigate }), Placeholder.configure({ placeholder: zh ? '输入 / 插入内容，开始写作…' : 'Type / to insert content and start writing…' })];
}
