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
  const labels = language === 'zh' ? {
    pending: '配置已保存，正在后台连接或等待工具生效',
    connected: '已连接，工具列表已获取',
    failed: '连接未就绪，请查看 MCP 设置',
    superseded: '此配置已有后续更新，请查看 MCP 设置',
    unknown: '尚未确认连接状态',
  } : {
    pending: 'Configuration saved; connecting in the background or awaiting tool activation',
    connected: 'Connected; tool list received',
    failed: 'Connection not ready; check MCP settings',
    superseded: 'Configuration has changed; check MCP settings',
    unknown: 'Connection status not confirmed',
  };
  return <div className={`mcp-activation-status ${state}`} role="status">
    <span>MCP · {target.serverId}：{labels[state]}</span>
    {!isActive && state !== 'connected' && <button type="button" disabled={checking}
      onClick={() => setRefresh(value => value + 1)}>
      {language === 'zh' ? '检查连接' : 'Check connection'}
    </button>}
  </div>;
}
