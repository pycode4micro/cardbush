import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';

/** Transport recovery is progress; only failures requiring intervention are alerts. */
export function AgentConnectionStatus({ connection, language, error, pending, retained, onRetry, onEdit }: {
  connection: AgentConnection; language: AppLanguage; error: string; pending: boolean; retained: boolean;
  onRetry: () => void; onEdit: () => void;
}) {

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
    <Check size={16}/><span>{uiText(language)('agentConnectionStatus.connectionRestored')}</span>
  </div>;
  if (connection.connected) return null;
  if (reconnecting) {
    const detail = connection.connectionError || error;
    return <div className="agent-connection-status" role="status">
      <LoaderCircle size={16} className="spin"/>
      <div className="agent-connection-status-copy">
        <strong>{uiText(language)('agentConnectionStatus.connectionInterruptedReconnecting')}</strong>
        <span>{slow
          ? (uiText(language)('agentConnectionStatus.stillReconnectingCheckYourNetworkOrConnection'))
          : retained
            ? (uiText(language)('agentConnectionStatus.yourConversationAndDraftAreRetainedAnd'))
            : (uiText(language)('agentConnectionStatus.conversationsWillLoadAutomaticallyOnceConnected'))}</span>
        {detail && <details><summary>{uiText(language)('agentConnectionStatus.details')}</summary><p>{detail.includes('Timed out while waiting for handshake')
          ? (uiText(language)('agentConnectionStatus.sshConnectionSetupTimedOutRetrying')) : detail}</p></details>}
      </div>
      <div className="agent-connection-status-actions">
        <button disabled={pending} onClick={onRetry}>{uiText(language)('common.retry')}</button>
        <button onClick={onEdit}>{uiText(language)('agentConnectionForm.connectionSettings')}</button>
      </div>
    </div>;
  }
  const failure = error || (connection.connectionState === 'disconnected' ? connection.connectionError : '');
  if (!failure || pending) return null;
  return <div className="agents-error" role="alert">{failure}
    <button onClick={onEdit}>{uiText(language)('agentConnectionForm.connectionSettings')}</button>
    <button onClick={onRetry}>{uiText(language)('common.retry')}</button>
  </div>;
}
