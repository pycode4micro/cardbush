import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { componentId } from './componentId';
import { componentProtocol, maxComponentBytes, type HtmlComponent } from './componentModel';
import { ComponentOriginGrants } from './ComponentOriginGrants';
import { approvedWebsiteUrl, componentOrigins } from '../../../assets/skills/cardbush-docs/scripts/component-origins.mjs';
import { approvedOrigins } from './componentNetwork';
import './components.css';

export function componentError(language: AppLanguage, cause: unknown) {
  const t = uiText(language);
  if (String(cause).includes('REVISION_CONFLICT')) return t('componentsApp.configurationChangedInAnotherWindowPleaseRetry');
  if (String(cause).includes('COMPONENT_LIMIT')) return t('componentsApp.upTo12CustomComponentsAreSupported');
  return cause instanceof Error && [t('componentsApp.htmlMustNotExceed256Kib'), t('componentsApp.enterANameAndHtmlContent')].includes(cause.message)
    ? cause.message : t('componentsApp.unableToSaveComponentsCheckAvailableStorage');
}

export function ComponentEditor({ language, initial, onClose, onSave }: { language: AppLanguage; initial?: HtmlComponent; onClose: () => void; onSave: (component: HtmlComponent) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), [title, setTitle] = useState(initial?.title ?? ''), [html, setHtml] = useState(initial?.html ?? ''), [allowActions, setAllowActions] = useState(initial?.allowActions ?? false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  const [busy, setBusy] = useState(false);
  const requested = componentOrigins(initial?.networkDomains);
  const [approved, setApproved] = useState<string[]>(() => initial ? approvedOrigins(initial) : []);
  const [embedSites, setEmbedSites] = useState(() => componentOrigins(initial?.embedDomains));
  const embeds = embedSites;
  const [websiteChoice, setWebsiteChoice] = useState(initial?.homeWebsiteUrl);
  const pages = html === initial?.html
    ? [approvedWebsiteUrl(initial?.homeWebsiteUrl, embeds)].filter((url): url is string => !!url)
    : [];
  const defaultPage = approvedWebsiteUrl(websiteChoice, embeds);
  const updateHtml = (source:string) => {
    if (source !== html) { setWebsiteChoice(undefined); setHtml(source); }
  };
  return <dialog className="inspector-page-dialog component-import" ref={dialog} aria-label={uiText(language)('componentsApp.customComponent')} onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); try {
      if (!title.trim() || !html.trim()) throw new Error(uiText(language)('componentsApp.enterANameAndHtmlContent'));
      if (new TextEncoder().encode(html).length > maxComponentBytes) throw new Error(uiText(language)('componentsApp.htmlMustNotExceed256Kib'));
      await onSave({ width: 6, height: 280, order: 0, ...initial, id: initial?.id ?? componentId(), title: title.trim().slice(0, 80), html, allowActions,
        networkDomains: requested, approvedNetworkOrigins:approved, embedDomains:embedSites, approvedEmbedOrigins:embeds,
        homeWebsiteUrl: defaultPage ?? (websiteChoice === null ? null : undefined) });
    } catch (cause) { setError(componentError(language, cause)); } finally { setBusy(false); } }}>
      <div className="component-import-heading"><h2>{uiText(language)('componentsApp.customComponent')}</h2><button type="button" aria-label={uiText(language)('common.close')} onClick={onClose}><X size={15}/></button></div>
      <label>{uiText(language)('agentConnectionForm.name')}<input autoFocus value={title} maxLength={80} onChange={event => setTitle(event.target.value)}/></label>
      <label>{uiText(language)('homeComponents.sourceFiles')}<input type="file" multiple accept=".html,.htm,.json,.css,.js,.mjs,.ts,.mts" onChange={async event => {
        const files = Array.from(event.currentTarget.files ?? []);
        if (!files.length) return;
        try {
          if (files.length > 64 || files.reduce((sum,file) => sum + file.size, 0) > maxComponentBytes * 2) throw Error('COMPONENT_SIZE');
          const source = await Promise.all(files.map(async file => ({name:file.name,text:await file.text()})));
          const entry = source.find(file => /\.html?$/i.test(file.name)) ?? source[0];
          let name = entry.name.replace(/\.[^.]+$/, ''), document: string, declared: string[] = [];
          if (source.length === 1 && /\.json$/i.test(entry.name)) {
            const data = JSON.parse(entry.text);
            if (data.protocol !== componentProtocol || typeof data.html !== 'string') throw Error('INVALID_COMPONENT');
            document = data.html; name = String(data.title || name);
            declared = componentOrigins(data.embedDomains);
          } else if (source.length === 1 && /\.html?$/i.test(entry.name)) document = entry.text;
          else {
            if (!window.cardbushDesktop?.assembleHomeComponent) throw Error('UNSUPPORTED_COMPONENT_FILE');
            document = await window.cardbushDesktop.assembleHomeComponent(source);
          }
          if (new TextEncoder().encode(document).length > maxComponentBytes) throw Error('COMPONENT_SIZE');
          updateHtml(document); setEmbedSites(declared); setTitle(name.slice(0,80)); setError('');
        } catch (cause) {
          setError(uiText(language)(String(cause).includes('COMPONENT_SIZE') ? 'componentsApp.htmlMustNotExceed256Kib' : 'componentsApp.unsupportedComponentPackage'));
        }
      }}/></label>
      <label>{uiText(language)('componentsApp.html')}<textarea value={html} onChange={event => updateHtml(event.target.value)} spellCheck={false} rows={7} placeholder={uiText(language)('componentsApp.main_main')}/></label>
      <small>{uiText(language)('componentsApp.supportsInlineCssJavascriptAndDataImages')}</small>
      <ComponentOriginGrants legendKey="homeComponents.networkSources" sites={requested} approved={approved} change={setApproved}/>
      {embedSites.length > 0 && <fieldset><legend>{uiText(language)('homeComponents.embedSources')}</legend>
        {embedSites.map(site => <div key={site}>{site}</div>)}</fieldset>}
      {pages.length > 0 && <label>{uiText(language)('homeComponents.cardDefault')}<select name="homeWebsiteUrl" value={defaultPage ?? ''}
        onChange={event => setWebsiteChoice(event.target.value || null)}>
        <option value="">{uiText(language)('homeComponents.widgetView')}</option>
        {pages.map(url => <option key={url} value={url}>{url}</option>)}
      </select></label>}
      <label className="component-action-grant"><input type="checkbox" checked={allowActions} onChange={event => setAllowActions(event.target.checked)}/><span>{uiText(language)('componentsApp.allowConversationAndBrowserActionsMayUse')}</span></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit" disabled={busy}>{uiText(language)('appCenter.save')}</button></footer>
    </form>
  </dialog>;
}
