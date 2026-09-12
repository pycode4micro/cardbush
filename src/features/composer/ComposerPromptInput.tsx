import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { fileUrl } from '../../shared/localPaths';
import { restoreNativeEditorFocus } from '../../shared/editorFocus';
import { pluginPromptParts } from '../plugins/pluginPrompts';

export interface ComposerPromptInputHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

/** Textareas keep native editing until an explicit plugin reference needs inline rendering. */
export const ComposerPromptInput = forwardRef<ComposerPromptInputHandle, {
  value: string;
  plugins: CardbushAppPlugin[];
  language: AppLanguage;
  autoFocus?: boolean;
  placeholder: string;
  onChange(value: string, caret: number): void;
  onSelectionChange(caret: number): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}>(function ComposerPromptInput({ value, plugins, language, autoFocus, placeholder, onChange, onSelectionChange, onKeyDown }, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const focused = useRef(false);
  const lastCaret = useRef(value.length);
  const change = useRef(onChange);
  change.current = onChange;
  const parts = pluginPromptParts(value, plugins);
  const rich = parts.some(part => part.plugin);
  useImperativeHandle(ref, () => ({
    focus: () => (rich ? editor.current : textarea.current)?.focus(),
    setSelectionRange: (start, end) => {
      lastCaret.current = end;
      if (rich && editor.current) selectOffsets(editor.current, start, end);
      else textarea.current?.setSelectionRange(start, end);
    },
  }), [rich]);

  useLayoutEffect(() => {
    const node = editor.current;
    if (!node || composing.current) return;
    const rendered = Array.from(node.querySelectorAll<HTMLElement>('[data-plugin-reference]')).map(chip => chip.dataset.pluginReference);
    const expected = parts.filter(part => part.plugin).map(part => part.text);
    if (readPrompt(node) === value && JSON.stringify(rendered) === JSON.stringify(expected)) return;
    const focused = document.activeElement === node;
    const caret = caretOffset(node);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (!part.plugin) { fragment.append(document.createTextNode(part.text)); continue; }
      const chip = document.createElement('span');
      chip.className = 'composer-plugin-token';
      chip.contentEditable = 'false';
      chip.dataset.pluginReference = part.text;
      chip.title = `$${part.plugin.id}`;
      const logo = part.plugin.logoPath || part.plugin.logoDarkPath;
      if (logo) {
        const image = document.createElement('img'); image.src = fileUrl(logo); image.alt = ''; image.draggable = false;
        chip.append(image);
      } else {
        const fallback = document.createElement('span'); fallback.className = 'composer-plugin-fallback'; fallback.textContent = '$';
        fallback.setAttribute('aria-hidden', 'true'); chip.append(fallback);
      }
      const label = document.createElement('span'); label.textContent = part.plugin.name; chip.append(label);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.tabIndex = -1; remove.textContent = '×';
      remove.setAttribute('aria-label', `${language === 'zh' ? '移除插件引用' : 'Remove plugin reference'} ${part.plugin.name}`);
      remove.onmousedown = event => event.preventDefault();
      remove.onclick = () => {
        const start = offsetBefore(node, chip);
        const current = readPrompt(node);
        change.current(current.slice(0, start) + current.slice(start + part.text.length), start);
        requestAnimationFrame(() => {
          (editor.current ?? textarea.current)?.focus();
          if (editor.current) selectOffsets(editor.current, start, start);
          else textarea.current?.setSelectionRange(start, start);
        });
      };
      chip.append(remove); fragment.append(chip);
    }
    // A text node after a terminal chip gives the caret a valid insertion position.
    fragment.append(document.createTextNode(''));
    node.replaceChildren(fragment);
    if (focused) selectOffsets(node, caret, caret);
  });

  useLayoutEffect(() => {
    if (autoFocus) (editor.current ?? textarea.current)?.focus();
  }, [autoFocus]);

  useLayoutEffect(() => {
    if (!focused.current) return;
    (editor.current ?? textarea.current)?.focus();
    if (editor.current) selectOffsets(editor.current, lastCaret.current, lastCaret.current);
    else textarea.current?.setSelectionRange(lastCaret.current, lastCaret.current);
  }, [rich]);

  useLayoutEffect(() => {
    const resize = () => {
      const node = textarea.current;
      if (!node) return;
      const line = Number.parseFloat(getComputedStyle(node).lineHeight) || 20;
      const maximum = Math.max(line * 2, Math.min(innerHeight * .32, line * 10));
      node.style.height = 'auto';
      node.style.height = `${Math.max(line * 2, Math.min(node.scrollHeight, maximum))}px`;
      node.style.overflowY = node.scrollHeight > maximum ? 'auto' : 'hidden';
    };
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [value, rich]);

  const publish = () => {
    if (editor.current && !composing.current) {
      lastCaret.current = caretOffset(editor.current);
      onChange(readPrompt(editor.current), lastCaret.current);
    }
  };
  const select = () => {
    if (!composing.current) {
      lastCaret.current = editor.current ? caretOffset(editor.current) : textarea.current?.selectionStart ?? 0;
      onSelectionChange(lastCaret.current);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
    onKeyDown(event);
    if (rich && !event.defaultPrevented && event.key === 'Enter' && event.shiftKey) {
      event.preventDefault(); document.execCommand('insertText', false, '\n');
    }
  };
  return rich ? <div ref={editor} className="composer-prompt-editor" data-composer-input
    role="textbox" aria-label={language === 'zh' ? '消息' : 'Message'} aria-multiline="true"
    contentEditable suppressContentEditableWarning data-placeholder={placeholder}
    onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
    onPointerDown={event => restoreNativeEditorFocus(event.nativeEvent)}
    onInput={publish} onClick={select} onKeyUp={select} onKeyDown={keyDown}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; publish(); }}
    onPaste={event => {
      if (event.clipboardData.files.length) return;
      event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    }}
    onCopy={event => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', readPrompt(selection.getRangeAt(0).cloneContents()));
    }}
    onCut={event => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      event.preventDefault(); event.clipboardData.setData('text/plain', readPrompt(selection.getRangeAt(0).cloneContents()));
      document.execCommand('delete');
    }}
    onDrop={event => {
      if (event.dataTransfer.files.length || event.dataTransfer.types.includes('application/x-cardbush-quickload')) return;
      event.preventDefault(); document.execCommand('insertText', false, event.dataTransfer.getData('text/plain'));
    }}
  /> : <textarea ref={textarea} data-composer-input value={value} placeholder={placeholder} rows={2}
    aria-label={language === 'zh' ? '消息' : 'Message'}
    onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; }}
    onPointerDown={event => restoreNativeEditorFocus(event.nativeEvent)}
    onChange={event => { lastCaret.current = event.currentTarget.selectionStart; onChange(event.target.value, lastCaret.current); }}
    onClick={select} onKeyUp={select} onKeyDown={keyDown} />;
});

function readPrompt(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement) {
    if (node.dataset.pluginReference) return node.dataset.pluginReference;
    if (node.tagName === 'BR') return '\n';
  }
  return Array.from(node.childNodes).map((child, index) => {
    const block = child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName);
    return `${block && index ? '\n' : ''}${readPrompt(child)}`;
  }).join('');
}

function caretOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.focusNode)) return 0;
  const range = document.createRange(); range.selectNodeContents(root);
  range.setEnd(selection.focusNode!, selection.focusOffset);
  return readPrompt(range.cloneContents()).length;
}

function offsetBefore(root: HTMLElement, node: Node): number {
  const range = document.createRange(); range.selectNodeContents(root); range.setEndBefore(node);
  return readPrompt(range.cloneContents()).length;
}

function selectOffsets(root: HTMLElement, start: number, end: number): void {
  const locate = (offset: number): [Node, number] => {
    const walk = (node: Node): [Node, number] | undefined => {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (offset <= length) return [node, offset]; offset -= length; return;
      }
      if (node instanceof HTMLElement && node.dataset.pluginReference) {
        const length = node.dataset.pluginReference.length;
        if (offset <= length) return [node.parentNode!, Array.from(node.parentNode!.childNodes).indexOf(node) + (offset ? 1 : 0)];
        offset -= length; return;
      }
      for (const child of node.childNodes) { const found = walk(child); if (found) return found; }
    };
    return walk(root) ?? [root, root.childNodes.length];
  };
  const range = document.createRange(); range.setStart(...locate(start)); range.setEnd(...locate(end));
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
