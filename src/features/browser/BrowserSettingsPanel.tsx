import { useEffect, useRef, useState } from 'react';
import { browserStartPageSchema, DEFAULT_BROWSER_START_PAGE, type BrowserConfiguration } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';
import { SettingsCard, SettingsInput } from '../settings/SettingsControls';
import { CoreCapabilitySettings } from '../capabilities/CoreCapabilitySettings';
import { ChromeConnectionSettings } from './ChromeConnectionSettings';

export function BrowserSettingsPanel({ language }: { language: AppLanguage }) {
  return <div className="settings-stack browser-settings-panel">
    <BrowserStartPageSettings language={language} />
    <CoreCapabilitySettings id="chrome" language={language}>{controls => <ChromeConnectionSettings {...controls} />}</CoreCapabilitySettings>
    <SettingsCard title={language === 'zh' ? 'Chrome 扩展与个人配置' : 'Chrome extensions and preferences'}>
      <p>{language === 'zh' ? '连接真实 Chrome 后，可继续使用其中安装的扩展、登录状态和浏览器配置。请在 Chrome 的扩展管理器中安装和管理扩展。' : 'Connected Chrome retains its installed extensions, signed-in state, and browser preferences. Install and manage extensions in Chrome’s extension manager.'}</p>
      <p>{language === 'zh' ? 'CardBush 内置浏览器使用独立页面；Chrome 扩展和密码不会自动导入其中。' : 'The embedded browser is separate. Chrome extensions and passwords are not automatically imported.'}</p>
    </SettingsCard>
  </div>;
}

export function BrowserStartPageSettings({ language }: { language: AppLanguage }) {
  const zh = language === 'zh', desktop = window.cardbushDesktop;
  const [configuration, setConfiguration] = useState<BrowserConfiguration | null>(null);
  const [draft, setDraft] = useState(DEFAULT_BROWSER_START_PAGE), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), saving = useRef(false), [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setConfiguration(null); setError(''); setSaved(false);
    if (!desktop?.readBrowserConfiguration) { setError(zh ? '请重启更新后的 CardBush。' : 'Restart the updated CardBush.'); return; }
    void desktop.readBrowserConfiguration().then(value => {
      if (active) { setConfiguration(value); setDraft(value.startPage); }
    }, error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [desktop, zh, reload]);
  const save = async () => {
    if (!configuration || !desktop || saving.current) return;
    const parsed = browserStartPageSchema.safeParse(draft);
    if (!parsed.success) { setError(zh ? '请输入有效的 http/https 网址，或 about:blank。' : 'Enter a valid HTTP(S) URL or about:blank.'); return; }
    saving.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const next = await desktop.updateBrowserConfiguration({ startPage: parsed.data, expectedRevision: configuration.revision });
      setConfiguration(next); setDraft(next.startPage); setSaved(true);
    } catch (error) { setError(String(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingsCard title={zh ? '初始页面' : 'Start page'} subtitle={zh ? '应用内新标签页和 Chrome 工具未指定网址时使用。已打开的页面保持不变。' : 'Used for new embedded tabs and Chrome tool calls without a URL. Existing tabs keep their current pages.'}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <SettingsInput label={zh ? '默认主页' : 'Default home page'} value={draft} placeholder="https://www.google.com/" disabled={!configuration || busy}
        onChange={value => { setDraft(value); setSaved(false); setError(''); }} />
      <div className="settings-action-row">
        <button className="primary-button compact" type="submit" disabled={!configuration || busy}>{busy ? (zh ? '正在保存…' : 'Saving…') : (zh ? '保存主页' : 'Save home page')}</button>
        <button className="secondary-button compact" type="button" disabled={!configuration || busy} onClick={() => { setDraft(DEFAULT_BROWSER_START_PAGE); setSaved(false); }}>{zh ? '恢复 Google' : 'Reset to Google'}</button>
      </div>
      {error && <p role="alert">{error} <button className="secondary-button compact" type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>{zh ? '重新加载' : 'Reload'}</button></p>}{saved && <p role="status">{zh ? '已保存，新打开的页面将使用此主页。' : 'Saved. New tabs will use this start page.'}</p>}
    </form>
  </SettingsCard>;
}
