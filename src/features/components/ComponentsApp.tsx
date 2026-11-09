import { useState, type CSSProperties } from 'react';
import { Check, Minus, Pencil, Plus, Trash2, MessageSquare } from 'lucide-react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { HtmlComponent } from './componentModel';
import { saveComponents, useComponents } from './componentStore';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { HtmlComponentContext } from './HtmlComponentContext';
import { ComponentEditor, componentError } from './ComponentEditor';
import './components.css';

type Props = {language: AppLanguage; home?: boolean; onCreate?: (draft: string) => void};
export function ComponentsApp({language, home = false, onCreate}: Props) {
  const t = uiText(language), saved = useComponents();
  const Heading = home ? 'h2' : 'h1';
  const [picker, setPicker] = useState(false);
  const [editor, setEditor] = useState<{item?: HtmlComponent; revision: number}>();
  const [error, setError] = useState('');
  const visible = saved.items.filter(item => !home || item.home);
  const commit = async (items: HtmlComponent[], revision = saved.revision) => {
    await saveComponents({...saved, items}, revision);
    setError('');
  };
  const update = (items: HtmlComponent[]) => { void commit(items).catch(cause => setError(componentError(language,cause))); };
  const startChat = () => onCreate?.(t('homeComponents.createDraft'));
  const create = <button type="button" onClick={startChat}><MessageSquare/>{t('homeComponents.createInChat')}</button>;
  const edit = <button type="button" onClick={() => setEditor({revision:saved.revision})}><Plus/>{t('componentsApp.customComponent')}</button>;
  return <section className={home ? 'components-app home-components desktop-shelf' : 'components-app'}>
    <header><Heading>{t('appCenterModel.components')}</Heading><div>
      {home ? <button type="button" aria-expanded={picker} aria-label={t('homeComponents.add')} onClick={() => setPicker(!picker)}><Plus/></button> : <>{onCreate && create}{edit}</>}
    </div></header>
    {picker && <div className="home-component-picker">
      {onCreate && create}{edit}
      {saved.items.map(item => <button type="button" key={item.id} aria-pressed={Boolean(item.home)}
        onClick={() => update(saved.items.map(old => old.id === item.id ? {...old, home: !old.home} : old))}>
        {item.home ? <Check/> : <Plus/>}{item.title}</button>)}
    </div>}
    {error && <p role="alert">{error}</p>}
    <div className="components-grid">{visible.map(item => <article key={item.id} data-component-id={item.id} className="html-component-card"
      style={{'--component-width':item.width,'--component-height':item.height+'px'} as CSSProperties}>
      <div className="html-component-content" inert={!home}>{home ? <HtmlComponentSurface component={item}/> :
        <HtmlComponentContext.Provider value={null}><HtmlComponentSurface component={item} active={false}/></HtmlComponentContext.Provider>}</div>
      <header><span className="component-card-title">{item.title}</span>
        <button type="button" aria-label={t('homeComponents.edit',{name:item.title})} onClick={() => setEditor({item,revision:saved.revision})}><Pencil/></button>
        <button type="button" aria-label={home ? t('homeComponents.unpin',{name:item.title}) : t('componentsApp.removeComponent')}
          onClick={() => update(home ? saved.items.map(old => old.id === item.id ? {...old, home:false} : old) : saved.items.filter(old => old.id !== item.id))}>
          {home ? <Minus/> : <Trash2/>}</button>
      </header>
    </article>)}</div>
    {editor && <ComponentEditor language={language} initial={editor.item} onClose={() => setEditor(undefined)} onSave={async item => {
      if (editor.item) await commit(saved.items.map(old => old.id === item.id ? item : old), editor.revision);
      else await commit([...saved.items, {...item, home, order: Math.max(-1,...saved.items.map(old => old.order))+1}], editor.revision);
      setEditor(undefined); setPicker(false);
    }}/>}
  </section>;
}
