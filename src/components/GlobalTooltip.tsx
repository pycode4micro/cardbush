import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { shortcutDefinitions, type ShortcutId } from '../features/shortcuts/keyboardShortcuts';
import { useKeyboardShortcuts } from '../features/shortcuts/useKeyboardShortcuts';
import { observeExplicitInteraction } from '../shared/explicitInteraction';
import { observeNativeTooltipTitles } from '../shared/nativeTooltipTitles';
import './global-tooltip.css';

/** Show explicitly authored help; accessible names alone are not tooltips. */
export function GlobalTooltip() {
  const shortcuts = useKeyboardShortcuts(), id = useId(), node = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ anchor: Element; text: string; shortcut: string } | null>(null);
  useEffect(() => {
    let active: Element | null = null, originalDescription: string | null = null, timer = 0, visible = false;
    let dismissed: Element | null = null;
    const targetFor = (source: EventTarget | null) => source instanceof Element
      ? source.closest('[data-tooltip], [data-global-tooltip-title], [data-global-tooltip-active], [data-global-tooltip-dismissed], button[aria-label], [aria-keyshortcuts]') : null;
    function releaseDismissed() {
      dismissed?.removeAttribute('data-global-tooltip-dismissed');
      dismissed = null;
    }
    function clear() {
      clearTimeout(timer); visible = false; setTip(null);
      if (active) {
        active.removeAttribute('data-global-tooltip-active');
        if (active.getAttribute('aria-describedby') === [originalDescription, id].filter(Boolean).join(' ')) {
          if (originalDescription === null) active.removeAttribute('aria-describedby'); else active.setAttribute('aria-describedby', originalDescription);
        }
      }
      active = null;
    }
    function dismiss(event: Event) {
      const target = targetFor(event.target);
      clear(); releaseDismissed();
      if (!target) return;
      dismissed = target;
      target.setAttribute('data-global-tooltip-dismissed', '');
    }
    function isTextEditor(element: EventTarget | null) {
      return element instanceof HTMLTextAreaElement
        || (element instanceof HTMLInputElement && /^(text|url|search|email|tel|password|number)$/.test(element.type))
        || (element instanceof HTMLElement && element.isContentEditable);
    }
    function content(target: Element) {
      // Editing already explains the field; hover and caret navigation must not
      // reopen help on its enclosing form or cover the text being entered.
      if (isTextEditor(document.activeElement) && target.contains(document.activeElement)) return null;
      // The open interactive popup owns its trigger's explanation until it closes.
      if (target.closest('[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]')) return null;
      const text = target.getAttribute('data-tooltip') || target.getAttribute('data-global-tooltip-title'); if (!text) return null;
      const shortcutId = target.getAttribute('data-shortcut') || (target.getAttribute('aria-keyshortcuts')
        ? shortcutDefinitions.find(item => shortcuts.aria(item.id) === target.getAttribute('aria-keyshortcuts'))?.id : undefined);
      const shortcut = shortcutDefinitions.some(item => item.id === shortcutId) ? shortcuts.label(shortcutId as ShortcutId) : '';
      const label = target.getAttribute('aria-label') || target.textContent?.trim();
      // Collapse ordinary title+key duplication without dropping richer help text.
      const caption = shortcut && label && [shortcut, `${label} · ${shortcut}`, `${label} (${shortcut})`].includes(text) ? label : text;
      return { anchor: target, text: caption, shortcut: shortcut && !caption.includes(shortcut) ? shortcut : '' };
    }
    function refresh() {
      if (dismissed && !dismissed.isConnected) releaseDismissed();
      if (!active) return;
      const next = active.isConnected && !active.closest('[inert]') ? content(active) : null;
      if (!next) { clear(); return; }
      if (visible) setTip(previous => previous?.anchor === next.anchor && previous.text === next.text && previous.shortcut === next.shortcut ? previous : next);
    }
    function show(source: EventTarget | null, keyboard = false) {
      const target = targetFor(source);
      if (target && target === dismissed) { clear(); return; }
      if (target === active) return;
      clear(); if (!target || target.closest('[inert]') || !content(target)) return;
      active = target; originalDescription = target.getAttribute('aria-describedby');
      target.setAttribute('data-global-tooltip-active', '');
      timer = window.setTimeout(() => {
        if (target !== active || !target.isConnected || !document.hasFocus() || document.hidden) return;
        target.setAttribute('aria-describedby', [originalDescription, id].filter(Boolean).join(' '));
        visible = true; refresh();
      }, keyboard ? 100 : 380);
    }
    const stopTitles = observeNativeTooltipTitles(refresh);
    function leave(event: Event) {
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (active && event.target instanceof Node && active.contains(event.target) && !active.contains(related)) clear();
      if (event.type === 'pointerout' && dismissed && event.target instanceof Node && dismissed.contains(event.target) && !dismissed.contains(related)) releaseDismissed();
    }
    const keydown = (event: KeyboardEvent) => { if (['Escape', 'Enter', ' '].includes(event.key)) dismiss(event); };
    const focusEditor = (event: FocusEvent) => { if (isTextEditor(event.target)) clear(); };
    const stopInteraction = observeExplicitInteraction({
      pointerMove: event => { if (!event.buttons) show(event.target); }, pointerDown: dismiss,
      reset: () => { clear(); releaseDismissed(); },
      focus: event => show(event.target, true),
      keyboard: event => {
        if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'F6'].includes(event.key)) {
          releaseDismissed(); show(document.activeElement, true);
        }
      },
    });
    document.addEventListener('pointerout', leave, true); document.addEventListener('focusout', leave, true);
    document.addEventListener('focusin', focusEditor, true);
    document.addEventListener('keydown', keydown, true); document.addEventListener('click', dismiss, true);
    window.addEventListener('scroll', clear, true); window.addEventListener('resize', clear);
    return () => { stopInteraction(); clear(); releaseDismissed();
      stopTitles();
      document.removeEventListener('pointerout', leave, true); document.removeEventListener('focusout', leave, true); document.removeEventListener('keydown', keydown, true); document.removeEventListener('click', dismiss, true);
      document.removeEventListener('focusin', focusEditor, true);
      window.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear); };
  }, [shortcuts, id]);
  useLayoutEffect(() => {
    const element = node.current; if (!tip || !element) return;
    if (!element.matches(':popover-open')) element.showPopover?.();
    const anchor = tip.anchor.getBoundingClientRect(), rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, anchor.left + (anchor.width - rect.width) / 2))}px`;
    const above = anchor.top - rect.height - 8;
    element.style.top = `${Math.max(8, above >= 8 ? above : Math.min(innerHeight - rect.height - 8, anchor.bottom + 8))}px`;
  }, [tip]);
  return tip ? <div ref={node} id={id} popover="manual" role="tooltip" className="global-tooltip"><span>{tip.text}</span>{tip.shortcut && <kbd>{tip.shortcut}</kbd>}</div> : null;
}
