import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { shortcutDefinitions, type ShortcutId } from '../features/shortcuts/keyboardShortcuts';
import { useKeyboardShortcuts } from '../features/shortcuts/useKeyboardShortcuts';
import './global-tooltip.css';

/** One delegated tooltip host also upgrades existing native title controls. */
export function GlobalTooltip() {
  const shortcuts = useKeyboardShortcuts(), id = useId(), node = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ anchor: HTMLElement; text: string; shortcut: string } | null>(null);
  useEffect(() => {
    let active: HTMLElement | null = null, originalTitle: string | null = null, originalDescription: string | null = null, timer = 0;
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
    function show(event: Event) {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip], [data-global-tooltip-active], [title], button[aria-label], [aria-keyshortcuts]') : null;
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
        if (target !== active || !target.isConnected) return;
        target.setAttribute('aria-describedby', [originalDescription, id].filter(Boolean).join(' '));
        setTip({ anchor: target, text: caption, shortcut: shortcut && !caption.includes(shortcut) ? shortcut : '' });
      }, event.type === 'focusin' ? 100 : 380);
    }
    function leave(event: Event) { if (active && event.target instanceof Node && active.contains(event.target) && !active.contains((event as MouseEvent).relatedTarget as Node | null)) clear(); }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    document.addEventListener('pointerover', show); document.addEventListener('focusin', show);
    document.addEventListener('pointerout', leave); document.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', clear, true); document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', clear, true); window.addEventListener('resize', clear); window.addEventListener('blur', clear);
    return () => { clear(); document.removeEventListener('pointerover', show); document.removeEventListener('focusin', show);
      document.removeEventListener('pointerout', leave); document.removeEventListener('focusout', leave); document.removeEventListener('pointerdown', clear, true); document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', clear, true); window.removeEventListener('resize', clear); window.removeEventListener('blur', clear); };
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
