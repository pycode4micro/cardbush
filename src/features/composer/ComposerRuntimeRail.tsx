import { Clock3, CornerDownLeft, Edit3, GripVertical, LoaderCircle, Trash2, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useState, type Ref } from 'react';
import type { AppLanguage } from '../../types';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useQueueReorder } from './useQueueReorder';

type RuntimeQueuedMessage = { id: string; text: string; createdAt: string };
export type ComposerRuntimeRailHandle = { showQueue: () => void };

export function ComposerRuntimeRail({ ref, language, queuedMessageCount = 0, queuedMessagePreview = '', queuedMessages = [],
  queueLocked = false,
  onEditQueuedMessage, onGuideQueuedMessage, onRemoveQueuedMessage, onReorderQueuedMessage,
}: {
  ref?: Ref<ComposerRuntimeRailHandle>;
  language: AppLanguage;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  queuedMessages?: RuntimeQueuedMessage[];
  queueLocked?: boolean;
  onEditQueuedMessage?: (item: RuntimeQueuedMessage) => void;
  onGuideQueuedMessage?: (id: string) => Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
  onReorderQueuedMessage?: (id: string, targetId: string) => void;
}) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const panelPresence = useSoftPanelPresence(queueOpen, 180);
  const keyboardShortcuts = useKeyboardShortcuts();
  const queueDrag = useQueueReorder(queuedMessages, onReorderQueuedMessage, Boolean(guidingQueuedId) || !queueOpen);
  const firstQueuedMessage = queuedMessages[0] ?? null;
  const queuePreview = queuedMessagePreview.trim() || firstQueuedMessage?.text.trim() || '';
  useImperativeHandle(ref, () => ({ showQueue() { if (queuedMessageCount > 0) setQueueOpen(true); } }));
  useEffect(() => { if (queuedMessageCount <= 0) setQueueOpen(false); }, [queuedMessageCount]);
  async function guideQueuedMessage(id: string) {
    if (!onGuideQueuedMessage || guidingQueuedId) return;
    setGuidingQueuedId(id);
    try { await onGuideQueuedMessage(id); } finally { setGuidingQueuedId(''); }
  }
  if (queuedMessageCount <= 0) return null;
  return (
    <div className={`composer-runtime-rail ${panelPresence.mounted ? 'expanded' : ''} ${panelPresence.visible ? 'context-visible' : 'context-exiting'}`}
      data-queue-locked={queueLocked} onKeyDown={event => {
        if (!event.defaultPrevented && keyboardShortcuts.matches('guideNow', event) && firstQueuedMessage) {
          event.preventDefault(); event.stopPropagation(); void guideQueuedMessage(firstQueuedMessage.id);
        }
      }}>
      {panelPresence.mounted && (
        <section
          className="runtime-context-panel queue-context-panel"
          aria-label={language === 'zh' ? '排队消息' : 'Queued message'}
        >
          <header>
            <span>
              <Clock3 size={14} />
              <strong>{language === 'zh' ? `排队 ${queuedMessageCount}` : `${queuedMessageCount} queued`}</strong>
            </span>
            <button
              type="button"
              onClick={() => setQueueOpen(false)}
              aria-label={language === 'zh' ? '关闭排队详情' : 'Close queue details'}
            >
              <X size={14} />
            </button>
          </header>
          <div className="runtime-queue-detail">
            <div className="runtime-queue-hint">
              {queueLocked
                ? language === 'zh' ? '已锁定：回复结束后不会自动发送，仍可手动发送单条消息。' : 'Locked: messages stay queued after the reply. You can still send individual messages manually.'
                : language === 'zh' ? '当前回复完成后按顺序发送，按住消息拖动排序。' : 'Sends in order after the current reply. Hold and drag a message to reorder.'}
            </div>
            {queuedMessages.length > 0 ? (
              <div className="runtime-queue-list" ref={queueDrag.listRef} role="list" aria-label={language === 'zh' ? '待发送的提示词' : 'Queued prompts'}>
                {queuedMessages.map((item, index) => (
                  <article
                    className="runtime-queue-item"
                    data-queue-item-id={item.id}
                    data-reorderable={Boolean(onReorderQueuedMessage) && queuedMessages.length > 1 && !guidingQueuedId}
                    role="listitem"
                    key={item.id}
                    onPointerDown={(event) => queueDrag.onPointerDown(item.id, event)}
                    onPointerMove={queueDrag.onPointerMove}
                    onPointerUp={queueDrag.onPointerUp}
                    onPointerCancel={queueDrag.onPointerCancel}
                    onLostPointerCapture={queueDrag.onPointerCancel}
                  >
                    <button
                      className="runtime-queue-drag-handle"
                      type="button"
                      disabled={!onReorderQueuedMessage || queuedMessages.length < 2 || Boolean(guidingQueuedId)}
                      aria-label={language === 'zh'
                        ? `第 ${index + 1} 条，拖动或按上下方向键排序`
                        : `Queue item ${index + 1}. Drag or use the up and down arrows to reorder`}
                      title={language === 'zh' ? '拖动排序，也可用上下方向键' : 'Drag to reorder, or use the up and down arrows'}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                        event.preventDefault();
                        queueDrag.moveWithKeyboard(item.id, event.key === 'ArrowUp' ? -1 : 1);
                      }}
                    >
                      <GripVertical size={16} aria-hidden="true" />
                    </button>
                    <p className="runtime-queue-prompt" title={item.text}>{item.text}</p>
                    <div className="runtime-queue-actions">
                      <button
                        className="runtime-queue-guide"
                        title={[language === 'zh' ? '立即引导（快捷键发送队列第一条）' : 'Guide now (shortcut sends the first queued message)', keyboardShortcuts.label('guideNow')].filter(Boolean).join(' · ')}
                        type="button"
                        disabled={!onGuideQueuedMessage || Boolean(guidingQueuedId)}
                        onClick={() => void guideQueuedMessage(item.id)}
                        aria-label={language === 'zh' ? `将第 ${index + 1} 条用于引导` : `Use queue item ${index + 1} as guidance`}
                      >
                        {guidingQueuedId === item.id ? <LoaderCircle size={13} /> : <CornerDownLeft size={13} />}
                        <span>{language === 'zh' ? '引导' : 'Guide'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!onEditQueuedMessage || Boolean(guidingQueuedId)}
                        onClick={() => onEditQueuedMessage?.(item)}
                        aria-label={language === 'zh' ? `编辑第 ${index + 1} 条排队消息` : `Edit queue item ${index + 1}`}
                      >
                        <Edit3 size={13} />
                        <span>{language === 'zh' ? '编辑' : 'Edit'}</span>
                      </button>
                      <button
                        type="button"
                        disabled={!onRemoveQueuedMessage || Boolean(guidingQueuedId)}
                        onClick={() => onRemoveQueuedMessage?.(item.id)}
                        aria-label={language === 'zh' ? `删除第 ${index + 1} 条排队消息` : `Delete queue item ${index + 1}`}
                      >
                        <Trash2 size={13} />
                        <span>{language === 'zh' ? '删除' : 'Delete'}</span>
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p>{queuePreview || (language === 'zh' ? '当前回复完成后自动发送' : 'Sends after the current reply')}</p>
            )}
          </div>
        </section>
      )}
      <button
        className={`composer-runtime-screen queue ${queueOpen ? 'open' : ''}${firstQueuedMessage ? ' has-queue-actions' : ''}`}
        type="button" aria-expanded={queueOpen} onClick={() => setQueueOpen(value => !value)}
        title={language === 'zh' ? '查看引导队列' : 'View guidance queue'}>
        <span className="runtime-screen-viewport" aria-live="polite">
          <span className="runtime-screen-line queue">
            <Clock3 size={13} />
            <strong>{queueLocked ? language === 'zh' ? '已锁定' : 'Locked' : language === 'zh' ? `排队 ${queuedMessageCount}` : `${queuedMessageCount} queued`}</strong>
            <small>{queuePreview || (language === 'zh' ? '当前回复完成后自动发送' : 'Sends after the current reply')}</small>
          </span>
        </span>
      </button>
      {firstQueuedMessage && (
        <div
          className="runtime-screen-queue-actions"
          role="group"
          aria-label={language === 'zh' ? '排队消息操作' : 'Queued message actions'}
        >
          <button
            className="runtime-screen-queue-guide"
            aria-keyshortcuts={keyboardShortcuts.aria('guideNow')}
            type="button"
            disabled={!onGuideQueuedMessage || Boolean(guidingQueuedId)}
            aria-label={language === 'zh' ? '将首条排队消息用于引导' : 'Use first queued message as guidance'}
            title={[language === 'zh' ? '引导' : 'Guide', keyboardShortcuts.label('guideNow')].filter(Boolean).join(' · ')}
            onClick={() => void guideQueuedMessage(firstQueuedMessage.id)}
          >
            {guidingQueuedId === firstQueuedMessage.id
              ? <LoaderCircle size={13} />
              : <CornerDownLeft size={13} />}
          </button>
          <button
            type="button"
            disabled={!onEditQueuedMessage || Boolean(guidingQueuedId)}
            aria-label={language === 'zh' ? '编辑首条排队消息' : 'Edit first queued message'}
            title={language === 'zh' ? '编辑' : 'Edit'}
            onClick={() => onEditQueuedMessage?.(firstQueuedMessage)}
          >
            <Edit3 size={13} />
          </button>
          <button
            type="button"
            disabled={!onRemoveQueuedMessage || Boolean(guidingQueuedId)}
            aria-label={language === 'zh' ? '删除首条排队消息' : 'Delete first queued message'}
            title={language === 'zh' ? '删除' : 'Delete'}
            onClick={() => onRemoveQueuedMessage?.(firstQueuedMessage.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
