import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { SandboxSetupStatus } from '../../../electron/sandboxTypes';
import type { AppLanguage } from '../../types';
import { SettingsCard, SettingsSwitch } from './SettingsControls';
import { useSettingsHost } from './SettingsHostContext';

export function SandboxSettingsPanel({ language }: { language: AppLanguage }) {
  const host = useSettingsHost();
  const [status, setStatus] = useState<SandboxSetupStatus>();
  const [busy, setBusy] = useState<'check' | 'install' | 'update' | ''>('check');
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined); setError(''); setBusy('check');
    void host.fetchSandboxSetup().then(value => { if (current === generation.current) setStatus(value); }, error => {
      if (current === generation.current) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current === generation.current) setBusy(''); });
    return () => { generation.current++; };
  }, [host]);
  async function act(action: 'check' | 'install' | 'update', enabled?: boolean) {
    if (busy) return;
    const current = generation.current;
    setBusy(action); setError('');
    try {
      const value = await (action === 'check' ? host.fetchSandboxSetup() : action === 'install' ? host.installSandbox() : host.updateSandbox(enabled!));
      if (current === generation.current) setStatus(value);
    } catch (error) {
      if (current === generation.current) {
        setError(error instanceof Error ? error.message : String(error));
        // A package may have installed even if the capability check failed.
        try { const value = await host.fetchSandboxSetup(); if (current === generation.current) setStatus(value); } catch { /* Keep the original failure. */ }
      }
    } finally { if (current === generation.current) setBusy(''); }
  }
  const label = !status ? (error ? uiText(language)('sandboxSettingsPanel.environmentCheckFailed') : uiText(language)('sandboxSettingsPanel.checkingEnvironment'))
    : status.state === 'ready' ? (status.enabled ? uiText(language)('sandboxSettingsPanel.installedOn') : uiText(language)('sandboxSettingsPanel.installedOff'))
    : status.state === 'missing' ? (uiText(language)('sandboxSettingsPanel.notInstalled'))
    : status.state === 'unsupported' ? (uiText(language)('sandboxSettingsPanel.notSupportedOnThisSystem'))
    : (uiText(language)('sandboxSettingsPanel.installedUnavailable'));
  return <SettingsCard title={uiText(language)('sandboxSettingsPanel.commandSandbox')}
    subtitle={uiText(language)('sandboxSettingsPanel.enabledAfterInstallationWithYourPreferenceSaved')}>
    <div className="settings-sandbox-status" role="status"><strong>{label}</strong></div>
    {status?.installed && <SettingsSwitch title={uiText(language)('sandboxSettingsPanel.enableSandbox')} checked={status.enabled}
      subtitle={status.managed ? (uiText(language)('sandboxSettingsPanel.managedByTheHostAdministrator'))
        : (uiText(language)('sandboxSettingsPanel.appliesToTheNextCommandRunningCommands'))}
      disabled={Boolean(busy) || status.managed || (!status.enabled && status.state !== 'ready')} onChange={enabled => void act('update', enabled)}/>}
    {status?.managed && !status.installed && <p>{uiText(language)('sandboxSettingsPanel.managedByTheHostAdministrator')}</p>}
    {status?.state === 'missing' && !status.canInstall && !status.managed && <p>{status.platform === 'linux'
      ? (uiText(language)('sandboxSettingsPanel.noSupportedInstallerWasDetectedInstallationIs'))
      : (uiText(language)('sandboxSettingsPanel.updateOrReinstallCardbushOnThisHost'))}</p>}
    {status?.state === 'blocked' && <p>{uiText(language)('sandboxSettingsPanel.theComponentDidNotPassTheEnvironment')}</p>}
    <div className="settings-sandbox-actions">
      {!status?.installed && <button className="primary-button" disabled={Boolean(busy) || !status?.canInstall} onClick={() => void act('install')}>
        {busy === 'install' ? (uiText(language)('pluginMarketplacePanel.installing')) : (uiText(language)('sandboxSettingsPanel.installSandbox'))}</button>}
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void act('check')}>{busy === 'check' ? (uiText(language)('sandboxSettingsPanel.checking')) : (uiText(language)('sandboxSettingsPanel.checkAgain'))}</button>
    </div>
    {status?.canInstall && <p className="settings-muted">{uiText(language)('sandboxSettingsPanel.componentsAreDownloadedOnlyAfterYouClick')}</p>}
    {error && <p role="alert" className="settings-inline-error">{error}</p>}
    {(status?.detail || status?.manualCommand) && <details className="settings-sandbox-details"><summary>{uiText(language)('sandboxSettingsPanel.environmentDetails')}</summary>
      {status.detail && <p>{status.detail}</p>}
      {status.manualCommand && <><p>{uiText(language)('sandboxSettingsPanel.ifThisHostCannotShowSystemAuthorization')}</p><code>{status.manualCommand}</code>
        <button className="secondary-button" onClick={() => void navigator.clipboard.writeText(status.manualCommand!).catch(error => setError(String(error)))}>{uiText(language)('sandboxSettingsPanel.copyInstallationCommand')}</button></>}
    </details>}
  </SettingsCard>;
}
