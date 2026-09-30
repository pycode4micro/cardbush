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
    onPersist(next, language === 'zh' ? 'Browser Use 连接方式已保存' : 'Browser Use connection mode saved');
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
    <SettingsCard title={language === 'zh' ? '浏览器连接' : 'Browser connection'}>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'connector'} disabled={busy} onChange={() => selectMode('connector')} />
        <span><strong>Browser Use · Windows 11</strong><small>{language === 'zh' ? 'CardBush 自有连接器，连接 Chrome 或 Edge 并使用对应浏览器的登录状态。默认关闭，仅操作你授权的页面。' : 'CardBush’s own connector for Chrome or Edge, using that browser’s sign-in. Off by default; only authorized pages can be controlled.'}</small></span>
      </label>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'remote_debugging'} disabled={busy} onChange={() => selectMode('remote_debugging')} />
        <span><strong>{language === 'zh' ? '远程调试兼容模式' : 'Remote debugging compatibility mode'}</strong><small>{language === 'zh' ? '使用 Google 的 Chrome DevTools MCP，仅供开发者连接已主动开启远程调试的 Chrome，不创建临时资料。' : 'Uses Google’s Chrome DevTools MCP for advanced development with an opted-in remote-debugging Chrome. Does not create a temporary profile.'}</small></span>
      </label>
      {mode === 'connector' ? (
        <div className="chrome-connector-card">
          <div className="chrome-connector-heading">
            <span className={`chrome-connector-indicator ${status?.extensionConnected ? 'online' : status?.bridgeRunning ? 'waiting' : ''}`} />
            <div>
              <strong>{status?.lifecycleState === 'needs_repair'
                ? (language === 'zh' ? '连接器需要处理' : 'Connector needs attention')
                : !status?.connectorEnabled
                ? (language === 'zh' ? '连接器已关闭' : 'Connector disabled')
                : status?.extensionConnected
                ? (language === 'zh' ? '浏览器已连接' : 'Browser connected')
                : status?.bridgeRunning
                  ? (language === 'zh' ? '本地桥已就绪，等待扩展' : 'Local bridge ready; waiting for extension')
                  : (language === 'zh' ? '连接器未就绪' : 'Connector not ready')}</strong>
              <small>{status?.extensionConnected
                ? `${status.activeTabTitle || (language === 'zh' ? '当前标签页' : 'Current tab')} · ${status.controlledTabCount} ${language === 'zh' ? '个受控标签页' : 'controlled tabs'}`
                : status?.paired
                  ? (language === 'zh' ? '配对已保存。开启连接器和浏览器后会自动重连，也可打开扩展立即重试，无需重新生成码或授权。' : 'Pairing is saved. Reconnects automatically when the connector and browser are open; open the extension to retry now. No new code or permission is needed.')
                  : (language === 'zh' ? '首次使用时选择浏览器并生成配对码，粘贴到对应浏览器的 Browser Use 扩展中。页面授权单独选择。' : 'For first use, choose a browser and paste its pairing code into the Browser Use extension. Page access is authorized separately.')}</small>
            </div>
          </div>
          <div className="chrome-connector-actions">
            <button className="primary-button compact" type="button" disabled={working !== '' || !status || !connector?.setupChromeConnector || (!status.connectorEnabled && (!status.platformSupported || !status.nativeHostAvailable))} title={status?.setupMessage} onClick={() => void run('bridge', async () => status?.connectorEnabled ? connector?.disableChromeConnector() : connector?.setupChromeConnector())}>
              {working === 'bridge' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.connectorEnabled ? (language === 'zh' ? '关闭连接器' : 'Disable connector') : (language === 'zh' ? '开启连接器' : 'Enable connector')}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.removeChromeConnector || !status?.platformSupported} onClick={() => void run('remove', async () => connector?.removeChromeConnector())}>{language === 'zh' ? '移除连接器配置' : 'Remove connector configuration'}</button>
            <button className="primary-button compact" type="button" disabled={working !== '' || !connector?.openChromeConnectorInstaller} onClick={() => void run('extension', async () => connector?.openChromeConnectorInstaller())}>
              {working === 'extension' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.storeUrl ? (language === 'zh' ? '安装 Browser Use 扩展' : 'Install Browser Use extension') : (language === 'zh' ? '打开扩展目录' : 'Open extension folder')}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== ''} onClick={() => void refresh()}><RefreshCw size={14} />{language === 'zh' ? '刷新状态' : 'Refresh'}</button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.copyChromeConnectorDiagnostics} onClick={() => void run('diagnostics', async () => { await connector?.copyChromeConnectorDiagnostics(); setDiagnosticsCopied(true); })}>{diagnosticsCopied ? (language === 'zh' ? '已复制诊断信息' : 'Diagnostics copied') : (language === 'zh' ? '复制诊断信息' : 'Copy diagnostics')}</button>
          </div>
          {status?.connectorEnabled && <>
            <div className="browser-pairing-controls">
              <SettingsDropdown label={language === 'zh' ? '要配对的浏览器' : 'Browser to pair'} value={browser}
                options={[{ value: 'chrome', label: 'Google Chrome' }, { value: 'edge', label: 'Microsoft Edge' }]}
                disabled={working !== ''} onChange={value => { setBrowser(value as 'chrome' | 'edge'); setPairing(null); }} />
              <input className="browser-connection-name" value={connectionLabel} maxLength={80} disabled={working !== ''}
                aria-label={language === 'zh' ? '连接名称（可选）' : 'Connection name (optional)'}
                placeholder={language === 'zh' ? '连接名称（可选，如工作账号）' : 'Connection name (optional, e.g. Work)'}
                onChange={event => setConnectionLabel(event.target.value)} />
              <button className="secondary-button compact" type="button" disabled={working !== '' || !status.bridgeRunning}
                onClick={() => void run('pair', async () => { setPairing(await connector!.pairChromeConnector({ browser, label: connectionLabel })); setPairingCopied(false); })}>
                {language === 'zh' ? '生成配对码' : 'Generate pairing code'}
              </button>
            </div>
            {status.connections.length > 0 && <div className="browser-connections">
              {status.connections.map(connection => <div className="browser-connection-row" key={connection.id}>
                <div><strong>{connection.label}</strong><small>{connection.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} · {connection.connected ? (language === 'zh' ? '已连接' : 'Connected') : (language === 'zh' ? '未连接' : 'Offline')}</small></div>
                <button type="button" className="secondary-button compact" disabled={working !== '' || status.defaultConnectionId === connection.id}
                  onClick={() => void run('default', () => connector!.selectDefaultBrowserConnection(connection.id))}>
                  {status.defaultConnectionId === connection.id ? (language === 'zh' ? '默认浏览器' : 'Default browser') : (language === 'zh' ? '设为默认' : 'Set default')}
                </button>
                <button type="button" className="secondary-button compact" disabled={working !== ''}
                  aria-label={`${language === 'zh' ? '移除连接' : 'Remove connection'} ${connection.label}`}
                  onClick={() => void run('revoke', () => connector!.revokeBrowserConnection(connection.id))}>{language === 'zh' ? '移除' : 'Remove'}</button>
              </div>)}
              <p className="browser-setting-note">{language === 'zh' ? '默认浏览器用于尚未选择浏览器的会话。已绑定会话保持原连接；你也可以让 Agent 明确切换浏览器。断线不会自动切换。' : 'The default applies to sessions without a browser selection. Existing sessions keep their connection; ask the agent to switch explicitly. Disconnection never switches browsers automatically.'}</p>
            </div>}
          </>}
          {pairing && <div className="chrome-connector-pairing">
            <label>{language === 'zh' ? '配对码（5 分钟内有效）' : 'Pairing code (valid for 5 minutes)'}
              <input type="password" readOnly value={pairing.code} autoComplete="off" aria-label={language === 'zh' ? '配对码' : 'Pairing code'} />
            </label>
            <button className="secondary-button compact" type="button" onClick={() => void run('copy-pair', async () => {
              await navigator.clipboard.writeText(pairing.code); setPairingCopied(true);
            })}>{pairingCopied ? (language === 'zh' ? '已复制' : 'Copied') : (language === 'zh' ? '复制配对码' : 'Copy pairing code')}</button>
            <p className="browser-setting-note">{language === 'zh' ? `仅粘贴到 ${pairing.browser === 'edge' ? 'Edge' : 'Chrome'} 的 CardBush Browser Use 扩展。其他连接会继续保留；更换同一配置的配对后可移除旧记录。` : `Paste only into CardBush Browser Use in ${pairing.browser === 'edge' ? 'Edge' : 'Chrome'}. Other connections are retained; remove old records after re-pairing a profile.`}</p>
          </div>}
          <p className="browser-setting-note">{language === 'zh'
            ? '“停止控制”只结束当前控制。关闭连接器保留配对，再次开启后自动重连。移除单个连接只撤销该配对；移除连接器配置撤销全部配对和会话绑定。已保存的网站授权可在扩展中单独撤销。'
            : 'Stop control only ends current control. Disabling the connector preserves pairings for reconnection when re-enabled. Removing a connection revokes that pairing; removing connector configuration clears all pairings and session bindings. Saved site permissions can be revoked separately in the extension.'}</p>
          {status?.cleanupWarning && <div className="browser-setting-note">
            <p>{status.cleanupWarning === 'legacy_external_registration'
              ? (language === 'zh' ? '检测到旧版的外部注册项。请退出所有 CardBush 窗口和后台进程，在 Windows 终端的 PowerShell 中执行清理命令。新版本不会再创建此注册项。' : 'A legacy external registration remains. Exit all CardBush windows and background processes and run the cleanup command in Windows Terminal’s PowerShell. This version does not recreate it.')
              : status.cleanupWarning}</p>
            {status.cleanupWarning === 'legacy_external_registration' && <button className="secondary-button compact" type="button"
              onClick={() => void run('legacy-cleanup', async () => { await connector?.copyLegacyChromeConnectorCleanup(); setCleanupCopied(true); })}>
              {cleanupCopied ? (language === 'zh' ? '已复制，请在 PowerShell 中执行' : 'Copied; run in PowerShell') : (language === 'zh' ? '复制旧版清理命令' : 'Copy legacy cleanup command')}
            </button>}
          </div>}
          <p className="browser-setting-note">{language === 'zh'
            ? '连接器不直接读取浏览器的密码或 Cookie 数据库。授权页面的文字、截图和操作结果可能发送给你配置的模型服务。'
            : 'The connector does not read browser password or cookie databases directly. Authorized page text, screenshots and action results may be sent to your configured model provider.'}</p>
          {!status?.storeUrl && <p className="browser-setting-note">{language === 'zh' ? `扩展已随 CardBush 提供。打开扩展目录后，在 ${browser === 'edge' ? 'edge://extensions' : 'chrome://extensions'} 开启开发者模式，选择“加载解压缩的扩展”，选中该目录。Chrome 和 Edge 使用同一份扩展，分别配对。` : `The extension ships with CardBush. Enable developer mode at ${browser === 'edge' ? 'edge://extensions' : 'chrome://extensions'} and choose “Load unpacked”. Chrome and Edge use the same extension, paired separately.`}</p>}
          {status?.setupMessage && <p className="browser-setting-note">{status.setupMessage}</p>}
          {status?.registrationConflict && <p className="settings-form-error">{status.registrationConflict}</p>}
          {status?.lastError && <p className="settings-form-error">{status.lastError}</p>}
          {error && <p className="settings-form-error">{error}</p>}
        </div>
      ) : (
        <p className="browser-setting-note">
          {language === 'zh'
            ? '在 Chrome 144+ 的 chrome://inspect/#remote-debugging 中主动开启远程调试。此兼容路径仍依赖 DevToolsActivePort，仅在扩展连接器不可用时使用。'
            : 'Explicitly enable remote debugging at chrome://inspect/#remote-debugging in Chrome 144+. This compatibility path still relies on DevToolsActivePort and is only for cases where the extension connector cannot be used.'}
        </p>
      )}
    </SettingsCard>
  );
}


function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
