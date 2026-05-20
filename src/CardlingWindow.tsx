import {
  AlertCircle,
  Clock3,
  Code2,
  RotateCcw,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import type {
  AppLanguage,
  CardlingDesktopAction,
  CardlingDesktopState,
  CompanionStatus,
} from './types';

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
      document.documentElement.lang = payload.language === 'zh' ? 'zh-CN' : 'en';
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
    if (action !== 'settings') {
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
      className={`cardling-desktop theme-${state.theme} ${open ? 'open' : ''} ${transitioning ? 'transitioning' : ''}`}
      data-status={state.status}
      data-motion={state.settings.motion}
      style={style}
    >
      {open && <CardlingStatusPanel state={state} onAction={sendAction} />}
      <button
        className="cardling-badge cardling-desktop-badge"
        type="button"
        aria-label={state.language === 'zh' ? '卡布状态' : 'Kabu status'}
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
  const labels = companionLabels(state.status, state.language);
  const queueText =
    state.queuedMessageCount > 0
      ? state.language === 'zh'
        ? `${state.queuedMessageCount} 条`
        : `${state.queuedMessageCount}`
      : state.language === 'zh'
        ? '无'
        : 'None';
  const changeText =
    state.activeChangeFileCount > 0
      ? state.language === 'zh'
        ? `${state.activeChangeFileCount} 个文件`
        : `${state.activeChangeFileCount} file(s)`
      : state.language === 'zh'
        ? '无'
        : 'None';

  return (
    <section
      className="cardling-panel cardling-desktop-panel"
      aria-label={state.language === 'zh' ? '卡布状态' : 'Kabu status'}
    >
      <header>
        <strong>{state.language === 'zh' ? '卡布' : 'Kabu'}</strong>
        <span>{labels.detail}</span>
      </header>
      <div className="cardling-status-row">
        <span className="cardling-status-dot" />
        <b>{labels.title}</b>
      </div>
      <div className="cardling-panel-grid">
        <CompanionMetric
          icon={<Sparkles size={14} />}
          label={state.language === 'zh' ? '回复' : 'Reply'}
          value={
            state.sending
              ? state.language === 'zh'
                ? '运行中'
                : 'Running'
              : state.language === 'zh'
                ? '空闲'
                : 'Idle'
          }
        />
        <CompanionMetric
          icon={<Clock3 size={14} />}
          label={state.language === 'zh' ? '队列' : 'Queue'}
          value={queueText}
        />
        <CompanionMetric
          icon={<AlertCircle size={14} />}
          label={state.language === 'zh' ? '交互' : 'Input'}
          value={
            state.pendingInteraction
              ? state.language === 'zh'
                ? '等待'
                : 'Waiting'
              : state.language === 'zh'
                ? '无'
                : 'None'
          }
        />
        <CompanionMetric
          icon={<Code2 size={14} />}
          label={state.language === 'zh' ? '修改' : 'Changes'}
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
          <span>{state.language === 'zh' ? '查看 Diff' : 'View diff'}</span>
        </button>
        <button
          className="cardling-action"
          type="button"
          disabled={state.activeChangeCount === 0}
          onClick={() => onAction('revertChanges')}
        >
          <RotateCcw size={13} />
          <span>{state.language === 'zh' ? '撤回全部' : 'Revert all'}</span>
        </button>
        <button className="cardling-action" type="button" onClick={() => onAction('settings')}>
          <Settings size={13} />
          <span>{state.language === 'zh' ? '设置' : 'Settings'}</span>
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
  const labels: Record<CompanionStatus, { zh: [string, string]; en: [string, string] }> = {
    idle: {
      zh: ['准备就绪', '安静待命'],
      en: ['Ready', 'Standing by'],
    },
    thinking: {
      zh: ['正在思考', '正在生成回复'],
      en: ['Thinking', 'Generating a reply'],
    },
    tool: {
      zh: ['工具运行中', '正在处理任务'],
      en: ['Tool running', 'Working on the task'],
    },
    waiting: {
      zh: ['等待输入', '需要你的选择'],
      en: ['Waiting', 'Needs your input'],
    },
    queued: {
      zh: ['消息已排队', '稍后自动发送'],
      en: ['Queued', 'Will send next'],
    },
    complete: {
      zh: ['已完成', '这一轮处理结束'],
      en: ['Complete', 'This turn finished'],
    },
    error: {
      zh: ['需要关注', '出现了错误'],
      en: ['Needs attention', 'Something failed'],
    },
  };
  const [title, detail] = labels[status][language];
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
