import { CornerDownLeft, GripVertical, LoaderCircle, LockKeyhole, Trash2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useQueueReorder } from './useQueueReorder';
import { QueueActionsMenu } from './QueueActionsMenu';

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
  const zh = language === 'zh';
  const keyboardShortcuts = useKeyboardShortcuts();
  const queueDrag = useQueueReorder(queuedMessages, onReorderQueuedMessage, Boolean(guidingQueuedId));
  const firstQueuedMessage = queuedMessages[0];
  if (queuedMessages.length === 0 && queuedMessageCount <= 0 && !queueLocked) return null;
  return (
    <section className="composer-runtime-rail" aria-label={zh ? '引导队列' : 'Guidance queue'}
      data-queue-locked={queueLocked} onKeyDown={event => {
        if (!event.defaultPrevented && keyboardShortcuts.matches('guideNow', event) && firstQueuedMessage) {
          event.preventDefault(); event.stopPropagation(); void onGuideQueuedMessage?.(firstQueuedMessage.id);
        }
      }}>
      {queueLocked && <div className="runtime-queue-lock">
        <LockKeyhole size={12} aria-hidden="true" />
        <span>{zh ? '已锁定 · 仅手动发送' : 'Locked · manual sending only'}</span>
        <button type="button" disabled={!onToggleQueueLock || queueLockPending} onClick={onToggleQueueLock}>
          {zh ? '解锁' : 'Unlock'}
        </button>
      </div>}
      {queuedMessages.length > 0 ? (
        <div className="runtime-queue-list" ref={queueDrag.listRef} role="list" aria-label={zh ? '待发送的引导' : 'Queued prompts'}>
          {queuedMessages.map((item, index) => (
            <article className="runtime-queue-item" data-queue-item-id={item.id} role="listitem" key={item.id}
              onPointerMove={queueDrag.onPointerMove} onPointerUp={queueDrag.onPointerUp}
              onPointerCancel={queueDrag.onPointerCancel} onLostPointerCapture={queueDrag.onPointerCancel}>
              <button type="button" className="runtime-queue-drag-handle"
                aria-label={zh ? `移动第 ${index + 1} 条引导` : `Move queue item ${index + 1}`}
                aria-keyshortcuts="ArrowUp ArrowDown"
                disabled={!onReorderQueuedMessage || queuedMessages.length < 2 || Boolean(guidingQueuedId)}
                onPointerDown={event => queueDrag.onPointerDown(item.id, event)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault(); event.stopPropagation();
                  queueDrag.moveWithKeyboard(item.id, event.key === 'ArrowUp' ? -1 : 1);
                }}><GripVertical size={14} aria-hidden="true" /></button>
              <p className="runtime-queue-prompt">{item.text}</p>
              <div className="runtime-queue-actions">
                <button className="runtime-queue-guide" type="button"
                  disabled={!onGuideQueuedMessage || Boolean(guidingQueuedId)}
                  onClick={() => void onGuideQueuedMessage?.(item.id)}
                  aria-label={zh ? `发送第 ${index + 1} 条引导` : `Send queue item ${index + 1}`}>
                  {guidingQueuedId === item.id ? <LoaderCircle size={13} /> : <CornerDownLeft size={13} />}
                  <span>{zh ? '引导' : 'Guide'}</span>
                </button>
                <button type="button" disabled={!onRemoveQueuedMessage || Boolean(guidingQueuedId)}
                  onClick={() => onRemoveQueuedMessage?.(item.id)}
                  aria-label={zh ? `删除第 ${index + 1} 条引导` : `Delete queue item ${index + 1}`}>
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
      ) : queuedMessageCount > 0 && <p className="runtime-queue-placeholder">{queuedMessagePreview || (zh ? '正在读取引导…' : 'Loading queued prompts…')}</p>}
    </section>
  );
}