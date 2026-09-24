import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';

/** Transport recovery is progress; only failures requiring intervention are alerts. */
export function AgentConnectionStatus({ connection, language, error, pending, retained, onRetry, onEdit }: {
  connection: AgentConnection; language: AppLanguage; error: string; pending: boolean; retained: boolean;
  onRetry: () => void; onEdit: () => void;
}) {
  const zh = language === 'zh';
  const reconnecting = connection.connectionState === 'reconnecting';
  const recovering = useRef(false);
  const [recovered, setRecovered] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (reconnecting) {
      recovering.current = true; setRecovered(false); setSlow(false);
      const timer = window.setTimeout(() => setSlow(true), 30_000);
      return () => window.clearTimeout(timer);
    }
    if (!connection.connected) { setRecovered(false); return; }
    if (!recovering.current) return;
    recovering.current = false; setRecovered(true); setSlow(false);
    const timer = window.setTimeout(() => setRecovered(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [reconnecting, connection.connected]);

  if (recovered && connection.connected) return <div className="agent-connection-status recovered" role="status">
    <Check size={16}/><span>{zh ? '连接已恢复' : 'Connection restored'}</span>
  </div>;
  if (connection.connected) return null;
  if (reconnecting) {
    const detail = connection.connectionError || error;
    return <div className="agent-connection-status" role="status">
      <LoaderCircle size={16} className="spin"/>
      <div className="agent-connection-status-copy">
        <strong>{zh ? '连接暂时中断，正在自动重连…' : 'Connection interrupted. Reconnecting…'}</strong>
        <span>{slow
          ? (zh ? '连接仍未恢复，可以检查网络或连接设置；后台会继续重试。' : 'Still reconnecting. Check your network or connection settings; retries will continue.')
          : retained
            ? (zh ? '当前会话和草稿已保留，恢复后自动同步。' : 'Your conversation and draft are retained and will sync after reconnection.')
            : (zh ? '恢复后会自动加载会话，无需重新添加连接。' : 'Conversations will load automatically once connected.')}</span>
        {detail && <details><summary>{zh ? '详细信息' : 'Details'}</summary><p>{detail.includes('Timed out while waiting for handshake')
          ? (zh ? 'SSH 连接建立超时，正在重新尝试。' : 'SSH connection setup timed out. Retrying.') : detail}</p></details>}
      </div>
      <div className="agent-connection-status-actions">
        <button disabled={pending} onClick={onRetry}>{zh ? '重试' : 'Retry'}</button>
        <button onClick={onEdit}>{zh ? '连接设置' : 'Connection settings'}</button>
      </div>
    </div>;
  }
  const failure = error || (connection.connectionState === 'disconnected' ? connection.connectionError : '');
  if (!failure || pending) return null;
  return <div className="agents-error" role="alert">{failure}
    <button onClick={onEdit}>{zh ? '连接设置' : 'Connection settings'}</button>
    <button onClick={onRetry}>{zh ? '重试' : 'Retry'}</button>
  </div>;
}
