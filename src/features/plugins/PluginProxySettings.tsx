import { useEffect, useRef, useState } from 'react';
import { defaultPluginProxy, pluginProxySchema, type PluginProxySettings } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';

export function proxyLabel(mode: string, zh: boolean): string {
  return ({ inherit: zh ? '使用默认' : 'Use default', model: zh ? '跟随模型代理' : 'Follow model proxy',
    none: zh ? '无代理' : 'No proxy', system: zh ? '跟随系统' : 'Follow system', manual: zh ? '手动代理' : 'Manual proxy' })[mode] ?? mode;
}

export function PluginProxySettings({ language, value, defaults, individual = false, busy = false, onSave, label, caption, compact = false, resetRevision = 0 }: {
  language: AppLanguage; value?: PluginProxySettings; defaults?: PluginProxySettings; individual?: boolean; busy?: boolean;
  label?: string; caption?: string; compact?: boolean; resetRevision?: number;
  onSave: (value: PluginProxySettings | undefined) => Promise<boolean>;
}) {
  const zh = language === 'zh';
  const [draft, setDraft] = useState(value ?? defaultPluginProxy());
  const [inherit, setInherit] = useState(individual && !value);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const lastReset = useRef(resetRevision);
  const serialized = JSON.stringify(value);
  useEffect(() => {
    if (!dirty || lastReset.current !== resetRevision) {
      setDraft(value ?? defaultPluginProxy()); setInherit(individual && !value);
      if (lastReset.current !== resetRevision) { lastReset.current = resetRevision; setDirty(false); setError(''); }
    }
  }, [serialized, individual, dirty, resetRevision]);
  const mode = inherit ? 'inherit' : draft.mode;
  const update = (patch: Partial<PluginProxySettings>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); setError(''); };
  const save = async () => {
    const result = pluginProxySchema.safeParse(draft);
    if (!inherit && !result.success) { setError(zh ? '请输入有效的代理地址（HTTP、HTTPS 或 SOCKS）。' : 'Enter a valid HTTP, HTTPS or SOCKS proxy address.'); return; }
    if (!inherit && draft.mode === 'manual' && !draft.httpProxy.trim() && !draft.httpsProxy.trim()) {
      setError(zh ? '请至少填写一个代理地址。' : 'Enter at least one proxy address.'); return;
    }
    if (await onSave(inherit ? undefined : result.data)) setDirty(false);
  };
  return <div className={`plugin-proxy-settings${compact ? ' plugin-proxy-row' : ''}`}>
    {label && <div className="plugin-proxy-row-name"><strong>{label}</strong>{caption && <small>{caption}</small>}</div>}
    <label className="plugin-proxy-mode"><span>{zh ? '代理方式' : 'Proxy mode'}</span>
      <select aria-label={label ? `${label} ${zh ? '代理方式' : 'proxy mode'}` : zh ? '代理方式' : 'Proxy mode'} value={mode} disabled={busy} onChange={event => {
        const mode = event.target.value; setInherit(mode === 'inherit');
        if (mode !== 'inherit') update({ mode: mode as PluginProxySettings['mode'] }); else { setDirty(true); setError(''); }
      }}>{(individual ? ['inherit', 'model', 'none', 'system', 'manual'] : ['model', 'none', 'system', 'manual']).map(mode =>
        <option key={mode} value={mode}>{mode === 'inherit'
          ? `${proxyLabel(mode, zh)}${zh ? '（' : ' ('}${proxyLabel(defaults?.mode ?? 'model', zh)}${zh ? '）' : ')'}`
          : proxyLabel(mode, zh)}</option>)}</select>
    </label>
    {!compact && <p className="plugin-proxy-help">{inherit
      ? `${zh ? '当前插件默认：' : 'Current plugin default: '}${proxyLabel(defaults?.mode ?? 'model', zh)}`
      : mode === 'model' ? (zh ? '使用设置中的模型代理；模型代理变化时自动跟随。' : 'Uses the proxy in model settings and follows changes automatically.')
      : mode === 'system' ? (zh ? '按目标地址使用操作系统的代理和绕过规则。' : 'Uses the operating system proxy and bypass rules for each destination.')
      : mode === 'none' ? (zh ? '直接连接，并清除插件进程继承的代理环境。' : 'Connects directly and clears inherited proxy environment values.')
      : (zh ? '仅作用于此处的插件范围，支持 HTTP、HTTPS 和 SOCKS。' : 'Applies to this plugin scope. Supports HTTP, HTTPS and SOCKS.')}</p>}
    {mode === 'manual' && <div className="plugin-proxy-fields">{(['httpProxy', 'httpsProxy', 'noProxy'] as const).map(field =>
      <label key={field}><span>{field === 'httpProxy' ? 'HTTP_PROXY' : field === 'httpsProxy' ? 'HTTPS_PROXY' : 'NO_PROXY'}</span>
        <input value={draft[field]} disabled={busy} autoComplete="off" spellCheck={false}
          placeholder={field === 'noProxy' ? 'localhost,127.0.0.1,.internal' : 'http://127.0.0.1:7890'} onChange={event => update({ [field]: event.target.value })} />
      </label>)}</div>}
    {error && <p className="plugin-market-error" role="alert">{error}</p>}
    {dirty && <button type="button" className="plugin-install-button" disabled={busy} onClick={() => void save()}>{busy ? (zh ? '保存中…' : 'Saving…') : compact ? (zh ? '保存' : 'Save') : (zh ? '保存代理设置' : 'Save proxy settings')}</button>}
  </div>;
}
