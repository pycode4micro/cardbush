import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Copy, Quote, Reply, SmilePlus, X } from 'lucide-react';
import { ASSISTANT_REACTIONS, type AssistantReaction, type ConversationEntry } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import './assistantMessageActions.css';

const reactionKeys = ['heart', 'up', 'down', 'important', 'laugh', 'done', 'celebrate', 'thanks', 'think', 'watch', 'launch', 'surprise'] as const;
export const reactionName = (language: string, reaction: AssistantReaction) => uiText(language)(`assistantMessage.reaction.${reactionKeys[ASSISTANT_REACTIONS.indexOf(reaction)]}`);
export function assistantQuoteText(entry: ConversationEntry | undefined, language: string, excerpt?: string) {
  return excerpt || entry?.content || (entry?.attachments?.length
    ? new Intl.ListFormat(language).format(entry.attachments.map(file => file.name))
    : uiText(language)('assistantMessage.referenceUnavailable'));
}

export type AssistantMessageMenuTarget = { entry: ConversationEntry; x: number; y: number; selection: string; trigger: HTMLElement; disabled: boolean };
export function AssistantMessageMenu({ target, language, reaction, pending, onClose, onReply, onCopy, onReact }: {
  target: AssistantMessageMenuTarget; language: string; reaction?: AssistantReaction; pending: boolean;
  onClose(): void; onReply(excerpt?: string): void; onCopy(): void; onReact(reaction: AssistantReaction): void;
}) {
  const t = uiText(language), menu = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false), [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    node.showPopover();
    const place = () => {
      const box = node.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(target.x, innerWidth - box.width - 8)), top: Math.max(8, Math.min(target.y, innerHeight - box.height - 8)) });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(node);
    return () => observer.disconnect();
  }, [target]);
  const positioned = Boolean(position);
  useLayoutEffect(() => {
    if (positioned) (menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)[data-menu-reply]')
      ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
  }, [target, positioned]);
  useEffect(() => {
    const close = () => onClose();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close(); target.trigger.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true); window.addEventListener('resize', close); window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close);
    };
  }, [onClose, target]);
  const emoji = (item: AssistantReaction) => <button key={item} type="button" role="menuitemradio" aria-checked={reaction === item}
    disabled={pending || target.disabled} title={reactionName(language, item)} aria-label={t('assistantMessage.reactWith', { reaction: reactionName(language, item) })}
    onClick={() => onReact(item)}>{item}</button>;
  return <div ref={menu} className="assistant-message-menu" popover="manual" role="menu" aria-label={t('assistantMessage.menu')}
    data-positioned={Boolean(position)} style={{ '--message-menu-left': `${position?.left ?? target.x}px`, '--message-menu-top': `${position?.top ?? target.y}px` } as CSSProperties}
    onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (backward ? -1 : 1) + items.length) % items.length;
      event.preventDefault(); items[index]?.focus();
    }}>
    <div className="assistant-menu-reactions" role="group" aria-label={t('assistantMessage.reactions')}>
      {ASSISTANT_REACTIONS.slice(0, 6).map(emoji)}
      <button type="button" role="menuitem" className="assistant-more-reactions" aria-label={t('assistantMessage.moreReactions')} title={t('assistantMessage.moreReactions')}
        aria-expanded={more} onClick={() => setMore(value => !value)}><SmilePlus/></button>
    </div>
    {more && <div className="assistant-menu-reactions assistant-extra-reactions" role="group" aria-label={t('assistantMessage.moreReactions')}>{ASSISTANT_REACTIONS.slice(6).map(emoji)}</div>}
    <button type="button" role="menuitem" data-menu-reply disabled={target.disabled} onClick={() => onReply()}><Reply/><span>{t('assistantMessage.reply')}</span></button>
    <button type="button" role="menuitem" disabled={target.disabled} onClick={() => onReply(target.selection.slice(0, 4000) || undefined)}><Quote/><span>{t(target.selection ? 'assistantMessage.quoteSelection' : 'assistantMessage.quote')}</span></button>
    <button type="button" role="menuitem" onClick={onCopy}><Copy/><span>{t(target.selection ? 'assistantMessage.copySelection' : 'messageBubble.copy')}</span></button>
  </div>;
}

export function AssistantQuote({ source, excerpt, language, assistantName, onJump, onCancel }: {
  source?: ConversationEntry; excerpt?: string; language: string; assistantName: string; onJump(): void; onCancel?(): void;
}) {
  const t = uiText(language), name = source?.role === 'user' ? t('assistantMessage.you') : assistantName;
  return <div className={`assistant-message-quote${onCancel ? ' is-draft' : ''}`}>
    <button type="button" className="assistant-quote-link" onClick={onJump} disabled={!source} title={t('assistantMessage.jumpToMessage')}>
      <Quote aria-hidden="true"/><span><strong>{t('assistantMessage.quoteFrom', { name })}</strong><span>{assistantQuoteText(source, language, excerpt)}</span></span>
    </button>
    {onCancel && <button className="assistant-quote-cancel" type="button" onClick={onCancel} title={t('assistantMessage.cancelQuote')} aria-label={t('assistantMessage.cancelQuote')}><X/></button>}
  </div>;
}
