import { uiText } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { SettingsCard } from '../settings/SettingsControls';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import './browser-settings.css';

type ChromeConnectorStatus = NonNullable<Window['cardbushDesktop']> extends infer Desktop
  ? Desktop extends { chromeConnectorStatus: () => Promise<infer Status> } ? Status : never
  : never;

export function BrowserConnectionSettings({ language, plugin, busy, onReplace, onPersist }: {
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  busy: boolean;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const [status, setStatus] = useState<ChromeConnectorStatus | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; id: string; browser: 'chrome' | 'edge' } | null>(null);
  const [browser, setBrowser] = useState<'chrome' | 'edge'>('chrome');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [pairingCopied, setPairingCopied] = useState(false);
  const [cleanupCopied, setCleanupCopied] = useState(false);
  const connector = window.cardbushDesktop;
  const mode = plugin.config.connectionMode === 'remote_debugging'
    ? 'remote_debugging'
    : 'connector';

  const refresh = useCallback(async () => {
    if (!connector?.chromeConnectorStatus) return;
    try {
      setStatus(await connector.chromeConnectorStatus());
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [connector]);

  useEffect(() => {
    void refresh();
    return connector?.onChromeConnectorStatus?.((next) => setStatus(next));
  }, [connector, refresh]);

  useEffect(() => {
    if (!status?.connectorEnabled || status.connections.some(connection => connection.id === pairing?.id)) setPairing(null);
  }, [status, pairing?.id]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const selectMode = (connectionMode: 'connector' | 'remote_debugging') => {
    const next = { ...plugin, config: { ...plugin.config, connectionMode } };
    onReplace(next);
    onPersist(next, uiText(language)('browserConnectionSettings.browserUseConnectionModeSaved'));
  };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setWorking(key);
    setError('');
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking('');
    }
  };

  return (
    <SettingsCard title={uiText(language)('browserConnectionSettings.browserConnection')}>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'connector'} disabled={busy} onChange={() => selectMode('connector')} />
          <span><strong>{uiText(language)('browserConnectionSettings.browser_use_windows')}</strong><small>{uiText(language)('browserConnectionSettings.enableThePluginInstallTheBrowserExtension')}</small></span>
      </label>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'remote_debugging'} disabled={busy} onChange={() => selectMode('remote_debugging')} />
        <span><strong>{uiText(language)('browserConnectionSettings.remoteDebuggingCompatibilityMode')}</strong><small>{uiText(language)('browserConnectionSettings.usesGoogleSChromeDevtoolsMcpFor')}</small></span>
      </label>
      {mode === 'connector' ? (
        <div className="chrome-connector-card">
          <div className="chrome-connector-heading">
            <span className={`chrome-connector-indicator ${status?.extensionConnected ? 'online' : status?.bridgeRunning ? 'waiting' : ''}`} />
            <div>
              <strong>{status?.lifecycleState === 'needs_repair'
                ? (uiText(language)('browserConnectionSettings.connectorNeedsAttention'))
                : !status?.connectorEnabled
                ? (uiText(language)('browserConnectionSettings.connectorDisabled'))
                : status?.extensionConnected
                ? (uiText(language)('browserConnectionSettings.browserConnected'))
                : status?.bridgeRunning
                  ? (uiText(language)('browserConnectionSettings.localBridgeReadyWaitingForExtension'))
                  : (uiText(language)('browserConnectionSettings.connectorNotReady'))}</strong>
              <small>{status?.extensionConnected
                ? `${status.activeTabTitle || (uiText(language)('browserConnectionSettings.currentTab'))} · ${status.controlledTabCount} ${uiText(language)('browserConnectionSettings.controlledTabs')}`
                : status?.lifecycleState === 'needs_repair'
                  ? (uiText(language)('browserConnectionSettings.aStartupFailureDoesNotInvalidateSaved'))
                : status?.portRecovery && status?.paired
                  ? (uiText(language)('browserConnectionSettings.theConnectionAddressWasRecoveredAutomaticallyWaiting'))
                : status?.paired
                  ? (uiText(language)('browserConnectionSettings.pairingIsSavedReconnectsAutomaticallyWhenThe'))
                    : (uiText(language)('browserConnectionSettings.waitingForTheBrowserExtensionConfirmOnce'))}</small>
            </div>
          </div>
          <div className="chrome-connector-actions">
            <button className="primary-button compact" type="button" disabled={working !== '' || !status || !connector?.setupChromeConnector || (!status.connectorEnabled && (!status.platformSupported || !status.nativeHostAvailable))} title={status?.setupMessage} onClick={() => void run('bridge', async () => status?.connectorEnabled && status.lifecycleState !== 'needs_repair' ? connector?.disableChromeConnector() : connector?.setupChromeConnector())}>
              {working === 'bridge' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.lifecycleState === 'needs_repair' ? (uiText(language)('browserConnectionSettings.retryConnection')) : status?.connectorEnabled ? (uiText(language)('browserConnectionSettings.disableConnector')) : (uiText(language)('browserConnectionSettings.enableConnector'))}
            </button>
            {status?.connectorEnabled && status.lifecycleState === 'needs_repair' && <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.disableChromeConnector}
              onClick={() => void run('disable', async () => connector?.disableChromeConnector())}>{uiText(language)('browserConnectionSettings.disableConnector')}</button>}
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.removeChromeConnector || !status?.platformSupported} onClick={() => void run('remove', async () => connector?.removeChromeConnector())}>{uiText(language)('browserConnectionSettings.removeConnectorConfiguration')}</button>
            <button className="primary-button compact" type="button" disabled={working !== '' || !connector?.openChromeConnectorInstaller} onClick={() => void run('extension', async () => connector?.openChromeConnectorInstaller())}>
              {working === 'extension' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.storeUrl ? (uiText(language)('browserConnectionSettings.installBrowserUseExtension')) : (uiText(language)('browserConnectionSettings.openExtensionFolder'))}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== ''} onClick={() => void refresh()}><RefreshCw size={14} />{uiText(language)('browserConnectionSettings.refresh')}</button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.copyChromeConnectorDiagnostics} onClick={() => void run('diagnostics', async () => { await connector?.copyChromeConnectorDiagnostics(); setDiagnosticsCopied(true); })}>{diagnosticsCopied ? (uiText(language)('browserConnectionSettings.diagnosticsCopied')) : (uiText(language)('browserConnectionSettings.copyDiagnostics'))}</button>
          </div>
          {status?.connectorEnabled && <>
            <details><summary>{uiText(language)('browserConnectionSettings.manualPairing')}</summary>
            <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.localFirstUseNeedsApprovalInThe')}</p>
            <div className="browser-pairing-controls">
              <SettingsDropdown label={uiText(language)('browserConnectionSettings.browserToPair')} value={browser}
                options={[{ value: 'chrome', label: 'Google Chrome' }, { value: 'edge', label: 'Microsoft Edge' }]}
                disabled={working !== ''} onChange={value => { setBrowser(value as 'chrome' | 'edge'); setPairing(null); }} />
              <input className="browser-connection-name" value={connectionLabel} maxLength={80} disabled={working !== ''}
                aria-label={uiText(language)('browserConnectionSettings.connectionNameOptional')}
                placeholder={uiText(language)('browserConnectionSettings.connectionNameOptionalEGWork')}
                onChange={event => setConnectionLabel(event.target.value)} />
              <button className="secondary-button compact" type="button" disabled={working !== '' || !status.bridgeRunning}
                onClick={() => void run('pair', async () => { setPairing(await connector!.pairChromeConnector({ browser, label: connectionLabel })); setPairingCopied(false); })}>
                {uiText(language)('browserConnectionSettings.generatePairingCode')}
              </button>
            </div>
            </details>
            {status.connections.length > 0 && <div className="browser-connections">
              {status.connections.map(connection => <div className="browser-connection-row" key={connection.id}>
                <div><strong>{connection.label}</strong><small>{connection.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} · {connection.connected ? (uiText(language)('browserConnectionSettings.connected')) : (uiText(language)('browserConnectionSettings.offline'))}</small></div>
                <button type="button" className="secondary-button compact" disabled={working !== '' || status.defaultConnectionId === connection.id}
                  onClick={() => void run('default', () => connector!.selectDefaultBrowserConnection(connection.id))}>
                  {status.defaultConnectionId === connection.id ? (uiText(language)('browserConnectionSettings.defaultBrowser')) : (uiText(language)('browserConnectionSettings.setDefault'))}
                </button>
                <button type="button" className="secondary-button compact" disabled={working !== ''}
                  aria-label={`${uiText(language)('browserConnectionSettings.removeConnection')} ${connection.label}`}
                  onClick={() => void run('revoke', () => connector!.revokeBrowserConnection(connection.id))}>{uiText(language)('appCenter.remove')}</button>
              </div>)}
              <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.theDefaultAppliesToSessionsWithoutA')}</p>
            </div>}
          </>}
          {pairing && <div className="chrome-connector-pairing">
            <label>{uiText(language)('browserConnectionSettings.pairingCodeValidFor5Minutes')}
              <input type="password" readOnly value={pairing.code} autoComplete="off" aria-label={uiText(language)('browserConnectionSettings.pairingCode')} />
            </label>
            <button className="secondary-button compact" type="button" onClick={() => void run('copy-pair', async () => {
              await navigator.clipboard.writeText(pairing.code); setPairingCopied(true);
            })}>{pairingCopied ? (uiText(language)('browserConnectionSettings.copied')) : (uiText(language)('browserConnectionSettings.copyPairingCode'))}</button>
            <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.pasteOnlyIntoCardbushBrowserUseIn', { value1: pairing.browser === 'edge' ? 'Edge' : 'Chrome' })}</p>
          </div>}
          <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.stopControlOnlyEndsCurrentControlDisabling')}</p>
          {status?.cleanupWarning && <div className="browser-setting-note">
            <p>{status.cleanupWarning === 'legacy_external_registration'
              ? (uiText(language)('browserConnectionSettings.aLegacyExternalRegistrationRemainsExitAll'))
              : status.cleanupWarning}</p>
            {status.cleanupWarning === 'legacy_external_registration' && <button className="secondary-button compact" type="button"
              onClick={() => void run('legacy-cleanup', async () => { await connector?.copyLegacyChromeConnectorCleanup(); setCleanupCopied(true); })}>
              {cleanupCopied ? (uiText(language)('browserConnectionSettings.copiedRunInPowershell')) : (uiText(language)('browserConnectionSettings.copyLegacyCleanupCommand'))}
            </button>}
          </div>}
          <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.theConnectorDoesNotReadBrowserPassword')}</p>
          {!status?.storeUrl && <p className="browser-setting-note">{uiText(language)('browserConnectionSettings.theExtensionShipsWithCardbushEnableDeveloper', { value1: browser === 'edge' ? 'edge://extensions' : 'chrome://extensions' })}</p>}
          {status?.setupMessage && <p className="browser-setting-note">{status.setupMessage}</p>}
          {status?.registrationConflict && <p className="settings-form-error">{status.registrationConflict}</p>}
          {status?.lastError && <p className="settings-form-error">{status.lastError}</p>}
          {error && <p className="settings-form-error">{error}</p>}
        </div>
      ) : (
        <p className="browser-setting-note">
          {uiText(language)('browserConnectionSettings.explicitlyEnableRemoteDebuggingAtChromeInspect')}
        </p>
      )}
    </SettingsCard>
  );
}


function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
