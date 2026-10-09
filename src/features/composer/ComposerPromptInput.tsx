import { forwardRef, useContext, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { AppLanguage, CardbushAppPlugin, SkillSummary } from '../../types';
import { fileUrl } from '../../shared/localPaths';
import { focusEditor, observeEditorFocus, restoreNativeEditorFocus } from '../../shared/editorFocus';
import { pluginPromptParts, type PluginPromptPart } from '../plugins/pluginPrompts';
import { promptReferenceParts, type PromptReference } from '../../shared/promptReferences';
import { openPromptReference } from './PromptReferenceLink';
import { CONVERSATION_DRAG_TYPE } from '../chat/ConversationExtraction';
import { skillPromptParts, type SkillLinkReference } from '../skills/skillReferences';
import { ConversationHostContext } from '../conversationHost';
import { ComposerReferenceContext } from './ComposerReferenceContext';

type ComposerPromptPart = PluginPromptPart & { contextReference?: PromptReference; skillReference?: SkillLinkReference; skill?: SkillSummary };

const emptySkills: SkillSummary[] = [];
const isReference = (part: ComposerPromptPart) => Boolean(part.plugin || part.contextReference || part.skillReference);
const referenceTitle = (part: ComposerPromptPart) => part.plugin?.name || part.skill?.displayName || part.skillReference?.title || part.contextReference?.title || '';

export interface ComposerPromptInputHandle {
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

/** Keep native text editing until an explicit reference needs an inline token. */
export const ComposerPromptInput = forwardRef<ComposerPromptInputHandle, {
  value: string;
  plugins: CardbushAppPlugin[];
  skills?: SkillSummary[];
  language: AppLanguage;
  autoFocus?: boolean;
  readOnly?: boolean;
  richReferences?: boolean | 'applications';
  ariaLabel?: string;
  placeholder: string;
  onChange(value: string, caret: number): void;
  onSelectionChange(caret: number): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}>(function ComposerPromptInput({ value, plugins, skills = emptySkills, language, autoFocus, readOnly = false, richReferences = true, ariaLabel, placeholder, onChange, onSelectionChange, onKeyDown }, ref) {
  const host = useContext(ConversationHostContext);
  const { sessionId } = useContext(ComposerReferenceContext);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const previousInput = editor.current ?? textarea.current;
  const hadInputFocus = Boolean(previousInput && document.activeElement === previousInput);
  const lastCaret = useRef(value.length);
  const removedSelection = useRef<{ value: string; caret: number } | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const parsedParts = skillPromptParts(value, skills).flatMap<ComposerPromptPart>(skillPart => skillPart.skillReference ? [skillPart]
    : pluginPromptParts(skillPart.text, plugins).flatMap<ComposerPromptPart>(part => part.reference ? [{ ...part, start: skillPart.start + part.start }]
      : promptReferenceParts(part.text).map(contextPart => ({ text: contextPart.text, start: skillPart.start + part.start + contextPart.start, contextReference: contextPart.reference }))));
  // Remote application references have no local file resolver or launch side effects.
  const parts = richReferences === 'applications' ? parsedParts.map(part => ['application', 'team'].includes(part.contextReference?.kind ?? '') ? part : { text: part.text, start: part.start }) : parsedParts;
  const rich = Boolean(richReferences) && parts.some(isReference);
  useImperativeHandle(ref, () => ({
    focus: () => focusEditor(rich ? editor.current : textarea.current),
    setSelectionRange: (start, end) => {
      lastCaret.current = end;
      if (rich && editor.current) selectOffsets(editor.current, start, end);
      else textarea.current?.setSelectionRange(start, end);
    },
  }), [rich]);

  const removeReference = (node: HTMLElement, chip: HTMLElement) => {
    const start = offsetBefore(node, chip);
    const current = readPrompt(node, true);
    lastCaret.current = start;
    const next = current.slice(0, start) + current.slice(start + tokenText(chip)!.length);
    removedSelection.current = { value: next, caret: start };
    change.current(next, start);
  };

  useLayoutEffect(() => {
    const node = editor.current;
    if (!node || composing.current) return;
    const rendered = Array.from(node.querySelectorAll<HTMLElement>('[data-plugin-reference], [data-context-reference], [data-skill-reference]')).map(chip => [tokenText(chip), chip.querySelector('span')?.textContent]);
    const expected = parts.filter(isReference).map(part => [part.text, referenceTitle(part)]);
    if (readPrompt(node) === value && JSON.stringify(rendered) === JSON.stringify(expected)) return;
    const focused = document.activeElement === node;
    const caret = caretOffset(node);
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (!isReference(part)) { fragment.append(document.createTextNode(part.text)); continue; }
      const reference = part.contextReference;
      const title = referenceTitle(part);
      const chip = document.createElement('span');
      chip.className = part.plugin ? 'composer-plugin-token' : part.skillReference ? 'composer-context-token composer-skill-token' : 'composer-context-token';
      chip.contentEditable = 'false';
      if (part.plugin) chip.dataset.pluginReference = part.text;
      else if (part.skillReference) chip.dataset.skillReference = part.text;
      else chip.dataset.contextReference = part.text;
      chip.title = part.skillReference?.path || (part.plugin ? part.plugin.name : reference?.kind === 'browser' ? reference.url : title);
      if (reference?.kind === 'team') {
        chip.title = `Team · ${title}`;
        chip.classList.add('composer-team-token');
        chip.tabIndex = 0;
        chip.setAttribute('role', 'link');
        chip.setAttribute('aria-label', `${language === 'zh' ? '查看 Team' : 'View team'} ${title}`);
      }
      const logo = part.plugin?.logoPath || part.plugin?.logoDarkPath || part.skill?.logoPath || part.skill?.logoDarkPath;
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
      remove.setAttribute('aria-label', `${language === 'zh' ? part.plugin ? '移除插件引用' : part.skillReference ? '移除技能引用' : '移除引用' : part.plugin ? 'Remove plugin reference' : part.skillReference ? 'Remove skill reference' : 'Remove reference'} ${title}`);
      remove.onmousedown = event => event.preventDefault();
      remove.onclick = () => removeReference(node, chip);
      chip.append(remove); fragment.append(chip);
    }
    // A text node after a terminal chip gives the caret a valid insertion position.
    fragment.append(document.createTextNode(''));
    // Chromium needs a terminal line box to keep typing after an authored
    // newline; without it native insertion can jump before that newline.
    if (value.endsWith('\n')) {
      const placeholder = document.createElement('br');
      placeholder.dataset.composerPlaceholder = '';
      fragment.append(placeholder);
    }
    node.replaceChildren(fragment);
    if (focused) selectOffsets(node, caret, caret);
  });

  useLayoutEffect(() => {
    composing.current = false;
    const node = editor.current ?? textarea.current;
    if (node) return observeEditorFocus(node);
  }, [rich]);

  useLayoutEffect(() => {
    if (autoFocus) focusEditor(editor.current ?? textarea.current);
  }, [autoFocus]);

  useLayoutEffect(() => {
    const node = editor.current ?? textarea.current;
    const removed = removedSelection.current;
    removedSelection.current = null;
    // React removes the old editor before this effect; its blur cannot tell us
    // whether the user was typing. Capture that fact before replacing the node.
    // Apply removals in this commit, so a delayed frame cannot move a newer caret.
    const caret = removed?.value === value ? removed.caret
      : previousInput !== node && hadInputFocus && (document.activeElement === document.body || document.activeElement === node) ? lastCaret.current : undefined;
    if (caret === undefined) return;
    focusEditor(node);
    if (editor.current) selectOffsets(editor.current, caret, caret);
    else textarea.current?.setSelectionRange(caret, caret);
  });

  const publish = () => {
    if (editor.current && !composing.current) {
      lastCaret.current = caretOffset(editor.current);
      onChange(readPrompt(editor.current, true), lastCaret.current);
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
    const token = (event.target as Element).closest<HTMLElement>('.composer-team-token');
    if (token && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation();
      const reference = promptReferenceParts(token.dataset.contextReference ?? '')[0]?.reference;
      if (reference) void openPromptReference(reference, host, sessionId);
      return;
    }
    onKeyDown(event);
    const node = editor.current;
    const selection = window.getSelection();
    if (rich && node && !readOnly && !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
      (event.key === 'Backspace' || event.key === 'Delete') && selection?.isCollapsed && node.contains(selection.focusNode)) {
      const caret = caretOffset(node);
      const chip = Array.from(node.querySelectorAll<HTMLElement>('[data-plugin-reference], [data-context-reference], [data-skill-reference]'))
        .find(chip => offsetBefore(node, chip) + (event.key === 'Backspace' ? tokenText(chip)!.length : 0) === caret);
      // An atomic chip at the edge of contentEditable has no text to delete.
      // Remove it through the same path as × instead of relying on a filler BR.
      if (chip) { event.preventDefault(); removeReference(node, chip); return; }
    }
    if (rich && !event.defaultPrevented && event.key === 'Enter' && event.shiftKey) {
      event.preventDefault(); document.execCommand('insertText', false, '\n');
    }
  };
  return rich ? <div ref={editor} className="composer-prompt-editor" data-composer-input
    role="textbox" aria-label={ariaLabel ?? (language === 'zh' ? '消息' : 'Message')} aria-multiline="true" aria-readonly={readOnly}
    contentEditable={!readOnly} suppressContentEditableWarning data-placeholder={placeholder}
    onBlur={() => { composing.current = false; }}
    onPointerDown={event => restoreNativeEditorFocus(event.nativeEvent, event.currentTarget)}
    onInput={event => {
      // An interrupted IME session may never emit compositionend. The next
      // committed input is authoritative and must not stay blocked forever.
      if (event.nativeEvent instanceof InputEvent) composing.current = event.nativeEvent.isComposing;
      publish();
    }} onClick={event => {
      select();
      const token = (event.target as Element).closest<HTMLElement>('[data-context-reference]');
      const reference = token && promptReferenceParts(token.dataset.contextReference ?? '')[0]?.reference;
      if ((reference?.kind === 'conversation-extract' || reference?.kind === 'team') && !(event.target as Element).closest('button')) {
        event.preventDefault(); void openPromptReference(reference, host, sessionId);
      }
    }} onKeyUp={select} onKeyDown={keyDown}
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
      if (event.dataTransfer.files.length || event.dataTransfer.types.includes('application/x-cardbush-quickload') || event.dataTransfer.types.includes(CONVERSATION_DRAG_TYPE)) return;
      event.preventDefault(); document.execCommand('insertText', false, event.dataTransfer.getData('text/plain'));
    }}
  /> : <textarea ref={textarea} data-composer-input value={value} placeholder={placeholder} rows={2} readOnly={readOnly}
    aria-label={ariaLabel ?? (language === 'zh' ? '消息' : 'Message')}
    onPointerDown={event => restoreNativeEditorFocus(event.nativeEvent, event.currentTarget)}
    onChange={event => { lastCaret.current = event.currentTarget.selectionStart; onChange(event.target.value, lastCaret.current); }}
    onClick={select} onKeyUp={select} onKeyDown={keyDown} />;
});

function readPrompt(node: Node, nativeEditing = false): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLElement) {
    if (node.hasAttribute('data-composer-placeholder')) return '';
    const token = tokenText(node);
    if (token) return token;
    if (node.tagName === 'BR') return '\n';
  }
  const children = Array.from(node.childNodes);
  // Chromium leaves a terminal BR to hold the caret after native deletion or
  // a line break. It is layout scaffolding, not an additional authored line.
  // Normalize only live input; partial copy/selection ranges keep their breaks.
  // The layout effect then replaces native markup with canonical text nodes.
  const last = nativeEditing && node instanceof HTMLElement && /^(DIV|P)$/.test(node.tagName)
    ? children.filter(child => child.nodeType !== Node.TEXT_NODE || Boolean(child.textContent)).at(-1) : undefined;
  const placeholder = last instanceof HTMLBRElement ? last : undefined;
  return children.map((child, index) => {
    if (child === placeholder) return '';
    const block = child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName);
    return `${block && index ? '\n' : ''}${readPrompt(child, nativeEditing)}`;
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

function tokenText(node: HTMLElement) { return node.dataset.pluginReference || node.dataset.contextReference || node.dataset.skillReference; }

function referenceGlyph(kind: PromptReference['kind'] | 'plugin'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', kind === 'browser'
    ? 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4 4 4 14 0 18-4-4-4-14 0-18Z'
    : kind === 'application' ? 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z'
    : kind === 'team' ? 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'
    : kind === 'user-turn' || kind === 'conversation-extract' ? 'M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 8h10M7 12h7'
    : 'M8 3h3a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 0 0-6V3Z');
  svg.append(path); return svg;
}
