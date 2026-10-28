import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AppLanguage } from '../../types';
import { componentProtocol, componentTitle, isBuiltinComponent, maxComponentBytes, type ComponentCollection, type HtmlComponent } from './componentModel';
import { saveComponents, useComponents } from './componentStore';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { componentId } from './componentId';
import { BuiltinComponentSurface } from './BuiltinComponentSurface';
import { WelcomeLayoutEditor } from './WelcomeLayoutEditor';
import { ComposerLayoutSettings } from './ComposerLayoutSettings';
import { HtmlComponentContext } from './HtmlComponentContext';
import './components.css';

export function ComponentsApp({ language }: { language: AppLanguage }) {
  const saved = useComponents();
  const [editing, setEditing] = useState(false), [adding, setAdding] = useState(false), [error, setError] = useState('');
  const commit = (next: ComponentCollection) => {
    try { saveComponents(next, next.revision); setError(''); return true; }
    catch (cause) { setError(String(cause).includes('REVISION_CONFLICT')
      ? uiText(language)('componentsApp.configurationChangedInAnotherWindowPleaseRetry')
      : uiText(language)('componentsApp.unableToSaveComponentsCheckAvailableStorage')); return false; }
  };
  if (editing) return <WelcomeLayoutEditor collection={saved} language={language} onClose={() => setEditing(false)}/>;
  return <HtmlComponentContext.Provider value={null}><div className="components-app">
    <header><div className="components-heading"><strong>{uiText(language)('appCenterModel.components')}</strong><span>{uiText(language)('componentsApp.arrangeYourNewConversationPagePreviewsDo')}</span></div><div>
      <button type="button" onClick={() => setEditing(true)}>{uiText(language)('componentsApp.editLayout')}</button>
      <button type="button" onClick={() => setAdding(true)}><Plus size={15}/>{uiText(language)('componentsApp.customComponent')}</button>
    </div></header>
    {error && <p role="alert">{error}</p>}
    <div className="components-grid">
      {saved.items.map(item => <article key={item.id} data-component-id={item.id} data-builtin={isBuiltinComponent(item) ? item.builtin : undefined} className="html-component-card"
        style={{ '--component-width': item.width, '--component-height': item.height + 'px', order: item.order } as CSSProperties}>
        <div className="html-component-content" inert>{isBuiltinComponent(item)
          ? <BuiltinComponentSurface component={item} language={language} preview/>
          : <HtmlComponentSurface component={item} active={false}/>}</div>
        <header><span className="component-card-title">{componentTitle(item, language)}</span>
          {isBuiltinComponent(item) && item.builtin === 'input' && <div className="component-input-choices" role="group" aria-label={uiText(language)('componentsApp.composerStyle')}>
            {(['standard', 'simple'] as const).map(style => <button key={style} type="button" aria-pressed={(item.inputStyle ?? 'standard') === style}
              onClick={() => commit({ ...saved, items: saved.items.map(current => current.id === item.id ? { ...item, inputStyle: style } : current) })}>
              {style === 'standard' ? uiText(language)('componentsApp.standard') : uiText(language)('componentsApp.simple')}
            </button>)}
          </div>}
          {isBuiltinComponent(item) && item.builtin === 'input' && <ComposerLayoutSettings language={language} flow={item.composerFlow}
            onChange={composerFlow => commit({ ...saved, items: saved.items.map(current => current.id === item.id ? { ...item, composerFlow } : current) })}/>}
          {isBuiltinComponent(item) ? <span className="component-builtin-label">{uiText(language)('componentsApp.builtIn')}</span>
            : <button type="button" title={uiText(language)('componentsApp.removeComponent')} onClick={() => commit({ ...saved, items: saved.items.filter(current => current.id !== item.id) })}><Trash2 size={14}/></button>}
        </header>
      </article>)}
    </div>
    {adding && <ComponentImport language={language} onClose={() => setAdding(false)} onAdd={component => {
      if (saved.items.filter(item => !isBuiltinComponent(item)).length >= 12) throw new Error(uiText(language)('componentsApp.upTo12CustomComponentsAreSupported'));
      if (!commit({ ...saved, items: [...saved.items, { ...component, order: Math.max(0, ...saved.items.map(item => item.order)) + 1 }] })) throw new Error(uiText(language)('componentsApp.saveFailed'));
      setAdding(false);
    }}/>}
  </div></HtmlComponentContext.Provider>;
}

function ComponentImport({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (component: HtmlComponent) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [title, setTitle] = useState(''), [html, setHtml] = useState(''), [allowActions, setAllowActions] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog className="inspector-page-dialog component-import" ref={dialog} aria-label={uiText(language)('componentsApp.customComponent')} onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => { event.preventDefault(); try {
      if (!title.trim() || !html.trim()) throw new Error(uiText(language)('componentsApp.enterANameAndHtmlContent'));
      if (new TextEncoder().encode(html).length > maxComponentBytes) throw new Error(uiText(language)('componentsApp.htmlMustNotExceed256Kib'));
      onAdd({ id: componentId(), title: title.trim().slice(0, 80), html, allowActions, width: 6, height: 280, order: 0 });
    } catch (cause) { setError(String(cause)); } }}>
      <div className="component-import-heading"><h2>{uiText(language)('componentsApp.customComponent')}</h2><button type="button" aria-label={uiText(language)('common.close')} onClick={onClose}><X size={15}/></button></div>
      <label>{uiText(language)('agentConnectionForm.name')}<input autoFocus value={title} maxLength={80} onChange={event => setTitle(event.target.value)}/></label>
      <label>{uiText(language)('componentsApp.htmlOrComponentPackage')}<input type="file" accept=".html,.htm,.json" onChange={async event => {
        const file = event.target.files?.[0]; if (!file) return;
        try { if (file.size > maxComponentBytes * 2) throw new Error(uiText(language)('componentsApp.fileIsTooLarge')); const text = await file.text();
          if (/\.json$/i.test(file.name)) { const data = JSON.parse(text); if (data.protocol !== componentProtocol || typeof data.html !== 'string') throw new Error(uiText(language)('componentsApp.unsupportedComponentPackage')); setHtml(data.html); setTitle(String(data.title || file.name).slice(0, 80)); }
          else { setHtml(text); setTitle(file.name.replace(/\.html?$/i, '')); } setError('');
        } catch (cause) { setError(String(cause)); }
      }}/></label>
      <label>{uiText(language)('componentsApp.html')}<textarea value={html} onChange={event => setHtml(event.target.value)} spellCheck={false} rows={7} placeholder={uiText(language)('componentsApp.main_main')}/></label>
      <small>{uiText(language)('componentsApp.supportsInlineCssJavascriptAndDataImages')}</small>
      <label className="component-action-grant"><input type="checkbox" checked={allowActions} onChange={event => setAllowActions(event.target.checked)}/><span>{uiText(language)('componentsApp.allowConversationAndBrowserActionsMayUse')}</span></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit">{uiText(language)('componentsApp.addComponent')}</button></footer>
    </form>
  </dialog>;
}
