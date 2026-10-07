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
import './components.css';

export function ComponentsApp({ language }: { language: AppLanguage }) {
  const zh = language === 'zh', saved = useComponents();
  const [editing, setEditing] = useState(false), [adding, setAdding] = useState(false), [error, setError] = useState('');
  const commit = (next: ComponentCollection) => {
    try { saveComponents(next, next.revision); setError(''); return true; }
    catch (cause) { setError(String(cause).includes('REVISION_CONFLICT')
      ? zh ? '配置已在其他窗口更新，请重试。' : 'Configuration changed in another window. Please retry.'
      : zh ? '无法保存组件，请检查存储空间。' : 'Unable to save components. Check available storage.'); return false; }
  };
  if (editing) return <WelcomeLayoutEditor collection={saved} language={language} onClose={() => setEditing(false)}/>;
  return <div className="components-app">
    <header><div className="components-heading"><strong>{zh ? '组件' : 'Components'}</strong><span>{zh ? '选择组件，编排你的新会话页面。' : 'Choose components and arrange your new conversation page.'}</span></div><div>
      <button type="button" onClick={() => setEditing(true)}>{zh ? '编辑布局' : 'Edit layout'}</button>
      <button type="button" onClick={() => setAdding(true)}><Plus size={15}/>{zh ? '自定义组件' : 'Custom component'}</button>
    </div></header>
    {error && <p role="alert">{error}</p>}
    <div className="components-grid">
      {saved.items.map(item => <article key={item.id} data-component-id={item.id} data-builtin={isBuiltinComponent(item) ? item.builtin : undefined} className="html-component-card"
        style={{ '--component-width': item.width, '--component-height': item.height + 'px', order: item.order } as CSSProperties}>
        <div className="html-component-content">{isBuiltinComponent(item)
          ? <BuiltinComponentSurface component={item} language={language}/>
          : <HtmlComponentSurface component={item}/>}</div>
        <header><span className="component-card-title">{componentTitle(item, language)}</span>
          {isBuiltinComponent(item) && item.builtin === 'input' && <div className="component-input-choices" role="group" aria-label={zh ? '输入框样式' : 'Composer style'}>
            {(['standard', 'simple'] as const).map(style => <button key={style} type="button" aria-pressed={(item.inputStyle ?? 'standard') === style}
              onClick={() => commit({ ...saved, items: saved.items.map(current => current.id === item.id ? { ...item, inputStyle: style } : current) })}>
              {style === 'standard' ? zh ? '标准' : 'Standard' : zh ? '精简' : 'Simple'}
            </button>)}
          </div>}
          {isBuiltinComponent(item) && item.builtin === 'input' && <ComposerLayoutSettings language={language} flow={item.composerFlow}
            onChange={composerFlow => commit({ ...saved, items: saved.items.map(current => current.id === item.id ? { ...item, composerFlow } : current) })}/>}
          {isBuiltinComponent(item) ? <span className="component-builtin-label">{zh ? '内置' : 'Built-in'}</span>
            : <button type="button" title={zh ? '移除组件' : 'Remove component'} onClick={() => commit({ ...saved, items: saved.items.filter(current => current.id !== item.id) })}><Trash2 size={14}/></button>}
        </header>
      </article>)}
    </div>
    {adding && <ComponentImport language={language} onClose={() => setAdding(false)} onAdd={component => {
      if (saved.items.filter(item => !isBuiltinComponent(item)).length >= 12) throw new Error(zh ? '最多接入 12 个自定义组件' : 'Up to 12 custom components are supported');
      if (!commit({ ...saved, items: [...saved.items, { ...component, order: Math.max(0, ...saved.items.map(item => item.order)) + 1 }] })) throw new Error(zh ? '保存失败' : 'Save failed');
      setAdding(false);
    }}/>}
  </div>;
}

function ComponentImport({ language, onClose, onAdd }: { language: AppLanguage; onClose: () => void; onAdd: (component: HtmlComponent) => void }) {
  const zh = language === 'zh', dialog = useRef<HTMLDialogElement>(null), [title, setTitle] = useState(''), [html, setHtml] = useState(''), [allowActions, setAllowActions] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close(); }, []);
  return <dialog className="inspector-page-dialog component-import" ref={dialog} aria-label={zh ? '自定义组件' : 'Custom component'} onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => { event.preventDefault(); try {
      if (!title.trim() || !html.trim()) throw new Error(zh ? '请填写名称和 HTML 内容' : 'Enter a name and HTML content');
      if (new TextEncoder().encode(html).length > maxComponentBytes) throw new Error(zh ? 'HTML 内容不能超过 256 KiB' : 'HTML must not exceed 256 KiB');
      onAdd({ id: componentId(), title: title.trim().slice(0, 80), html, allowActions, width: 6, height: 280, order: 0 });
    } catch (cause) { setError(String(cause)); } }}>
      <div className="component-import-heading"><h2>{zh ? '自定义组件' : 'Custom component'}</h2><button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X size={15}/></button></div>
      <label>{zh ? '名称' : 'Name'}<input autoFocus value={title} maxLength={80} onChange={event => setTitle(event.target.value)}/></label>
      <label>{zh ? 'HTML 或组件包' : 'HTML or component package'}<input type="file" accept=".html,.htm,.json" onChange={async event => {
        const file = event.target.files?.[0]; if (!file) return;
        try { if (file.size > maxComponentBytes * 2) throw new Error(zh ? '文件过大' : 'File is too large'); const text = await file.text();
          if (/\.json$/i.test(file.name)) { const data = JSON.parse(text); if (data.protocol !== componentProtocol || typeof data.html !== 'string') throw new Error(zh ? '组件包协议不兼容' : 'Unsupported component package'); setHtml(data.html); setTitle(String(data.title || file.name).slice(0, 80)); }
          else { setHtml(text); setTitle(file.name.replace(/\.html?$/i, '')); } setError('');
        } catch (cause) { setError(String(cause)); }
      }}/></label>
      <label>HTML<textarea value={html} onChange={event => setHtml(event.target.value)} spellCheck={false} rows={7} placeholder="<main>...</main>"/></label>
      <small>{zh ? '支持内联 CSS、JavaScript 与 data 图片。界面使用 --cb-* 主题变量，事件通过 cardbush 接口连接。' : 'Supports inline CSS, JavaScript and data images. Use --cb-* theme variables and the cardbush event/action API.'}</small>
      <label className="component-action-grant"><input type="checkbox" checked={allowActions} onChange={event => setAllowActions(event.target.checked)}/><span>{zh ? '允许调用会话和浏览器动作（可能消耗 Token）' : 'Allow conversation and browser actions (may use tokens)'}</span></label>
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="submit">{zh ? '添加组件' : 'Add component'}</button></footer>
    </form>
  </dialog>;
}
