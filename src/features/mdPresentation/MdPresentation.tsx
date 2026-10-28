import { uiText } from '../../i18n';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Braces, Check, ChevronDown, FileText, ImagePlus, Network, PanelLeft, Plus, Search, Settings2 } from 'lucide-react';
import { MdGraphCanvas } from './MdGraphCanvas';
import { MdGraphOverview } from './MdGraphOverview';
import { MarkdownDocument, markdownOutline } from './MarkdownDocument';
import { MdSectionEditor } from './MdSectionEditor';
import { PageEditor, type PageEditorHandle } from './PageEditor';
import { PageMenu } from './PageMenu';
import { MarkdownSourceEditor, type MarkdownSelection } from './MarkdownSourceEditor';
import { changePageBody, changePageTitle, pageTitle } from './pageDocument';
import { AiEditingCursor, textareaCaretRect } from './AiEditingCursor';
import { useDocumentEditIntent } from './useDocumentEditIntent';
import { decodeFragment, scrollMarkdownAnchor } from './markdownAnchors';
import { openMarkdownExternalLink } from './markdownLinkNavigation';
import { MAX_MARKDOWN_LENGTH, nodeDependencies, nodeName, parseMarkdownGraph, setNodeDependency, setNodeLink, writeMarkdownGraph, type MdDocument, type MdNode } from './markdownGraph';
import './md-presentation.css';
import './bush-page.css';

export type MarkdownAnchorRequest = { id: string; fragment: string };
export type MdPresentationProps = {
  source: string; onChange: (source: string) => void; language: string; flow?: boolean; readOnly?: boolean;
  icon?: (node: MdNode) => ReactNode; subtitle?: (node: MdNode) => string;
  nodeFields?: (node: MdNode, change: (patch: Partial<MdNode>) => void) => ReactNode;
  documentFields?: (document: MdDocument, change: (attributes: MdDocument['attributes']) => void) => ReactNode;
  newNodeAttributes?: Record<string, unknown>; toolbar?: ReactNode; headerActions?: ReactNode; maxNodes?: number;
  onSourceSelection?: (selection: MarkdownSelection) => void;
  liveEdit?: { id: string; base: string; cursor: number; state: 'streaming' | 'ready' };
  onBeforeEdit?: () => void;
  onCompositionChange?: (composing: boolean) => void;
  anchorRequest?: MarkdownAnchorRequest;
};

/** The editable page is primary. Configuration, source and graphs are secondary views. */
export function MdPresentation({ source, onChange, language, flow, readOnly, icon, subtitle, nodeFields, documentFields, newNodeAttributes, toolbar, headerActions, onSourceSelection, liveEdit, onBeforeEdit, onCompositionChange, anchorRequest, maxNodes = 128 }: MdPresentationProps) {

  const lastParsed = useRef<MdDocument | null>(null);
  const parsed = useMemo(() => { try { const document = parseMarkdownGraph(source); lastParsed.current = document; return { document, error: '' }; }
    catch (error) { return { document: liveEdit ? lastParsed.current : null, error: liveEdit ? '' : String((error as Error).message) }; } }, [source, !!liveEdit]);
  const [mode, setMode] = useState<'document' | 'graph' | 'markdown'>('document'), [outlineOpen, setOutlineOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [sourcePreview, setSourcePreview] = useState(true);
  const [linkNotice, setLinkNotice] = useState('');
  const handledAnchor = useRef('');
  const [selectedId, setSelectedId] = useState(''), [editingId, setEditingId] = useState<string>(), [query, setQuery] = useState('');
  const editors = useRef(new Map<string, PageEditorHandle>()), activeEditorId = useRef(''), workspace = useRef<HTMLElement>(null), prefix = useId().replaceAll(':', ''), sections = useRef(new Map<string, HTMLElement>());
  const prepareEdit = useDocumentEditIntent(workspace, !!liveEdit, onBeforeEdit, onCompositionChange);
  const document = parsed.document, activeMode = document ? mode : 'markdown', selected = document?.nodes.find(node => node.id === selectedId);
  // Configuration and graph actions operate on committed content, independently
  // of the temporary text animation shown in the document/source views.
  const savedSource = liveEdit?.base ?? source;
  const savedDocument = useMemo(() => { try { return parseMarkdownGraph(savedSource); } catch { return null; } }, [savedSource]);
  const currentDocument = useRef(savedDocument); currentDocument.current = savedDocument;
  const activeEditor = () => editors.current.get(activeEditorId.current) ?? editors.current.get('') ?? editors.current.values().next().value;
  const article = document ? pageTitle(document) : { title: '', body: '' }, title = article.title || uiText(language)('bushItPageStore.untitledPage');
  const titleInput = useRef<HTMLTextAreaElement>(null);
  const editNode = liveEdit && document ? [...document.nodes].reverse().find(node => {
    const start = source.indexOf(`## ${node.id}\n`); return start >= 0 && liveEdit.cursor >= start;
  }) : undefined;
  const editBody = editNode ? editNode.body : article.body;
  const editBodyStart = editBody ? source.indexOf(editBody, editNode ? Math.max(0, source.indexOf(`## ${editNode.id}\n`)) : 0) : source.length;
  const editingTitle = !!liveEdit && !editNode && (liveEdit.cursor < editBodyStart || !!article.title && liveEdit.cursor <= source.indexOf(article.title) + article.title.length);
  const bodyEdit = (id: string) => liveEdit && !editingTitle && id === (editNode?.id ?? '') && editBodyStart >= 0
    ? { cursor: Math.max(0, Math.min(editBody.length, liveEdit.cursor - editBodyStart)), state: liveEdit.state } : undefined;
  const update = (value: MdDocument) => { const next = writeMarkdownGraph(value); if (next.length > MAX_MARKDOWN_LENGTH) throw Error(uiText(language)('mdPresentation.theDocumentExceeds2MbReduceImages')); currentDocument.current = value; onChange(next); };
  const changeNode = (id: string, patch: Partial<MdNode>) => { prepareEdit(); const value = currentDocument.current; if (value) update({ ...value, nodes: value.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }); };
  const scroll = (id: string) => requestAnimationFrame(() => sections.current.get(id)?.scrollIntoView({ block: 'start' }));
  const closeCompactOutline = () => { if ((workspace.current?.clientWidth || Infinity) <= 760) setOutlineOpen(false); };
  const navigate = (id: string) => { if (id && !document?.nodes.some(node => node.id === id)) return; activeEditorId.current = id; setSelectedId(id); setEditingId(undefined); setMode('document'); closeCompactOutline(); scroll(id); };
  const followAnchor = (fragment: string) => {
    setLinkNotice('');
    if (fragment.startsWith('#md-node=')) { navigate(decodeFragment(fragment.slice(9))); return; }
    const root = workspace.current?.querySelector<HTMLElement>(activeMode === 'markdown' ? '.creation-source-preview' : '.bush-page-article');
    if (!scrollMarkdownAnchor(root, fragment)) setLinkNotice(uiText(language)('mdPresentation.headingNotFound') + decodeFragment(fragment.replace(/^#/, '')));
  };
  useEffect(() => {
    if (!anchorRequest || handledAnchor.current === anchorRequest.id) return;
    if (activeMode === 'graph') { setMode('document'); return; }
    if (activeMode === 'markdown' && !sourcePreview) { setSourcePreview(true); return; }
    const frame = requestAnimationFrame(() => { handledAnchor.current = anchorRequest.id; followAnchor(anchorRequest.fragment); });
    return () => cancelAnimationFrame(frame);
  }, [anchorRequest, activeMode, sourcePreview]);
  const add = (task = false) => {
    prepareEdit();
    const value = currentDocument.current;
    if (!value || value.nodes.length >= maxNodes || task && value.nodes.filter(node => 'agent_id' in node.attributes).length >= 64) return;
    const id = `section-${crypto.randomUUID().slice(0, 6)}`;
    update({ ...value, nodes: [...value.nodes, { id, attributes: { name: (task ? uiText(language)('mdPresentation.newTask') : uiText(language)('mdPresentation.newSection')), ...(task ? newNodeAttributes : {}) }, body: '' }] });
    setSelectedId(id); setEditingId(task ? id : undefined); setMode('document'); scroll(id);
    requestAnimationFrame(() => sections.current.get(id)?.querySelector<HTMLInputElement>('.bush-section-title')?.focus());
  };
  const editor = (node?: MdNode) => savedDocument && <MdSectionEditor document={savedDocument} node={node && savedDocument.nodes.find(item => item.id === node.id)} update={update} language={language} flow={flow}
    nodeFields={nodeFields} documentFields={documentFields} onSelect={id => { activeEditorId.current = id; setSelectedId(id); setEditingId(id || undefined); }}/>;
  const outline = markdownOutline(article.body, `${prefix}-intro`);
  const content = (id: string, body: string) => readOnly ? <div className="md-prose"><MarkdownDocument source={body} scope={`${prefix}-${id || 'intro'}`} onNavigate={navigate} language={language}/></div>
    : <PageEditor source={body} label={(id ? uiText(language)('mdPresentation.sectionContent') : uiText(language)('mdPresentation.pageContent'))} language={language} onNavigate={navigate}
      aiEdit={bodyEdit(id)} previewing={!!liveEdit} onBeforeEdit={prepareEdit}
      onChange={value => { const current = currentDocument.current; if (current) id ? changeNode(id, { body: value }) : update(changePageBody(current, value)); }}
      onReady={handle => { if (handle) editors.current.set(id, handle); else editors.current.delete(id); }}
      onActive={() => { activeEditorId.current = id; }} onSection={() => add()} onTask={flow ? () => add(true) : undefined}/>;
  const configuration = (node?: MdNode) => <div className="bush-page-configuration"><div><strong>{(node ? uiText(language)('mdPresentation.sectionConfiguration') : uiText(language)('mdPresentation.pageConfiguration'))}</strong>
    <button type="button" aria-label={uiText(language)('mdPresentation.finishEditing')} onClick={() => setEditingId(undefined)}><Check size={14}/>{uiText(language)('composerLayoutSettings.done')}</button></div>{readOnly ? <pre>{JSON.stringify(document?.attributes, null, 2)}</pre> : editor(node)}</div>;
  return <section ref={workspace} className="md-presentation bush-page" aria-label={uiText(language)('appCenterModel.create')} data-outline={outlineOpen} data-ai-editing={!!liveEdit}
    onClickCapture={event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
      if (!anchor || !workspace.current?.contains(anchor) || event.button !== 0) return;
      const href = anchor.getAttribute('href') ?? '';
      event.preventDefault(); event.stopPropagation();
      if (href.startsWith('#')) { followAnchor(href); return; }
      setLinkNotice('');
      void openMarkdownExternalLink(href, anchor.textContent ?? '').then(opened => {
        if (!opened) setLinkNotice(uiText(language)('mdPresentation.unableToOpenLink') + href);
      }).catch(error => setLinkNotice(String((error as Error).message)));
    }}
    onKeyDownCapture={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLAnchorElement) {
        event.preventDefault(); event.stopPropagation(); event.target.click();
      }
    }}>
    <div className="md-presentation-toolbar bush-page-toolbar">
      <div className="bush-page-tools"><PageMenu label={uiText(language)('mdPresentation.pageMenu')} trigger={<><FileText size={16}/><span>{title}</span><ChevronDown size={13}/></>}>
        <div className="bush-page-menu-group" aria-label={uiText(language)('mdPresentation.views')}>
          <button type="button" aria-pressed={activeMode === 'document'} disabled={!document} onClick={() => { if (activeMode === 'graph' && selectedId) navigate(selectedId); else { setMode('document'); setEditingId(undefined); } }}><FileText size={16}/>{uiText(language)('mdPresentation.document')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={activeMode === 'markdown'} onClick={() => setMode('markdown')}><Braces size={16}/>{uiText(language)('mdPresentation.markdown')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={activeMode === 'graph'} disabled={!document} onClick={() => setMode('graph')}><Network size={16}/>{uiText(language)('mdPresentation.graph')}<Check size={14} className="bush-menu-check"/></button>
        </div>
        <div className="bush-page-menu-group" aria-label={uiText(language)('mdPresentation.pageDisplay')}>
          <button type="button" aria-label={uiText(language)('mdPresentation.showOutline')} aria-pressed={outlineOpen} disabled={!document} onClick={() => setOutlineOpen(value => !value)}><PanelLeft size={16}/>{uiText(language)('mdPresentation.outline')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-pressed={overviewOpen} disabled={!document?.nodes.length} onClick={() => setOverviewOpen(value => !value)}><Network size={16}/>{uiText(language)('mdPresentation.graphOverview')}<Check size={14} className="bush-menu-check"/></button>
          <button type="button" aria-label={uiText(language)('mdPresentation.editDocumentContentAndConfiguration')} disabled={!document} onClick={() => { setMode('document'); setEditingId(''); scroll(''); }}><Settings2 size={16}/>{uiText(language)('mdPresentation.pageConfiguration')}</button>
        </div>
        {toolbar && <div className="bush-page-menu-group">{toolbar}</div>}
      </PageMenu>
        {!readOnly && activeMode === 'document' && <div className="bush-insert-tools"><button type="button" aria-label={uiText(language)('mdPresentation.insertImage')} onMouseDown={event => event.preventDefault()} onClick={() => activeEditor()?.image()}><ImagePlus size={17}/></button>
          <button type="button" aria-label={uiText(language)('mdPresentation.insertContent')} disabled={!document} onMouseDown={event => event.preventDefault()} onClick={event => activeEditor()?.insertMenu(event.currentTarget)}><Plus size={18}/></button></div>}
      </div>
      <div className="md-view-switch creation-view-switch" aria-label={uiText(language)('mdPresentation.editorView')}>
        <button type="button" disabled={!document} aria-pressed={activeMode === 'document'} onClick={() => setMode('document')}>{uiText(language)('mdPresentation.document')}</button>
        <button type="button" aria-pressed={activeMode === 'markdown'} onClick={() => setMode('markdown')}>{uiText(language)('mdPresentation.markdown')}</button>
      </div>
      {headerActions && <div className="bush-page-header-actions">{headerActions}</div>}
    </div>
    {parsed.error && <p className="md-error" role="alert">{parsed.error}</p>}
    {linkNotice && <p className="md-link-notice" role="status">{linkNotice}</p>}
    <div className="md-presentation-body" data-mode={activeMode} data-readonly={readOnly || undefined} onPointerDown={event => { if (!(event.target as Element).closest('.md-node-list')) closeCompactOutline(); }}>
      <aside className="md-node-list" aria-label={uiText(language)('mdPresentation.documentOutline')}>
        <label className="md-node-search"><Search size={14}/><input aria-label={uiText(language)('mdPresentation.findSections')} placeholder={uiText(language)('mdPresentation.findSections_6e67e69')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <button type="button" className="md-document-item" onClick={() => activeMode === 'graph' ? setSelectedId('') : navigate('')}><FileText size={15}/>{title}</button>
        {outline.filter(item => item.label.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" className="md-heading-item" key={item.id} onClick={() => { activeEditorId.current = ''; setMode('document'); closeCompactOutline(); requestAnimationFrame(() => {
          const heading = readOnly ? sections.current.get('')?.querySelector(`[id="${item.id}"]`) : sections.current.get('')?.querySelectorAll('.bush-page-content :is(h1,h2,h3,h4,h5,h6)')[outline.indexOf(item)];
          heading?.scrollIntoView({ block: 'start' });
        }); }}>{item.label}</button>)}
        {document?.nodes.filter(node => `${nodeName(node)} ${node.body}`.toLowerCase().includes(query.toLowerCase())).map(node => <button type="button" key={node.id} data-outline-node={node.id} aria-pressed={selectedId === node.id} onClick={() => { if (activeMode === 'graph') { activeEditorId.current = node.id; setSelectedId(node.id); closeCompactOutline(); } else navigate(node.id); }}>{icon?.(node) ?? <FileText size={14}/>}<span>{nodeName(node)}</span></button>)}
      </aside>
      {activeMode === 'markdown' ? <div className="creation-markdown-panel">
        <div className="creation-preview-toggle"><button type="button" aria-pressed={sourcePreview} onClick={() => setSourcePreview(value => !value)}>{uiText(language)('mdPresentation.livePreview')}</button></div>
        <div className="creation-markdown-panes" data-preview={sourcePreview}>
          <MarkdownSourceEditor source={source} onChange={onChange} onSelection={onSourceSelection} readOnly={readOnly} language={language} aiEdit={liveEdit}/>
          {sourcePreview && <div className="creation-source-preview md-prose" aria-label={uiText(language)('mdPresentation.markdownPreview')}><MarkdownDocument source={source} scope={`${prefix}-preview`} onNavigate={navigate} language={language}/></div>}
        </div>
      </div>
        : document && activeMode === 'document' ? <div className="md-article-scroll"><article className="md-article bush-page-article">
          <section className="md-article-introduction" ref={element => { if (element) sections.current.set('', element); else sections.current.delete(''); }}>
            {readOnly ? <h1>{title}</h1> : <textarea ref={titleInput} className="bush-page-title" rows={1} spellCheck={false} aria-label={uiText(language)('mdPresentation.pageTitle')} placeholder={uiText(language)('bushItPageStore.untitledPage')} value={article.title}
              onFocus={() => { activeEditorId.current = ''; }} onChange={event => update(changePageTitle(document, event.target.value.replace(/[\r\n]+/g, ' ')))} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); editors.current.get('')?.focus(); } }}/>}
            {editingId === '' && configuration()}
            {content('', article.body)}
            {editingTitle && liveEdit && <AiEditingCursor language={language} state={liveEdit.state} revision={source} surface={() => titleInput.current}
              locate={() => textareaCaretRect(titleInput.current, Math.max(0, liveEdit.cursor - source.indexOf(article.title)))}/>}
          </section>
          {document.nodes.map(node => <section key={node.id} className="md-article-section" data-document-section={node.id} ref={element => { if (element) sections.current.set(node.id, element); else sections.current.delete(node.id); }}>
            <header className="md-section-heading">{readOnly ? <h2>{nodeName(node)}</h2> : <input className="bush-section-title" spellCheck={false} aria-label={uiText(language)('mdPresentation.sectionTitle')} value={nodeName(node)} onFocus={() => { activeEditorId.current = node.id; }} onChange={event => changeNode(node.id, { attributes: { ...node.attributes, name: event.target.value } })}/>}
              {!readOnly && <button type="button" aria-label={`${uiText(language)('mdPresentation.editSection')} ${nodeName(node)}`} onClick={() => { setSelectedId(node.id); setEditingId(value => value === node.id ? undefined : node.id); }}><Settings2 size={15}/></button>}</header>
            {editingId === node.id && !readOnly && configuration(node)}
            {flow && 'agent_id' in node.attributes && <div className="md-section-execution"><span>{icon?.(node)}{subtitle?.(node) || String(node.attributes.agent_id || uiText(language)('mdPresentation.chooseAnAgent'))}</span><span>{uiText(language)('mdPresentation.after')} · {nodeDependencies(node).length ? nodeDependencies(node).map(id => <button key={id} type="button" className="md-wiki-link" onClick={() => navigate(id)}>{nodeName(document.nodes.find(item => item.id === id) ?? { id, attributes: {}, body: '' })}</button>) : uiText(language)('mdPresentation.startsIndependently')}</span></div>}
            {content(node.id, node.body)}
          </section>)}
          {overviewOpen && <MdGraphOverview document={document} language={language} flow={flow} onOpen={() => setMode('graph')}/>}
        </article></div> : savedDocument && <>
          <MdGraphCanvas document={savedDocument} selectedId={selectedId} onSelect={setSelectedId} language={language} flow={flow} icon={icon} subtitle={subtitle} readOnly={readOnly}
            onMove={(id, position) => { const node = savedDocument.nodes.find(node => node.id === id); if (node) changeNode(id, { attributes: { ...node.attributes, position } }); }}
            onConnect={(from, to) => { const node = savedDocument.nodes.find(node => node.id === to), origin = savedDocument.nodes.find(node => node.id === from); if (node && (!flow || ('agent_id' in node.attributes && origin && 'agent_id' in origin.attributes))) changeNode(to, (flow ? setNodeDependency : setNodeLink)(node, from, true)); }}
            onLayout={positions => update({ ...savedDocument, nodes: savedDocument.nodes.map(node => ({ ...node, attributes: { ...node.attributes, position: positions.get(node.id) } })) })}/>
          {!readOnly && editor(selected)}
        </>}
    </div>
  </section>;
}
