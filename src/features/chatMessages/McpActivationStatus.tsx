import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import type { McpSnapshotResult } from '@cardbush/bush-protocol';
import { createDesktopRuntimeSession } from '../../runtime-client/ElectronRuntimeSession';
import type { AppLanguage } from '../../types';
import { mcpActivationState, type McpActivation } from './mcpActivation';

/** Observation only: never reconfigure a server or keep a model Turn alive. */
export function McpActivationStatus({ target, isActive, language }: {
  target: McpActivation; isActive: boolean; language: AppLanguage;
}) {
  const [snapshot, setSnapshot] = useState<McpSnapshotResult | null>(target.initial);
  const [refresh, setRefresh] = useState(0);
  const [checking, setChecking] = useState(false);
  const state = mcpActivationState(target, snapshot);
  useEffect(() => {
    setSnapshot(target.initial);
    if (isActive) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runtime: ReturnType<typeof createDesktopRuntimeSession> | undefined;
    const controller = new AbortController();
    const delays = [1000, 3000, 6000];
    let attempt = 0;
    const check = async () => {
      setChecking(true);
      try {
        runtime ??= createDesktopRuntimeSession();
        const timeout = setTimeout(() => controller.abort(), 5000);
        let current: McpSnapshotResult | null;
        try { current = await runtime.client.getMcpSnapshot(controller.signal); }
        finally { clearTimeout(timeout); }
        if (disposed) return;
        setSnapshot(current);
        if (mcpActivationState(target, current) === 'pending' && attempt < delays.length) {
          timer = setTimeout(() => void check(), delays[attempt++]);
        }
      } catch {
        if (!disposed) setSnapshot(null);
      } finally {
        if (!disposed) setChecking(false);
      }
    };
    void check();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); runtime?.dispose(); };
  }, [isActive, target.serverId, target.snapshotId, target.revision, refresh]);
  const labels = ({ pending: uiText(language)('mcpActivationStatus.configurationSavedConnectingInTheBackgroundOr'), connected: uiText(language)('mcpActivationStatus.connectedToolListReceived'), failed: uiText(language)('mcpActivationStatus.connectionNotReadyCheckMcpSettings'), superseded: uiText(language)('mcpActivationStatus.configurationHasChangedCheckMcpSettings'), unknown: uiText(language)('mcpActivationStatus.connectionStatusNotConfirmed') });
  return <div className={`mcp-activation-status ${state}`} role="status">
    <span>{uiText(language)('mcpActivationStatus.mcp')}{target.serverId}：{labels[state]}</span>
    {!isActive && state !== 'connected' && <button type="button" disabled={checking}
      onClick={() => setRefresh(value => value + 1)}>
      {uiText(language)('mcpActivationStatus.checkConnection')}
    </button>}
  </div>;
}
