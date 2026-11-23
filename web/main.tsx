import React, { Suspense, useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { recoverableLazy } from '../src/shared/recoverableLazy';
import { WebLanguage } from './Language';
import { Brand } from './templates/WebBrand.template';
import { WebModuleNotice } from './templates/WebModuleNotice.template';
import { activateBrowserCache, type AccountCache } from './browserCache';
import { BrowserCacheContext } from './BrowserCacheProvider';
import { api, ApiError, errorText, setIdentity, type Department, type Identity } from './api';
import './styles.css';

const Workspace = recoverableLazy<ComponentProps<typeof import('./Workspace').Workspace>>('web-workspace',
  () => import('./Workspace').then(({ Workspace }) => ({ default: Workspace })),
  (_props, retry) => <div className="splash"><Brand/><WebModuleNotice retry={retry}/></div>);
const accountChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cardbush-web-identity');

function WorkspaceLoading() {
  const language = useUiLanguage();
  return <div className="splash" role="status"><Brand/><span className="loading-dot"/>{uiText(language)('web.openingYourConversationSpace')}</div>;
}

function App() {
  const [identity, updateIdentity] = useState<Identity | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef(0);
  const cache = useRef<AccountCache | null>(null);
  const apply = useCallback((next: Identity | null) => { revision.current++; cache.current = activateBrowserCache(next?.user.id ?? null); setIdentity(next); updateIdentity(next); setLoading(false); }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => { const started = revision.current; void api<Identity>('/auth/me').then(next => { if (alive && revision.current === started) { apply(next); setError(''); } }).catch(failure => { if (alive && revision.current === started) { if (failure instanceof ApiError && failure.status === 401) apply(null); else { setLoading(false); setError(uiText()("web.connectionInterruptedPleaseTryAgainLater")); } } }); };
    const logout = () => apply(null);
    const accountChanged = () => { revision.current++; cache.current?.close(); cache.current = null; setIdentity(null); updateIdentity(null); setLoading(true); refresh(); };
    refresh(); window.addEventListener('cardbush:logged-out', logout); window.addEventListener('focus', refresh); window.addEventListener('cardbush:models-changed', refresh);
    if (accountChannel) accountChannel.onmessage = accountChanged;
    const storage = (event: StorageEvent) => { if (event.key === 'cardbush-cache-identity-v1' && cache.current && !cache.current.valid()) accountChanged(); };
    window.addEventListener('storage', storage);
    return () => { alive = false; window.removeEventListener('storage', storage); window.removeEventListener('cardbush:logged-out', logout); window.removeEventListener('focus', refresh); window.removeEventListener('cardbush:models-changed', refresh); if (accountChannel) accountChannel.onmessage = null; };
  }, [apply]);
  const logout = async () => { try { await api('/auth/logout', 'POST', {}); apply(null); accountChannel?.postMessage('changed'); } catch (failure) { setError(errorText(failure)); } };
  if (loading) return <WorkspaceLoading/>;
  return identity ? <BrowserCacheContext.Provider value={cache.current}><Suspense fallback={<WorkspaceLoading/>}><Workspace key={identity.user.id} identity={identity} logout={logout} externalError={error}/></Suspense></BrowserCacheContext.Provider>
    : <Auth onLogin={next => { apply(next); accountChannel?.postMessage('changed'); }}/>;
}

function Auth({ onLogin }: { onLogin: (identity: Identity) => void }) {
  const language = useUiLanguage();

  const [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]), [company,setCompany] = useState(''), [department,setDepartment] = useState('');
  useEffect(() => { void api<typeof departments>('/auth/departments').then(setDepartments).catch(() => {}); }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice('');
    try {
      const credentials = { username: String(values.get('username')), password: String(values.get('password')) };
      if (register) {
        const result = await api<{ message: string }>('/auth/register', 'POST', { ...credentials, display_name: String(values.get('display_name')), department_id: values.get('department_id') || null });
        setNotice(result.message); setRegister(false);
      } else onLogin(await api<Identity>('/auth/login', 'POST', credentials));
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-story"><Brand/><div className="auth-intro"><span className="eyebrow">{uiText(language)("web.letYourIdeasFlow")}</span><h1>{uiText(language)("web.everyIdeaDeservesAConversation")}</h1><p>{uiText(language)("web.startWithASentenceOrganizeYourThoughtsRefineYourWordsAndFind")}</p></div><div className="auth-orbit" aria-hidden="true"><span>{uiText(language)("web.ideas")}</span><span>{uiText(language)("web.inspiration")}</span><span>{uiText(language)("web.answers")}</span></div><footer>{uiText(language)("web.brandCredit")}</footer></section>
    <section className="auth-form-area"><form onSubmit={submit}><span className="eyebrow">{uiText(language)("web.yourPersonalConversationSpace")}</span><h2>{register ? uiText(language)("web.createAccount") : uiText(language)("web.welcomeBack")}</h2><p className="muted">{register ? uiText(language)("web.afterRegisteringWaitForAnAdministratorToEnableYourAccount") : uiText(language)("web.signInToContinueYourConversations")}</p>
      <label>{uiText(language)("web.username")}<input name="username" autoComplete="username" required minLength={register ? 3 : 1} maxLength={80} pattern={register ? '[A-Za-z0-9_.-]+' : undefined} placeholder={uiText(language)("web.enterYourUsername")}/></label>
      {register && <label>{uiText(language)("web.name")}<input name="display_name" autoComplete="name" required maxLength={120} placeholder={uiText(language)("web.whatShouldWeCallYou")}/></label>}
      <label>{uiText(language)("sshConnectionsPanel.password")}<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : 1} maxLength={128} required placeholder={register ? uiText(language)("web.atLeast8Characters") : uiText(language)("web.enterYourPassword")}/></label>
      {register && departments.length > 0 && <><label>{uiText(language)("web.company")}<select aria-label={uiText(language)("web.registrationCompany")} value={company} onChange={event=>{setCompany(event.target.value);setDepartment('');}}><option value="">{uiText(language)("web.notSelected")}</option>{[...new Map(departments.map(item=>[item.company_id,item.company_name])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>{uiText(language)("web.department")}<select name="department_id" aria-label={uiText(language)("web.registrationDepartment")} disabled={!company} required={Boolean(company)} value={department} onChange={event=>setDepartment(event.target.value)}><option value="">{company?uiText(language)("web.selectADepartment"):uiText(language)("web.selectACompanyFirst")}</option>{departments.filter(item=>item.company_id===company).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
      <button className="primary auth-submit" disabled={busy}>{busy ? uiText(language)("web.pleaseWait") : register ? uiText(language)("web.registerAccount") : uiText(language)("pluginMcpSettings.signIn")}<span>→</span></button>
      <p className="auth-switch">{register ? uiText(language)("web.alreadyHaveAnAccount") : uiText(language)("web.donTHaveAnAccount")}<button type="button" onClick={() => { setRegister(!register); setError(''); setNotice(''); }}>{register ? uiText(language)("web.signInNow") : uiText(language)("web.createAccount")}</button></p>
    </form></section></main>;
}

createRoot(document.getElementById('root')!).render(<WebLanguage><App/></WebLanguage>);
