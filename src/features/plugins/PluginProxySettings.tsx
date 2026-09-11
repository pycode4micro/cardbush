import { useEffect, useRef, useState } from 'react';
import { defaultPluginProxy, pluginProxySchema, type PluginProxySettings } from '@cardbush/bush-protocol';
import type { AppLanguage } from '../../types';

export function proxyLabel(mode: string, zh: boolean): string {
  return ({ inherit: zh ? '使用默认' : 'Use default', model: zh ? '跟随模型代理' : 'Follow model proxy',
    none: zh ? '无代理' : 'No proxy', system: zh ? '跟随系统' : 'Follow system', manual: zh ? '手动代理' : 'Manual proxy' })[mode] ?? mode;
}

export function PluginProxySettings({ language, value, defaults, individual = false, busy = false, onSave, label, caption, compact = false, resetRevision = 0, applyToAll }: {
  language: AppLanguage; value?: PluginProxySettings; defaults?: PluginProxySettings; individual?: boolean; busy?: boolean;
  label?: string; caption?: string; compact?: boolean; resetRevision?: number;
  onSave: (value: PluginProxySettings | undefined) => Promise<boolean>;
  applyToAll?: { formId: string; save: (value: PluginProxySettings) => Promise<boolean> };
}) {
  const zh = language === 'zh';
  const [draft, setDraft] = useState(value ?? defaultPluginProxy());
  const [inherit, setInherit] = useState(individual && !value);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
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
  const save = async (candidate = draft, useDefault = inherit, all = false) => {
    if (busy || savingRef.current) return;
    const result = pluginProxySchema.safeParse(candidate);
    if (!useDefault && !result.success) { setError(zh ? '请输入有效的代理地址（HTTP、HTTPS 或 SOCKS）。' : 'Enter a valid HTTP, HTTPS or SOCKS proxy address.'); return; }
    if (!useDefault && candidate.mode === 'manual' && !candidate.httpProxy.trim() && !candidate.httpsProxy.trim()) {
      setError(zh ? '请至少填写一个代理地址。' : 'Enter at least one proxy address.'); return;
    }
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = all && applyToAll && result.success ? await applyToAll.save(result.data) : await onSave(useDefault ? undefined : result.data);
      if (saved) setDirty(false);
      else setError(all ? (zh ? '尚未全部应用，请重试。' : 'Not all settings were applied. Please retry.') : (zh ? '保存未完成，请重试。' : 'Save did not complete. Please retry.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { savingRef.current = false; setSaving(false); }
  };
  const Container = applyToAll ? 'form' : 'div';
  return <Container id={applyToAll?.formId} className={`plugin-proxy-settings${compact ? ' plugin-proxy-row' : ''}`}
    onSubmit={event => { event.preventDefault(); if (applyToAll) void save(draft, false, true); }}>
    {label && <div className="plugin-proxy-row-name"><strong>{label}</strong>{caption && <small>{caption}</small>}</div>}
    <label className="plugin-proxy-mode"><span>{zh ? '代理方式' : 'Proxy mode'}</span>
      <select aria-label={label ? `${label} ${zh ? '代理方式' : 'proxy mode'}` : zh ? '代理方式' : 'Proxy mode'} value={mode} disabled={busy || saving} onChange={event => {
        const mode = event.target.value; setInherit(mode === 'inherit');
        if (mode !== 'inherit') {
          const next = { ...draft, mode: mode as PluginProxySettings['mode'] };
          update(next);
          // Discrete global choices take effect immediately. Manual addresses
          // stay editable until the complete configuration is saved/applied.
          if (!individual && mode !== 'manual') void save(next, false);
        } else { setDirty(true); setError(''); }
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
        <input value={draft[field]} disabled={busy || saving} autoComplete="off" spellCheck={false}
          placeholder={field === 'noProxy' ? 'localhost,127.0.0.1,.internal' : 'http://127.0.0.1:7890'} onChange={event => update({ [field]: event.target.value })} />
      </label>)}</div>}
    {error && <p className="plugin-market-error" role="alert">{error}</p>}
    {!individual && <p className="plugin-proxy-help" role="status">{saving ? (zh ? '正在保存…' : 'Saving…') : dirty
      ? (applyToAll ? (zh ? '当前修改尚未保存。填写完成后保存，或一键应用到全部。' : 'Changes are not saved. Save when ready, or apply to all.')
        : (zh ? '当前修改尚未保存，填写完成后请保存。' : 'Changes are not saved. Save when ready.'))
      : (zh ? '已保存，重新进入或重启后保留。' : 'Saved. Retained when reopening or restarting.')}</p>}
    {dirty && <button type="button" className="plugin-install-button" disabled={busy || saving} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : compact ? (zh ? '保存' : 'Save') : (zh ? '保存代理设置' : 'Save proxy settings')}</button>}
  </Container>;
}
