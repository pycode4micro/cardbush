import { uiText } from '../../i18n';
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
      <div className="loading-brand" aria-label={uiText(language)('windowSidebarToggle.cardbush')}>
        <img className="loading-logo-mark" src="./cardbush-logo.png" alt="" />
        <strong>{uiText(language)('windowSidebarToggle.cardbush')}</strong>
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
          ? uiText(language)('chatStatusViews.loadingConversation')
          : uiText(language)('chatStatusViews.connectingToTheRuntime')}
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
    ? uiText(language)('chatStatusViews.retrying')
    : actionState === 'failed'
      ? uiText(language)('chatStatusViews.retryFailed')
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
        aria-label={uiText(language)('chatStatusViews.dismissNotification')}
        title={uiText(language)('chatStatusViews.dismiss')}
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
    ? uiText(language)('chatStatusViews.attempt', { value1: update.attempt })
    : '';
  const remainingSeconds = Number.isFinite(retryAt) ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const retryDelay = update.state === 'retrying' && remainingSeconds > 0
    ? uiText(language)('chatStatusViews.retryingInS', { remainingSeconds })
    : '';
  const title = isFailed
    ? update.source === 'provider'
      ? uiText(language)('chatStatusViews.modelProviderRetryFailed')
      : uiText(language)('chatStatusViews.connectionRecoveryFailedCheckTheRuntimeOr')
    : isSyncing
      ? uiText(language)('chatStatusViews.connectedSynchronizingTheRunningTurn')
      : update.source === 'provider'
        ? uiText(language)('chatStatusViews.modelProviderIssueRetrying', { attempt })
        : uiText(language)('chatStatusViews.connectionInterruptedRecovering', { attempt });
  const retryStatus = update.state === 'retrying' && update.source === 'provider'
    ? retryDelay || (uiText(language)('chatStatusViews.requestingTheModelAgain'))
    : retryDelay;
  const keepTrying = update.state === 'retrying' && update.source === 'provider' && update.maxAttempts === null
    ? uiText(language)('chatStatusViews.willKeepRetryingUseStopToCancel')
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
