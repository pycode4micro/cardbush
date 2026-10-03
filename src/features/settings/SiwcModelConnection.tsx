import { useEffect, useRef, useState } from 'react';
import type { SiwcModel } from '@cardbush/bush-protocol';
import { useSiwc } from '../accounts/useSiwc';
import { ChatGptWelcome } from '../accounts/ChatGptWelcome';
import { ChatGptMark } from '../accounts/ChatGptMark';
import { SettingsDropdown } from './SettingsDropdown';
import { agentErrorText } from '../agents/agentErrorText';

export function SiwcModelConnection({ language, accountId, onAccountChange, modelName, onModelChange }: {
  language: 'zh' | 'en'; accountId: string; onAccountChange: (id: string) => void;
  modelName: string; onModelChange: (name: string) => void;
}) {
  const zh = language === 'zh', { snapshot, error, action } = useSiwc();
  const [models, setModels] = useState<SiwcModel[]>([]), [modelError, setModelError] = useState('');
  const [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const account = snapshot?.accounts.find(item => item.id === accountId);
  useEffect(() => {
    let cancelled = false;
    setModels([]); setModelError(''); setLoading(false);
    if (!accountId || account?.state !== 'signed_in' || !account.planEnabled) return;
    setLoading(true);
    void window.cardbushDesktop!.siwcModels(accountId).then(result => {
      if (!cancelled) { setModels(result); if (!result.length) setModelError(zh ? '此账号没有返回可用模型。' : 'No available models were returned for this account.'); }
    }).catch(failure => { if (!cancelled) setModelError(agentErrorText(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, account?.state, account?.planEnabled, revision, zh]);
  async function login(id?: string) {
    const existing = new Set(snapshot?.accounts.map(item => item.id));
    const next = await action({ action: 'login', ...(id ? { accountId: id } : {}) });
    if (!mounted.current || !next) return;
    const selected = next.accounts.find(item => item.id === (next.connectedAccountId ?? id)) ?? next.accounts.find(item => !existing.has(item.id) && item.state === 'signed_in');
    if (selected) { onAccountChange(selected.id); setRevision(value => value + 1); }
  }
  return <section className="siwc-model-connection settings-stack">
    <p className="model-connection-note">{zh ? '通过官方授权使用 ChatGPT 套餐。模型列表随所选账号获取，账号仅保存在本机。' : 'Use your ChatGPT plan through official authorization. Available models follow the selected account, which stays on this device.'}</p>
    <label className="settings-field"><span>{zh ? 'ChatGPT 账号' : 'ChatGPT account'}</span><SettingsDropdown label={zh ? 'ChatGPT 账号' : 'ChatGPT account'} value={accountId}
      options={[{ value: '', label: zh ? '选择账号' : 'Choose an account' }, ...(snapshot?.accounts.map(item => ({ value: item.id,
        label: `${item.label}${item.state !== 'signed_in' ? zh ? ' · 需要登录' : ' · sign in required' : !item.planEnabled ? zh ? ' · 未授权套餐' : ' · plan not authorized' : ''}` })) ?? [])]}
      onChange={id => { onAccountChange(id); onModelChange(''); }}/></label>
    <div className="settings-actions">{snapshot?.signingIn
      ? <button type="button" className="secondary-button" onClick={() => void action({ action: 'cancel_login' })}>{zh ? '取消登录' : 'Cancel sign-in'}</button>
      : <><button type="button" className="secondary-button" onClick={() => void login(accountId || undefined)}><ChatGptMark/>Continue with ChatGPT</button>
        {snapshot?.accounts.length ? <button type="button" className="secondary-button" onClick={() => void login()}>{zh ? '添加另一账号' : 'Add another account'}</button> : null}
        {account && <button type="button" className="secondary-button" onClick={() => void action({ action: 'logout', accountId })}>{zh ? '退出账号' : 'Sign out'}</button>}</>}
      <button type="button" className="secondary-button" onClick={() => void action({ action: 'manage_usage' })}>{zh ? '套餐用量' : 'Plan usage'}</button></div>
    {account?.state === 'signed_in' && account.planEnabled && <label className="settings-field"><span>{zh ? '账号可用模型' : 'Available models'}</span>
      <SettingsDropdown label={zh ? '账号可用模型' : 'Available models'} value={modelName} options={[
        { value: '', label: loading ? zh ? '正在获取…' : 'Loading…' : zh ? '选择模型' : 'Choose a model' },
        ...models.map(item => ({ value: item.id, label: item.name || item.id })),
      ]} onChange={onModelChange}/>
      <button type="button" className="model-advanced-disclosure" disabled={loading} onClick={() => setRevision(value => value + 1)}>{zh ? '刷新模型列表' : 'Refresh models'}</button>
    </label>}
    {(error || modelError || account?.lastError || snapshot?.lastError) && <p className="settings-inline-error" role="alert">{error || modelError || account?.lastError || snapshot?.lastError}</p>}
    <ChatGptWelcome language={language}/>
  </section>;
}
