import { CornerDownLeft, GripVertical, LoaderCircle, LockKeyhole, Trash2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useQueueReorder } from './useQueueReorder';
import { QueueActionsMenu } from './QueueActionsMenu';
import { QueuedPromptPreview } from './QueuedPromptPreview';

type RuntimeQueuedMessage = { id: string; text: string; createdAt: string };

export function ComposerRuntimeRail({ language, queuedMessageCount = 0, queuedMessagePreview = '', queuedMessages = [],
  queueLocked = false, queueLockPending = false, onToggleQueueLock, guidingQueuedId = '',
  onEditQueuedMessage, onGuideQueuedMessage, onRemoveQueuedMessage, onReorderQueuedMessage,
}: {
  language: AppLanguage;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: RuntimeQueuedMessage[];
  queueLocked?: boolean;
  queueLockPending?: boolean;
  onToggleQueueLock?: () => void;
  guidingQueuedId?: string;
  onEditQueuedMessage?: (item: RuntimeQueuedMessage) => void;
  onGuideQueuedMessage?: (id: string) => Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
  onReorderQueuedMessage?: (id: string, targetId: string) => void;
}) {
  const t = uiText(language);
  const keyboardShortcuts = useKeyboardShortcuts();
  const queueDrag = useQueueReorder(queuedMessages, onReorderQueuedMessage, Boolean(guidingQueuedId));
  const firstQueuedMessage = queuedMessages[0];
  if (queuedMessages.length === 0 && queuedMessageCount <= 0 && !queueLocked) return null;
  return (
    <section className="composer-runtime-rail" aria-label={t('queue.title')}
      data-queue-locked={queueLocked} onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (!event.defaultPrevented && keyboardShortcuts.matches('guideNow', event) && firstQueuedMessage) {
          event.preventDefault(); event.stopPropagation(); void onGuideQueuedMessage?.(firstQueuedMessage.id);
        }
      }}>
      {queueLocked && <div className="runtime-queue-lock">
        <LockKeyhole size={12} aria-hidden="true" />
        <span>{t('queue.lockedNotice')}</span>
        <button type="button" disabled={!onToggleQueueLock || queueLockPending} onClick={onToggleQueueLock}>
          {t('queue.unlock')}
        </button>
      </div>}
      {queuedMessages.length > 0 ? (
        <div className="runtime-queue-list" ref={queueDrag.listRef} role="list" aria-label={t('queue.prompts')}>
          {queuedMessages.map((item, index) => (
            <article className="runtime-queue-item" data-queue-item-id={item.id} role="listitem" key={item.id}
              onPointerMove={queueDrag.onPointerMove} onPointerUp={queueDrag.onPointerUp}
              onPointerCancel={queueDrag.onPointerCancel} onLostPointerCapture={queueDrag.onPointerCancel}>
              <button type="button" className="runtime-queue-drag-handle"
                aria-label={t('queue.move', { index: index + 1 })}
                aria-keyshortcuts="ArrowUp ArrowDown"
                disabled={!onReorderQueuedMessage || queuedMessages.length < 2 || Boolean(guidingQueuedId)}
                onPointerDown={event => queueDrag.onPointerDown(item.id, event)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault(); event.stopPropagation();
                  queueDrag.moveWithKeyboard(item.id, event.key === 'ArrowUp' ? -1 : 1);
                }}><GripVertical size={14} aria-hidden="true" /></button>
              <QueuedPromptPreview text={item.text} language={language} />
              <div className="runtime-queue-actions">
                <button className="runtime-queue-guide" type="button"
                  disabled={!onGuideQueuedMessage || Boolean(guidingQueuedId)}
                  onClick={() => void onGuideQueuedMessage?.(item.id)}
                  aria-label={t('queue.send', { index: index + 1 })}>
                  {guidingQueuedId === item.id ? <LoaderCircle size={13} /> : <CornerDownLeft size={13} />}
                  <span>{t('queue.guide')}</span>
                </button>
                <button type="button" disabled={!onRemoveQueuedMessage || Boolean(guidingQueuedId)}
                  onClick={() => onRemoveQueuedMessage?.(item.id)}
                  aria-label={t('queue.delete', { index: index + 1 })}>
                  <Trash2 size={13} />
                </button>
                <QueueActionsMenu language={language} locked={queueLocked} lockPending={queueLockPending}
                  onToggleLock={onToggleQueueLock} busy={Boolean(guidingQueuedId)}
                  onEdit={onEditQueuedMessage ? () => onEditQueuedMessage(item) : undefined}
                  onMoveUp={onReorderQueuedMessage && index > 0 ? () => queueDrag.moveWithKeyboard(item.id, -1) : undefined}
                  onMoveDown={onReorderQueuedMessage && index < queuedMessages.length - 1 ? () => queueDrag.moveWithKeyboard(item.id, 1) : undefined} />
              </div>
            </article>
          ))}
        </div>
      ) : queuedMessageCount > 0 && <p className="runtime-queue-placeholder">{queuedMessagePreview || t('queue.loading')}</p>}
    </section>
  );
}
