import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Braces, Check, ChevronDown, FileText, ImagePlus, Network, PanelLeft, Plus, Search, Settings2 } from 'lucide-react';
import { MdGraphCanvas } from './MdGraphCanvas';
import { MdGraphOverview } from './MdGraphOverview';
import { MarkdownDocument, markdownOutline } from './MarkdownDocument';
import { MdSectionEditor } from './MdSectionEditor';
import { PageEditor, type PageEditorHandle } from './PageEditor';
import { PageMenu } from './PageMenu';
import { changePageBody, changePageTitle, pageTitle } from './pageDocument';
import { MAX_MARKDOWN_LENGTH, nodeDependencies, nodeName, parseMarkdownGraph, setNodeDependency, setNodeLink, writeMarkdownGraph, type MdDocument, type MdNode } from './markdownGraph';
import './md-presentation.css';
import './bush-page.css';

export type MdPresentationProps = {
  source: string; onChange: (source: string) => void; language: 'zh' | 'en'; flow?: boolean; readOnly?: boolean;
  icon?: (node: MdNode) => ReactNode; subtitle?: (node: MdNode) => string;
  nodeFields?: (node: MdNode, change: (patch: Partial<MdNode>) => void) => ReactNode;
  documentFields?: (document: MdDocument, change: (attributes: MdDocument['attributes']) => void) => ReactNode;
  newNodeAttributes?: Record<string, unknown>; toolbar?: ReactNode; headerActions?: ReactNode; maxNodes?: number;
};

/** The editable page is primary. Configuration, source and graphs are secondary views. */
export function MdPresentation({ source, onChange, language, flow, readOnly, icon, subtitle, nodeFields, documentFields, newNodeAttributes, toolbar, headerActions, maxNodes = 128 }: MdPresentationProps) {
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const parsed = useMemo(() => { try { return { document: parseMarkdownGraph(source), error: '' }; }
    catch (error) { return { document: null, error: String((error as Error).message) }; } }, [source]);
  const [mode, setMode] = useState<'document' | 'graph' | 'markdown'>('document'), [outlineOpen, setOutlineOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(''), [editingId, setEditingId] = useState<string>(), [query, setQuery] = useState('');
  const editors = useRef(new Map<string, PageEditorHandle>()), activeEditorId = useRef(''), workspace = useRef<HTMLElement>(null), prefix = useId().replaceAll(':', ''), sections = useRef(new Map<string, HTMLElement>());
  const document = parsed.document, activeMode = document ? mode : 'markdown', selected = document?.nodes.find(node => node.id === selectedId);
  const currentDocument = useRef(document); currentDocument.current = document;
  const activeEditor = () => editors.current.get(activeEditorId.current) ?? editors.current.get('') ?? editors.current.values().next().value;
  const article = document ? pageTitle(document) : { title: '', body: '' }, title = article.title || t('无标题页', 'Untitled page');
  const update = (value: MdDocument) => { const next = writeMarkdownGraph(value); if (next.length > MAX_MARKDOWN_LENGTH) throw Error(t('文档超过 2 MB，请减少图片或内容。', 'The document exceeds 2 MB. Reduce images or content.')); currentDocument.current = value; onChange(next); };
  const changeNode = (id: string, patch: Partial<MdNode>) => { const value = currentDocument.current; if (value) update({ ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }); };
  const scroll = (id: string) => requestAnimationFrame(() => sections.current.get(id)?.scrollIntoView({ block: 'start' }));
  const closeCompactOutline = () => { if ((workspace.current?.clientWidth || Infinity) <= 760) setOutlineOpen(false); };
  const navigate = (id: string) => { if (id && !document?.nodes.some(node => node.id === id)) return; activeEditorId.current = id; setSelectedId(id); setEditingId(undefined); setMode('document'); closeCompactOutline(); scroll(id); };
  const add = (task = false) => {
    const value = currentDocument.current;
    if (!value || value.nodes.length >= maxNodes || task && value.nodes.filter(node => 'agent_id' in node.attributes).length >= 64) return;
    const id = `section-${crypto.randomUUID().slice(0, 6)}`;
    update({ ...value, nodes: [...value.nodes, { id, attributes: { name: t(task ? '新任务' : '新章节', task ? 'New task' : 'New section'), ...(task ? newNodeAttributes : {}) }, body: '' }] });
    setSelectedId(id); setEditingId(task ? id : undefined); setMode('document'); scroll(id);
    requestAnimationFrame(() => sections.current.get(id)?.querySelector<HTMLInputElement>('.bush-section-title')?.focus());
  };
  const editor = (node?: MdNode) => document && <MdSectionEditor document={document} node={node} update={update} language={language} flow={flow}
    nodeFields={nodeFields} documentFields={documentFields} onSelect={id => { activeEditorId.current = id; setSelectedId(id); setEditingId(id || undefined); }}/>;
  const outline = markdownOutline(article.body, `${prefix}-intro`);
  const content = (id: string, body: string) => readOnly ? <div className="md-prose"><MarkdownDocument source={body} scope={`${prefix}-${id || 'intro'}`} onNavigate={navigate}/></div>
    : <PageEditor source={body} label={t(id ? '章节正文' : '页面正文', id ? 'Section content' : 'Page content')} language={language} onNavigate={navigate}
      onChange={value => { const current = currentDocument.current; if (current) id ? changeNode(id, { body: value }) : update(changePageBody(current, value)); }}
      onReady={handle => { if (handle) editors.current.set(id, handle); else editors.current.delete(id); }}
      onActive={() => { activeEditorId.current = id; }} onSection={() => add()} onTask={flow ? () => add(true) : undefined}/>;
  const configuration = (node?: MdNode) => <div className="bush-page-configuration"><div><strong>{t(node ? '章节配置' : '页面配置', node ? 'Section configuration' : 'Page configuration')}</strong>
    <button type="button" aria-label={t('完成编辑', 'Finish editing')} onClick={() => setEditingId(undefined)}><Check size={14}/>{t('完成', 'Done')}</button></div>{readOnly ? <pre>{JSON.stringify(document?.attributes, null, 2)}</pre> : editor(node)}</div>;
  return <section ref={workspace} className="md-presentation bush-page" aria-label="bush-it" data-outline={outlineOpen}>
    <div className="md-presentation-toolbar bush-page-toolbar">
      <div className="bush-page-tools"><PageMenu label={t('页面菜单', 'Page menu')} trigger={<><FileText size={16}/><span>{title}</span><ChevronDown size={13}/></>}>
        <div className="bush-page-menu-group" aria-label={t('视图', 'Views')}>
          <button type="button" aria-pressed={activeMode === 'document'} disabled={!document} onClick={() => { if (activeMode === 'graph' && selectedId) navigate(selectedId); else { setMode('document'); setEditingId(undefined); } }}><FileText size={16}/>{t('文档', 'Document')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={activeMode === 'markdown'} onClick={() => setMode('markdown')}><Braces size={16}/>Markdown<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={activeMode === 'graph'} disabled={!document} onClick={() => setMode('graph')}><Network size={16}/>{t('图谱', 'Graph')}<Check size={14} className="bush-menu-check"/></button>
        </div>
        <div className="bush-page-menu-group" aria-label={t('页面显示', 'Page display')}>
          <button type="button" aria-label={t('显示文档目录', 'Show outline')} aria-pressed={outlineOpen} disabled={!document} onClick={() => setOutlineOpen(value => !value)}><PanelLeft size={16}/>{t('文档目录', 'Outline')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={overviewOpen} disabled={!document?.nodes.length} onClick={() => setOverviewOpen(value => !value)}><Network size={16}/>{t('关系概览', 'Graph overview')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-label={t('编辑文档正文与配置', 'Edit document content and configuration')} disabled={!document} onClick={() => { setMode('document'); setEditingId(''); scroll(''); }}><Settings2 size={16}/>{t('页面配置', 'Page configuration')}</button>
        </div>
        {toolbar && <div className="bush-page-menu-group">{toolbar}</div>}
      </PageMenu>
        {!readOnly && activeMode === 'document' && <div className="bush-insert-tools"><button type="button" aria-label={t('插入图片', 'Insert image')} onMouseDown={event => event.preventDefault()} onClick={() => activeEditor()?.image()}><ImagePlus size={17}/></button>
          <button type="button" aria-label={t('插入内容', 'Insert content')} disabled={!document} onMouseDown={event => event.preventDefault()} onClick={event => activeEditor()?.insertMenu(event.currentTarget)}><Plus size={18}/></button></div>}
      </div>
      {activeMode !== 'document' && document && <button type="button" className="bush-back-to-document" onClick={() => navigate(activeMode === 'graph' ? selectedId : '')}><ArrowLeft size={15}/>{t('返回文档', 'Back to document')}</button>}
      {headerActions && <div className="bush-page-header-actions">{headerActions}</div>}
    </div>
    {parsed.error && <p className="md-error" role="alert">{parsed.error}</p>}
    <div className="md-presentation-body" data-mode={activeMode} data-readonly={readOnly || undefined} onPointerDown={event => { if (!(event.target as Element).closest('.md-node-list')) closeCompactOutline(); }}>
      <aside className="md-node-list" aria-label={t('文档目录', 'Document outline')}>
        <label className="md-node-search"><Search size={14}/><input aria-label={t('查找章节', 'Find sections')} placeholder={t('查找章节…', 'Find sections…')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <button type="button" className="md-document-item" onClick={() => activeMode === 'graph' ? setSelectedId('') : navigate('')}><FileText size={15}/>{title}</button>
        {outline.filter(item => item.label.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" className="md-heading-item" key={item.id} onClick={() => { activeEditorId.current = ''; setMode('document'); closeCompactOutline(); requestAnimationFrame(() => {
          const heading = readOnly ? window.document.getElementById(item.id) : sections.current.get('')?.querySelectorAll('.bush-page-content > h1,.bush-page-content > h2,.bush-page-content > h3,.bush-page-content > h4,.bush-page-content > h5,.bush-page-content > h6')[outline.indexOf(item)];
          heading?.scrollIntoView({ block: 'start' });
        }); }}>{item.label}</button>)}
        {document?.nodes.filter(node => `${nodeName(node)} ${node.body}`.toLowerCase().includes(query.toLowerCase())).map(node => <button type="button" key={node.id} data-outline-node={node.id} aria-pressed={selectedId === node.id} onClick={() => { if (activeMode === 'graph') { activeEditorId.current = node.id; setSelectedId(node.id); closeCompactOutline(); } else navigate(node.id); }}>{icon?.(node) ?? <FileText size={14}/>}<span>{nodeName(node)}</span></button>)}
      </aside>
      {activeMode === 'markdown' ? <div className="md-source-panel"><label htmlFor={`${prefix}-source`}>{t('Markdown 源码', 'Markdown source')}</label><textarea id={`${prefix}-source`} className="md-source" aria-label={t('Markdown 源码', 'Markdown source')} readOnly={readOnly} spellCheck={false} value={source} onChange={event => onChange(event.target.value)}/></div>
        : document && activeMode === 'document' ? <div className="md-article-scroll"><article className="md-article bush-page-article">
          <section className="md-article-introduction" ref={element => { if (element) sections.current.set('', element); else sections.current.delete(''); }}>
            {readOnly ? <h1>{title}</h1> : <textarea className="bush-page-title" rows={1} spellCheck={false} aria-label={t('页面标题', 'Page title')} placeholder={t('无标题页', 'Untitled page')} value={article.title}
              onFocus={() => { activeEditorId.current = ''; }} onChange={event => update(changePageTitle(document, event.target.value.replace(/[\r\n]+/g, ' ')))} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); editors.current.get('')?.focus(); } }}/>}
            {editingId === '' && configuration()}
            {content('', article.body)}
          </section>
          {document.nodes.map(node => <section key={node.id} className="md-article-section" data-document-section={node.id} ref={element => { if (element) sections.current.set(node.id, element); else sections.current.delete(node.id); }}>
            <header className="md-section-heading">{readOnly ? <h2>{nodeName(node)}</h2> : <input className="bush-section-title" spellCheck={false} aria-label={t('章节标题', 'Section title')} value={nodeName(node)} onFocus={() => { activeEditorId.current = node.id; }} onChange={event => changeNode(node.id, { attributes: { ...node.attributes, name: event.target.value } })}/>}
              {!readOnly && <button type="button" aria-label={`${t('编辑章节', 'Edit section')} ${nodeName(node)}`} onClick={() => { setSelectedId(node.id); setEditingId(value => value === node.id ? undefined : node.id); }}><Settings2 size={15}/></button>}</header>
            {editingId === node.id && !readOnly && configuration(node)}
            {flow && 'agent_id' in node.attributes && <div className="md-section-execution"><span>{icon?.(node)}{subtitle?.(node) || String(node.attributes.agent_id || t('待选择员工', 'Choose an agent'))}</span><span>{t('等待', 'After')} · {nodeDependencies(node).length ? nodeDependencies(node).map(id => <button key={id} type="button" className="md-wiki-link" onClick={() => navigate(id)}>{nodeName(document.nodes.find(item => item.id === id) ?? { id, attributes: {}, body: '' })}</button>) : t('可独立开始', 'Starts independently')}</span></div>}
            {content(node.id, node.body)}
          </section>)}
          {overviewOpen && <MdGraphOverview document={document} language={language} flow={flow} onOpen={() => setMode('graph')}/>}
        </article></div> : document && <>
          <MdGraphCanvas document={document} selectedId={selectedId} onSelect={setSelectedId} language={language} flow={flow} icon={icon} subtitle={subtitle} readOnly={readOnly}
            onMove={(id, position) => { const node = document.nodes.find(node => node.id === id); if (node) changeNode(id, { attributes: { ...node.attributes, position } }); }}
            onConnect={(from, to) => { const node = document.nodes.find(node => node.id === to), origin = document.nodes.find(node => node.id === from); if (node && (!flow || ('agent_id' in node.attributes && origin && 'agent_id' in origin.attributes))) changeNode(to, (flow ? setNodeDependency : setNodeLink)(node, from, true)); }}
            onLayout={positions => update({ ...document, nodes: document.nodes.map(node => ({ ...node, attributes: { ...node.attributes, position: positions.get(node.id) } })) })}/>
          {!readOnly && editor(selected)}
        </>}
    </div>
  </section>;
}
