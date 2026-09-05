import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AppLanguage, RuntimeConnectionUpdate } from '../../types';

export function BackendLoading({
  language,
  history = false,
}: {
  language: AppLanguage;
  history?: boolean;
}) {
  return (
    <div className="loading-view">
      <div className="loading-brand" aria-label="cardbush">
        <img className="loading-logo-mark" src="./cardbush-logo.png" alt="" />
        <strong>cardbush</strong>
      </div>
      <div className="loading-rhythm" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p>
        {history
          ? language === 'zh' ? '正在加载会话...' : 'Loading conversation...'
          : language === 'zh' ? '正在连接运行服务...' : 'Connecting to the runtime...'}
      </p>
    </div>
  );
}

export function RuntimeStatusBanner({
  language,
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  language: AppLanguage;
  tone: 'notice' | 'error';
  message: string;
  actionLabel?: string;
  onAction?: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [actionState, setActionState] = useState<'idle' | 'running' | 'failed'>('idle');
  const runAction = useCallback(async () => {
    if (!onAction || actionState === 'running') return;
    setActionState('running');
    try {
      await onAction();
      setActionState('idle');
    } catch {
      setActionState('failed');
    }
  }, [actionState, onAction]);
  const statusLabel = actionState === 'running'
    ? language === 'zh' ? '正在重试' : 'Retrying'
    : actionState === 'failed'
      ? language === 'zh' ? '重试失败' : 'Retry failed'
      : actionLabel;

  return (
    <div
      className={`runtime-status-banner ${tone === 'error' ? 'error-banner' : 'notice-banner'}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {tone === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
      <span className="runtime-status-message">{message}</span>
      {onAction && actionLabel && (
        <button
          className="runtime-status-action"
          type="button"
          disabled={actionState === 'running'}
          onClick={() => void runAction()}
        >
          {actionState === 'running' && <LoaderCircle size={14} />}
          {statusLabel}
        </button>
      )}
      <button
        className="runtime-status-dismiss"
        type="button"
        aria-label={language === 'zh' ? '关闭提示' : 'Dismiss notification'}
        title={language === 'zh' ? '关闭' : 'Dismiss'}
        onClick={onDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function ConversationConnectionNotice({
  language,
  update,
}: {
  language: AppLanguage;
  update: RuntimeConnectionUpdate;
}) {
  const isFailed = update.state === 'failed';
  const isSyncing = update.state === 'syncing';
  const [now, setNow] = useState(Date.now);
  const retryAt = Date.parse(update.createdAt) + (update.nextRetryMs ?? 0);
  useEffect(() => {
    setNow(Date.now());
    if (update.state !== 'retrying' || !Number.isFinite(retryAt) || retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt, update.state]);
  const attempt = update.attempt && update.attempt > 0
    ? language === 'zh'
      ? ` · 第 ${update.attempt} 次`
      : ` · attempt ${update.attempt}`
    : '';
  const remainingSeconds = Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const retryDelay = update.state === 'retrying' && remainingSeconds > 0
    ? language === 'zh'
      ? `${remainingSeconds} 秒后重试`
      : `Retrying in ${remainingSeconds}s`
    : '';
  const title = isFailed
    ? update.source === 'provider'
      ? language === 'zh'
        ? '模型服务重试失败'
        : 'Model provider retry failed.'
      : language === 'zh'
        ? '连接恢复失败，请检查 Runtime 或模型服务'
        : 'Connection recovery failed. Check the Runtime or model provider.'
    : isSyncing
      ? language === 'zh'
        ? '连接已建立，正在同步运行状态'
        : 'Connected. Synchronizing the running turn.'
      : update.source === 'provider'
        ? language === 'zh'
          ? `模型服务异常，正在重试${attempt}`
          : `Model provider issue. Retrying${attempt}`
        : language === 'zh'
          ? `连接异常，正在恢复${attempt}`
          : `Connection interrupted. Recovering${attempt}`;
  const retryStatus = update.state === 'retrying' && update.source === 'provider'
    ? retryDelay || (language === 'zh' ? '正在重新请求模型' : 'Requesting the model again')
    : retryDelay;
  const keepTrying = update.state === 'retrying' && update.source === 'provider' && update.maxAttempts === null
    ? language === 'zh' ? '将持续重试，可点击停止' : 'Will keep retrying; use Stop to cancel'
    : '';
  const detail = isFailed || isSyncing
    ? update.message || update.reason || ''
    : [retryStatus, update.message || update.reason, keepTrying].filter(Boolean).join(' · ');

  return (
    <div
      className={`conversation-connection-notice ${isFailed ? 'failed' : 'working'}`}
      role={isFailed ? 'alert' : 'status'}
      aria-live={isFailed ? 'assertive' : 'polite'}
    >
      {isFailed ? <AlertCircle size={16} /> : <LoaderCircle size={16} />}
      <div className="conversation-connection-copy">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}
