import type { MessageKey } from './i18n';
import { uiText } from './i18n';
import {
  AlertCircle,
  ArrowUp,
  Clock3,
  Code2,
  ExternalLink,
  MessageSquare,
  RotateCcw,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import type {
  AppLanguage,
  CardlingDesktopAction,
  CardlingDesktopState,
  CompanionStatus,
} from './types';
import { themeClassNames } from './features/appearance/themeRuntime';

const defaultCardlingState: CardlingDesktopState = {
  enabled: true,
  language: 'zh',
  theme: 'dark',
  settings: {
    size: 'normal',
    opacity: 0.95,
    motion: 'full',
  },
  status: 'idle',
  sending: false,
  queuedMessageCount: 0,
  pendingInteraction: false,
  activeChangeCount: 0,
  activeChangeFileCount: 0,
  error: null,
  miniChat: {
    title: '',
    lastUser: '',
    lastAssistant: '',
  },
};

export function CardlingWindow() {
  const [state, setState] = useState<CardlingDesktopState>(defaultCardlingState);
  const [open, setOpen] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const openRef = useRef(false);
  const transitioningRef = useRef(false);
  const transitionTokenRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    nativeDragStarted: boolean;
    target: HTMLButtonElement;
  } | null>(null);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    transitioningRef.current = transitioning;
  }, [transitioning]);

  useEffect(() => {
    document.documentElement.dataset.cardlingWindow = 'true';
    document.body.classList.add('cardling-window-body');
    return () => {
      document.body.classList.remove('cardling-window-body');
      delete document.documentElement.dataset.cardlingWindow;
    };
  }, []);

  useEffect(() => {
    return window.cardbushDesktop?.onCardlingState?.((payload) => {
      setState(payload);
      document.documentElement.lang = payload.language;
    });
  }, []);

  useEffect(() => {
    return window.cardbushDesktop?.onCardlingCollapse?.(() => {
      void setExpanded(false);
    });
  }, []);

  useEffect(
    () => () => {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
      }
      void window.cardbushDesktop?.endCardlingDrag?.();
    },
    [],
  );

  const labels = companionLabels(state.status, state.language);
  const scale = companionSizeScale(state.settings.size);
  const style = useMemo(
    () =>
      ({
        '--cardling-scale': String(scale),
        '--cardling-opacity': String(state.settings.opacity),
      }) as CSSProperties,
    [scale, state.settings.opacity],
  );

  const sendAction = (action: CardlingDesktopAction) => {
    void window.cardbushDesktop?.cardlingAction?.(action);
    const actionType = typeof action === 'string' ? action : action.type;
    if (actionType === 'changes' || actionType === 'revertChanges' || actionType === 'openMain') {
      void setExpanded(false);
    }
  };

  const finishDrag = (pointerId: number | null, toggleIfClick: boolean) => {
    const drag = dragRef.current;
    if (!drag || (pointerId != null && drag.pointerId !== pointerId)) {
      return;
    }
    if (drag.target.hasPointerCapture(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = null;
    if (drag.nativeDragStarted) {
      void window.cardbushDesktop?.endCardlingDrag?.();
    }
    if (toggleIfClick && !drag.moved) {
      void setExpanded(!openRef.current);
    }
  };

  useEffect(() => {
    const finishIfStillDragging = () => {
      window.setTimeout(() => finishDrag(null, false), 0);
    };
    window.addEventListener('pointerup', finishIfStillDragging);
    window.addEventListener('mouseup', finishIfStillDragging);
    window.addEventListener('blur', finishIfStillDragging);
    return () => {
      window.removeEventListener('pointerup', finishIfStillDragging);
      window.removeEventListener('mouseup', finishIfStillDragging);
      window.removeEventListener('blur', finishIfStillDragging);
    };
  }, []);

  const finishTransition = (token: number) => {
    window.requestAnimationFrame(() => {
      if (token !== transitionTokenRef.current) {
        return;
      }
      transitioningRef.current = false;
      setTransitioning(false);
    });
  };

  const setExpanded = async (nextOpen: boolean) => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (nextOpen && openRef.current) {
      return;
    }
    if (!nextOpen && !openRef.current) {
      return;
    }
    const token = transitionTokenRef.current + 1;
    transitionTokenRef.current = token;
    transitioningRef.current = true;

    if (nextOpen) {
      openRef.current = true;
      flushSync(() => {
        setTransitioning(true);
        setOpen(true);
      });
      try {
        await window.cardbushDesktop?.setCardlingExpanded?.(true);
      } finally {
        finishTransition(token);
      }
      return;
    }

    openRef.current = false;
    flushSync(() => {
      setTransitioning(true);
      setOpen(false);
    });
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      void Promise.resolve(window.cardbushDesktop?.setCardlingExpanded?.(false)).finally(() => {
        if (token !== transitionTokenRef.current) {
          return;
        }
        openRef.current = false;
        finishTransition(token);
      });
    }, 40);
  };

  if (!state.enabled) {
    return null;
  }

  return (
    <main
      className={`cardling-desktop ${themeClassNames(state.theme)} ${open ? 'open' : ''} ${transitioning ? 'transitioning' : ''}`}
      data-status={state.status}
      data-motion={state.settings.motion}
      style={style}
    >
      {open && <CardlingStatusPanel state={state} onAction={sendAction} />}
      <button
        className="cardling-badge cardling-desktop-badge"
        type="button"
        aria-label={uiText(state.language)('cardlingWindow.kabuStatus')}
        title={labels.title}
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.screenX,
            startY: event.screenY,
            lastX: event.screenX,
            lastY: event.screenY,
            moved: false,
            nativeDragStarted: false,
            target: event.currentTarget,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = event.screenX - drag.lastX;
          const deltaY = event.screenY - drag.lastY;
          const totalDelta =
            Math.abs(event.screenX - drag.startX) + Math.abs(event.screenY - drag.startY);
          if (!drag.moved && totalDelta <= 6) {
            return;
          }
          if (!drag.moved) {
            drag.moved = true;
            drag.nativeDragStarted = true;
            void window.cardbushDesktop?.startCardlingDrag?.(event.screenX, event.screenY);
          }
          if (deltaX !== 0 || deltaY !== 0) {
            drag.lastX = event.screenX;
            drag.lastY = event.screenY;
          }
        }}
        onPointerUp={(event) => {
          finishDrag(event.pointerId, true);
        }}
        onPointerCancel={(event) => {
          finishDrag(event.pointerId, false);
        }}
        onLostPointerCapture={(event) => {
          window.setTimeout(() => finishDrag(event.pointerId, false), 0);
        }}
      >
        <span className="cardling-orbit" />
        <span className="cardling-card" aria-hidden="true">
          <span className="cardling-stack" />
          <span className="cardling-leaf" />
          <span className="cardling-eye left" />
          <span className="cardling-eye right" />
          <span className="cardling-wave" />
          <span className="cardling-cursor" />
          <span className="cardling-error-corner" />
          <span className="cardling-spark one" />
          <span className="cardling-spark two" />
        </span>
        {state.queuedMessageCount > 0 && (
          <span className="cardling-count">{state.queuedMessageCount}</span>
        )}
      </button>
    </main>
  );
}

function CardlingStatusPanel({
  state,
  onAction,
}: {
  state: CardlingDesktopState;
  onAction: (action: CardlingDesktopAction) => void;
}) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const labels = companionLabels(state.status, state.language);
  const miniTitle =
    state.miniChat.title ||
    (uiText(state.language)('cardlingWindow.lightChat'));
  const assistantPreview =
    state.miniChat.lastAssistant ||
    (uiText(state.language)('cardlingWindow.askKabuHereWithoutSwitchingBackTo'));

  const submitText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      onAction({ type: 'miniChatSend', text: trimmed });
      setDraft('');
      setNotice(
        uiText(state.language)('cardlingWindow.sentToTheCurrentSession'),
      );
    },
    [onAction, state.language],
  );

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      submitText(draft);
    },
    [draft, submitText],
  );

  const queueText =
    state.queuedMessageCount > 0
      ? uiText(state.language)('cardlingWindow.message', { value1: state.queuedMessageCount })
      : uiText(state.language)('cardlingWindow.none');
  const changeText =
    state.activeChangeFileCount > 0
      ? uiText(state.language)('cardlingWindow.fileS', { value1: state.activeChangeFileCount })
      : uiText(state.language)('cardlingWindow.none');

  return (
    <section
      className="cardling-panel cardling-desktop-panel"
      aria-label={uiText(state.language)('cardlingWindow.kabuStatus')}
    >
      <header>
        <strong>
          {uiText(state.language)('cardlingWindow.kabu')}
          <em>{uiText(state.language)('cardlingWindow.lab')}</em>
        </strong>
        <span>{miniTitle}</span>
      </header>
      <div className="cardling-status-row">
        <span className="cardling-status-dot" />
        <b>{labels.title}</b>
      </div>
      <section className="cardling-mini-chat">
        <div className="cardling-mini-answer">
          <MessageSquare size={13} />
          <p>{assistantPreview}</p>
        </div>
        {state.miniChat.lastUser && (
          <p className="cardling-mini-user">
            {uiText(state.language)('cardlingWindow.asked')}
            {state.miniChat.lastUser}
          </p>
        )}
        <form className="cardling-mini-form" onSubmit={submit}>
          <textarea
            value={draft}
            rows={2}
            placeholder={
              uiText(state.language)('cardlingWindow.askKabuWithoutSwitchingBack')
            }
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              if (notice) {
                setNotice('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button type="submit" disabled={!draft.trim()} title={uiText(state.language)('cardlingWindow.send')}>
            <ArrowUp size={14} />
          </button>
        </form>
        <div className="cardling-mini-actions">
          <button type="button" onClick={() => onAction('openMain')}>
            <ExternalLink size={13} />
            <span>{uiText(state.language)('cardlingWindow.openApp')}</span>
          </button>
        </div>
        {notice && <p className="cardling-mini-notice">{notice}</p>}
      </section>
      <div className="cardling-panel-grid">
        <CompanionMetric
          icon={<Sparkles size={14} />}
          label={uiText(state.language)('cardlingWindow.reply')}
          value={
            state.sending
              ? uiText(state.language)('cardlingWindow.running')
              : uiText(state.language)('cardlingWindow.idle')
          }
        />
        <CompanionMetric
          icon={<Clock3 size={14} />}
          label={uiText(state.language)('cardlingWindow.queue')}
          value={queueText}
        />
        <CompanionMetric
          icon={<AlertCircle size={14} />}
          label={uiText(state.language)('cardlingWindow.input')}
          value={
            state.pendingInteraction
              ? uiText(state.language)('cardlingWindow.waiting')
              : uiText(state.language)('cardlingWindow.none')
          }
        />
        <CompanionMetric
          icon={<Code2 size={14} />}
          label={uiText(state.language)('cardlingWindow.changes')}
          value={changeText}
        />
      </div>
      {state.error && <p className="cardling-error">{state.error}</p>}
      <div className="cardling-actions">
        <button
          className="cardling-action"
          type="button"
          disabled={state.activeChangeCount === 0}
          onClick={() => onAction('changes')}
        >
          <Code2 size={13} />
          <span>{uiText(state.language)('cardlingWindow.viewDiff')}</span>
        </button>
        <button
          className="cardling-action"
          type="button"
          disabled={state.activeChangeCount === 0}
          onClick={() => onAction('revertChanges')}
        >
          <RotateCcw size={13} />
          <span>{uiText(state.language)('cardlingWindow.revertAll')}</span>
        </button>
        <button className="cardling-action" type="button" onClick={() => onAction('settings')}>
          <Settings size={13} />
          <span>{uiText(state.language)('cardlingWindow.settings')}</span>
        </button>
      </div>
    </section>
  );
}

function CompanionMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="cardling-metric">
      {icon}
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function companionLabels(status: CompanionStatus, language: AppLanguage) {
  const labels: Record<CompanionStatus, [MessageKey, MessageKey]> = {
    idle: (['cardlingWindow.ready', 'cardlingWindow.standing_by'] as const),
    thinking: (['cardlingWindow.thinking', 'cardlingWindow.generating_a_reply'] as const),
    tool: (['cardlingWindow.tool_running', 'cardlingWindow.working_on_the_task'] as const),
    waiting: (['cardlingWindow.waiting_533f583', 'cardlingWindow.needs_your_input'] as const),
    queued: (['cardlingWindow.queued', 'cardlingWindow.will_send_next'] as const),
    complete: (['turnRuntimeDetails.complete', 'cardlingWindow.this_turn_finished'] as const),
    error: (['cardlingWindow.needs_attention', 'cardlingWindow.something_failed'] as const),
  };
  const [title, detail] = labels[status].map(key => uiText(language)(key));
  return { title, detail };
}

function companionSizeScale(size: CardlingDesktopState['settings']['size']) {
  if (size === 'compact') {
    return 0.86;
  }
  if (size === 'large') {
    return 1.16;
  }
  return 1;
}
