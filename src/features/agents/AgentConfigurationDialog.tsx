import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import type { AgentConnection } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';

export function AgentConfigurationDialog({ connection, language, active, onEdit }: {
  connection: AgentConnection; language: AppLanguage; active: boolean; onEdit: () => void;
}) {
  const [dismissed, setDismissed] = useState('');
  const warnings = connection.configurationWarnings ?? [];
  const signature = connection.configurationError || warnings.length ? JSON.stringify([connection.configurationError ?? '', warnings]) : '';
  // Polling and navigating between chats must not repeat an acknowledged result.
  // A successful sync clears the acknowledgement so a later failure can surface.
  useEffect(() => { if (!signature) setDismissed(''); }, [signature]);
  const close = () => setDismissed(signature);
  const edit = () => { close(); onEdit(); };
  if (!active || !signature || dismissed === signature) return null;
  return <SettingsFormDialog className="agents-config-dialog" title={uiText(language)('agentConfigurationDialog.configurationSyncDetails')}
      description={connection.name} language={language} onCancel={close} onSubmit={edit}
      footer={<><button type="button" onClick={close}>{uiText(language)('common.close')}</button>
        <button type="submit" className="agents-primary">{uiText(language)('agentConfigurationDialog.connectionSettingsAndSync')}</button></>}>
      {connection.configurationError && <section className="agents-config-error"><h3>{uiText(language)('agentConfigurationDialog.syncFailed')}</h3><p>{connection.configurationError}</p></section>}
      {warnings.length > 0 && <section><h3>{uiText(language)('agentConfigurationDialog.syncNotices', { value1: warnings.length })}</h3>
        <ul className="agents-config-warning-list">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section>}
    </SettingsFormDialog>;
}
