import { useState, type CSSProperties } from 'react';
import { LayoutGrid, Pencil, Plus, Trash2, MessageSquare } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { HtmlComponent } from './componentModel';
import { saveComponents, useComponents } from './componentStore';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { HtmlComponentContext } from './HtmlComponentContext';
import { ComponentEditor, componentError } from './ComponentEditor';
import './components.css';

type Props = {language: AppLanguage; onCreate?: (draft: string) => void; onEditHomeLayout: () => void};
export function ComponentsApp({language, onCreate, onEditHomeLayout}: Props) {
  const t = uiText(language), saved = useComponents();
  const [editor, setEditor] = useState<{item?: HtmlComponent; revision: number}>();
  const [error, setError] = useState('');
  const commit = async (items: HtmlComponent[], revision = saved.revision) => {
    await saveComponents({...saved, items}, revision);
    setError('');
  };
  const update = (items: HtmlComponent[]) => { void commit(items).catch(cause => setError(componentError(language,cause))); };
  const startChat = () => onCreate?.(t('homeComponents.createDraft'));
  const create = <button type="button" onClick={startChat}><MessageSquare/>{t('homeComponents.createInChat')}</button>;
  const edit = <button type="button" onClick={() => setEditor({revision:saved.revision})}><Plus/>{t('componentsApp.customComponent')}</button>;
  return <section className="components-app">
    <header><h1>{t('appCenterModel.components')}</h1><div>
      {onCreate && create}{edit}
      <button type="button" data-home-action="edit" onClick={onEditHomeLayout}><LayoutGrid/>{t('homeLayout.edit')}</button>
    </div></header>
    {error && <p role="alert">{error}</p>}
    <div className="components-grid">{saved.items.map(item => <article key={item.id} data-component-id={item.id} className="html-component-card"
      style={{'--component-width':item.width,'--component-height':item.height+'px'} as CSSProperties}>
      <div className="html-component-content" inert><HtmlComponentContext.Provider value={null}><HtmlComponentSurface component={item} active={false}/></HtmlComponentContext.Provider></div>
      <header><span className="component-card-title">{item.title}</span>
        <button type="button" aria-label={t('homeComponents.edit',{name:item.title})} onClick={() => setEditor({item,revision:saved.revision})}><Pencil/></button>
        <button type="button" aria-label={t('componentsApp.removeComponent')} onClick={() => update(saved.items.filter(old => old.id !== item.id))}><Trash2/></button>
      </header>
    </article>)}</div>
    {editor && <ComponentEditor language={language} initial={editor.item} onClose={() => setEditor(undefined)} onSave={async item => {
      if (editor.item) await commit(saved.items.map(old => old.id === item.id ? item : old), editor.revision);
      else await commit([...saved.items, {...item, home:false, order: Math.max(-1,...saved.items.map(old => old.order))+1}], editor.revision);
      setEditor(undefined);
    }}/>}
  </section>;
}
