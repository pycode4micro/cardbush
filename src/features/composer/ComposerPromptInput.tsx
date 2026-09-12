import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { fileUrl } from '../../shared/localPaths';
import { restoreNativeEditorFocus } from '../../shared/editorFocus';
import { pluginPromptParts, type PluginPromptPart } from '../plugins/pluginPrompts';
import { promptReferenceParts, type PromptReference } from '../../shared/promptReferences';

type ComposerPromptPart = PluginPromptPart & { contextReference?: PromptReference };

export interface ComposerPromptInputHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

/** Keep native text editing until an explicit reference needs an inline token. */
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
  const parts: ComposerPromptPart[] = pluginPromptParts(value, plugins).flatMap(part => part.reference ? [part]
    : promptReferenceParts(part.text).map(contextPart => ({ text: contextPart.text, start: part.start + contextPart.start, contextReference: contextPart.reference })));
  const rich = parts.some(part => part.plugin || part.contextReference);
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
    const rendered = Array.from(node.querySelectorAll<HTMLElement>('[data-plugin-reference], [data-context-reference]')).map(chip => tokenText(chip));
    const expected = parts.filter(part => part.plugin || part.contextReference).map(part => part.text);
    if (readPrompt(node) === value && JSON.stringify(rendered) === JSON.stringify(expected)) return;
    const focused = document.activeElement === node;
    const caret = caretOffset(node);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (!part.plugin && !part.contextReference) { fragment.append(document.createTextNode(part.text)); continue; }
      const reference = part.contextReference;
      const title = part.plugin?.name || reference!.title;
      const chip = document.createElement('span');
      chip.className = part.plugin ? 'composer-plugin-token' : 'composer-context-token';
      chip.contentEditable = 'false';
      if (part.plugin) chip.dataset.pluginReference = part.text;
      else chip.dataset.contextReference = part.text;
      chip.title = part.plugin ? part.plugin.name : reference?.kind === 'browser' ? reference.url : title;
      const logo = part.plugin?.logoPath || part.plugin?.logoDarkPath;
      if (logo) {
        const image = document.createElement('img'); image.src = fileUrl(logo); image.alt = ''; image.draggable = false;
        image.onerror = () => image.replaceWith(referenceGlyph('plugin'));
        chip.append(image);
      } else {
        chip.append(referenceGlyph(reference?.kind || 'plugin'));
      }
      const label = document.createElement('span'); label.textContent = title; chip.append(label);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.tabIndex = -1; remove.textContent = '×';
      remove.setAttribute('aria-label', `${language === 'zh' ? part.plugin ? '移除插件引用' : '移除引用' : part.plugin ? 'Remove plugin reference' : 'Remove reference'} ${title}`);
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
    const token = tokenText(node);
    if (token) return token;
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
      if (node instanceof HTMLElement && tokenText(node)) {
        const length = tokenText(node)!.length;
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

function tokenText(node: HTMLElement) { return node.dataset.pluginReference || node.dataset.contextReference; }

function referenceGlyph(kind: PromptReference['kind'] | 'plugin'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', kind === 'browser'
    ? 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z'
    : kind === 'user-turn' ? 'M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 8h10M7 12h7'
    : 'M8 3h3a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 0 0-6V3Z');
  svg.append(path); return svg;
}
