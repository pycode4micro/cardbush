import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { shortcutDefinitions, type ShortcutId } from '../features/shortcuts/keyboardShortcuts';
import { useKeyboardShortcuts } from '../features/shortcuts/useKeyboardShortcuts';
import { observeExplicitInteraction } from '../shared/explicitInteraction';
import './global-tooltip.css';

/** One delegated tooltip host also upgrades existing native title controls. */
export function GlobalTooltip() {
  const shortcuts = useKeyboardShortcuts(), id = useId(), node = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string; shortcut: string } | null>(null);
  useEffect(() => {
    let active: HTMLElement | null = null, originalTitle: string | null = null, originalDescription: string | null = null, timer = 0;
    let dismissed: HTMLElement | null = null, dismissedTitle: string | null = null;
    const targetFor = (source: EventTarget | null) => source instanceof Element
      ? source.closest<HTMLElement>('[data-tooltip], [data-global-tooltip-active], [data-global-tooltip-dismissed], [title], button[aria-label], [aria-keyshortcuts]') : null;
    function releaseDismissed() {
      if (dismissed) {
        dismissed.removeAttribute('data-global-tooltip-dismissed');
        if (dismissedTitle !== null && !dismissed.hasAttribute('title')) dismissed.setAttribute('title', dismissedTitle);
      }
      dismissed = null; dismissedTitle = null;
    }
    function clear() {
      clearTimeout(timer); setTip(null);
      if (active) {
        active.removeAttribute('data-global-tooltip-active');
        if (originalTitle !== null && !active.hasAttribute('title')) active.setAttribute('title', originalTitle);
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
      dismissed = target; dismissedTitle = target.getAttribute('title');
      target.setAttribute('data-global-tooltip-dismissed', '');
      // Keep the native title suppressed too, until the pointer leaves.
      target.removeAttribute('title');
    }
    function show(source: EventTarget | null, keyboard = false) {
      const target = targetFor(source);
      if (target && target === dismissed) { clear(); return; }
      if (target === active) return;
      clear(); if (!target || target.closest('[inert]')) return;
      const text = target.dataset.tooltip || target.getAttribute('title') || target.getAttribute('aria-label'); if (!text) return;
      const shortcutId = target.dataset.shortcut || (target.getAttribute('aria-keyshortcuts')
        ? shortcutDefinitions.find(item => shortcuts.aria(item.id) === target.getAttribute('aria-keyshortcuts'))?.id : undefined);
      const shortcut = shortcutDefinitions.some(item => item.id === shortcutId) ? shortcuts.label(shortcutId as ShortcutId) : '';
      const label = target.getAttribute('aria-label') || target.textContent?.trim();
      // Collapse ordinary title+key duplication without dropping richer help text.
      const caption = shortcut && label && [shortcut, `${label} · ${shortcut}`, `${label} (${shortcut})`].includes(text) ? label : text;
      active = target; originalTitle = target.getAttribute('title'); originalDescription = target.getAttribute('aria-describedby');
      target.setAttribute('data-global-tooltip-active', '');
      target.removeAttribute('title');
      timer = window.setTimeout(() => {
        if (target !== active || !target.isConnected || !document.hasFocus() || document.hidden) return;
        target.setAttribute('aria-describedby', [originalDescription, id].filter(Boolean).join(' '));
        setTip({ anchor: target, text: caption, shortcut: shortcut && !caption.includes(shortcut) ? shortcut : '' });
      }, keyboard ? 100 : 380);
    }
    function leave(event: Event) {
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (active && event.target instanceof Node && active.contains(event.target) && !active.contains(related)) clear();
      if (event.type === 'pointerout' && dismissed && event.target instanceof Node && dismissed.contains(event.target) && !dismissed.contains(related)) releaseDismissed();
    }
    const keydown = (event: KeyboardEvent) => { if (['Escape', 'Enter', ' '].includes(event.key)) dismiss(event); };
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
    document.addEventListener('pointerout', leave); document.addEventListener('focusout', leave);
    document.addEventListener('keydown', keydown, true); document.addEventListener('click', dismiss, true);
    window.addEventListener('scroll', clear, true); window.addEventListener('resize', clear);
    return () => { stopInteraction(); clear(); releaseDismissed();
      document.removeEventListener('pointerout', leave); document.removeEventListener('focusout', leave); document.removeEventListener('keydown', keydown, true); document.removeEventListener('click', dismiss, true);
      window.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear); };
  }, [shortcuts, id]);
  useLayoutEffect(() => {
    const element = node.current; if (!tip || !element) return;
    element.showPopover?.();
    const anchor = tip.anchor.getBoundingClientRect(), rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, anchor.left + (anchor.width - rect.width) / 2))}px`;
    const above = anchor.top - rect.height - 8;
    element.style.top = `${Math.max(8, above >= 8 ? above : Math.min(innerHeight - rect.height - 8, anchor.bottom + 8))}px`;
    return () => { if (element.matches(':popover-open')) element.hidePopover?.(); };
  }, [tip]);
  return tip ? <div ref={node} id={id} popover="manual" role="tooltip" className="global-tooltip"><span>{tip.text}</span>{tip.shortcut && <kbd>{tip.shortcut}</kbd>}</div> : null;
}
