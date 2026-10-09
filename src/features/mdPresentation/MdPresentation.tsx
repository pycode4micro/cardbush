import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Braces, Check, ChevronRight, FileText, Link2, Network, Plus, Search, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MdGraphCanvas } from './MdGraphCanvas';
import { mapWikiLinks, nodeLinks, nodeName, parseMarkdownGraph, removeNode, renameNode, setNodeLink, writeMarkdownGraph, type MdDocument, type MdNode } from './markdownGraph';
import './md-presentation.css';

export type MdPresentationProps = {
  source: string; onChange: (source: string) => void; language: 'zh' | 'en'; flow?: boolean;
  icon?: (node: MdNode) => ReactNode; subtitle?: (node: MdNode) => string;
  nodeFields?: (node: MdNode, change: (patch: Partial<MdNode>) => void) => ReactNode;
  documentFields?: (document: MdDocument, change: (attributes: MdDocument['attributes']) => void) => ReactNode;
  newNodeAttributes?: Record<string, unknown>; toolbar?: ReactNode; maxNodes?: number;
};

/** Shared Markdown graph and editor. Team supplies only domain fields and validation. */
export function MdPresentation({ source, onChange, language, flow, icon, subtitle, nodeFields, documentFields, newNodeAttributes, toolbar, maxNodes = 128 }: MdPresentationProps) {
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const parsed = useMemo(() => { try { return { document: parseMarkdownGraph(source), error: '' }; } catch (error) { return { document: null, error: String(error instanceof Error ? error.message : error) }; } }, [source]);
  const [mode, setMode] = useState<'graph' | 'markdown'>('graph'), [selectedId, setSelectedId] = useState('__initial__'), [query, setQuery] = useState('');
  const [preview, setPreview] = useState(false), [localError, setLocalError] = useState(''), [renaming, setRenaming] = useState('');
  const document = parsed.document, selected = document?.nodes.find(node => node.id === selectedId);
  useEffect(() => { if (document && selectedId && !document.nodes.some(node => node.id === selectedId)) setSelectedId(document.nodes[0]?.id || ''); }, [document, selectedId]);
  useEffect(() => { setRenaming(selectedId); setLocalError(''); }, [selectedId]);
  const update = (value: MdDocument) => { setLocalError(''); onChange(writeMarkdownGraph(value)); };
  const changeNode = (id: string, patch: Partial<MdNode>) => { if (document) update({ ...document, nodes: document.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }); };
  const add = () => { if (!document) return; const id = `node-${crypto.randomUUID().slice(0, 6)}`;
    update({ ...document, nodes: [...document.nodes, { id, attributes: { name: t('新节点', 'New node'), ...newNodeAttributes }, body: '' }] }); setSelectedId(id); setMode('graph'); setPreview(false);
  };
  const select = (id: string) => { setSelectedId(id); setPreview(false); };
  return <section className="md-presentation">
    <div className="md-presentation-toolbar"><div className="md-view-switch" aria-label={t('显示方式', 'View')}><button type="button" aria-pressed={mode === 'graph'} disabled={!document} onClick={() => setMode('graph')}><Network size={15}/>{t('图谱', 'Graph')}</button><button type="button" aria-pressed={mode === 'markdown' || !document} onClick={() => setMode('markdown')}><Braces size={15}/>Markdown</button></div>
      <button type="button" disabled={!document || document.nodes.length >= maxNodes} onClick={add}><Plus size={15}/>{t('添加节点', 'Add node')}</button><button type="button" disabled={!document} aria-label={t('文档设置', 'Document settings')} onClick={() => { setSelectedId(''); setMode('graph'); }}><FileText size={15}/></button><div className="md-toolbar-extra">{toolbar}</div>
    </div>
    {(parsed.error || localError) && <p className="md-error" role="alert">{parsed.error || localError}</p>}
    <div className="md-presentation-body" data-mode={mode === 'markdown' || !document ? 'markdown' : 'graph'}>
      <aside className="md-node-list"><label className="md-node-search"><Search size={14}/><input aria-label={t('查找节点', 'Find nodes')} placeholder={t('查找节点…', 'Find nodes…')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <button type="button" className="md-document-item" aria-pressed={!selectedId} onClick={() => { setSelectedId(''); setMode('graph'); }}><FileText size={16}/>{t('文档设置', 'Document')}</button>
        {document?.nodes.filter(node => `${nodeName(node)} ${node.id}`.toLowerCase().includes(query.toLowerCase())).map(node => <button type="button" key={node.id} data-outline-node={node.id} aria-pressed={selectedId === node.id} onClick={() => { select(node.id); setMode('graph'); }}>
          {icon?.(node) ?? <FileText size={15}/>}<span>{nodeName(node)}<small>{subtitle?.(node) || node.id}</small></span><ChevronRight size={12}/></button>)}
        <details className="md-help"><summary>{t('Markdown 如何连接节点', 'Linking nodes in Markdown')}</summary><p>{t('每个二级标题后跟 md-node 元数据块，即为一个节点。通过 [[#节点ID]] 引用其他节点；代码中的示例不会建立链接。', 'A level-two heading followed by md-node metadata defines a node. Link with [[#node-id]]; code examples do not create links.')}</p><p>{t('拖动节点调整位置；点击节点右侧圆点，再点击目标节点来连线。Alt + 方向键也可移动节点。', 'Drag to position nodes. Click an output port, then the destination node to link them. Alt + arrow keys also move nodes.')}</p>{flow && <p>{t('箭头指向等待方；无依赖节点可并行开始。保存流程前会检查员工和循环依赖。', 'Arrows point to the dependent node. Nodes without prerequisites can run in parallel. Saving validates agents and cycles.')}</p>}</details>
      </aside>
      {mode === 'markdown' || !document ? <div className="md-source-panel"><label htmlFor="md-document-source">{t('编辑完整 Markdown · 图谱与正文同步', 'Edit Markdown · graph and text stay in sync')}</label><textarea id="md-document-source" className="md-source" aria-label={t('Markdown 源码', 'Markdown source')} spellCheck={false} value={source} onChange={event => onChange(event.target.value)}/></div> : <>
        <MdGraphCanvas document={document} selectedId={selectedId} onSelect={select} language={language} flow={flow} icon={icon} subtitle={subtitle}
          onMove={(id, position) => { const node = document.nodes.find(node => node.id === id); if (node) changeNode(id, { attributes: { ...node.attributes, position } }); }}
          onConnect={(from, to) => { const node = document.nodes.find(node => node.id === to); if (node) changeNode(to, setNodeLink(node, from, true)); }}
          onLayout={positions => update({ ...document, nodes: document.nodes.map(node => ({ ...node, attributes: { ...node.attributes, position: positions.get(node.id) } })) })}/>
        <aside className="md-node-editor">{selected ? <>
          <header><span className="md-editor-kicker">{t('节点', 'Node')} / {subtitle?.(selected) || selected.id}</span><h3>{nodeName(selected)}</h3></header>
          <label>{t('节点名称', 'Node name')}<input value={nodeName(selected)} onChange={event => changeNode(selected.id, { attributes: { ...selected.attributes, name: event.target.value } })}/></label>
          <label>{t('节点 ID', 'Node ID')}<span className="md-id-field"><input value={renaming} onChange={event => setRenaming(event.target.value)} /><button type="button" disabled={renaming === selectedId} aria-label={t('修改节点 ID 并更新链接', 'Rename node and update links')} onClick={() => { try { update(renameNode(document, selectedId, renaming.trim())); setSelectedId(renaming.trim()); } catch (error) { setLocalError(String((error as Error).message)); } }}><Check size={14}/></button></span></label>
          {nodeFields?.(selected, patch => changeNode(selected.id, patch))}
          <div className="md-editor-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>{t('编辑', 'Edit')}</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>{t('预览', 'Preview')}</button></div>
          {preview ? <div className="md-node-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => href?.startsWith('#md-node=') ? <button type="button" className="md-wiki-link" onClick={() => { const id = decodeURIComponent(href.slice(9)); if (document.nodes.some(node => node.id === id)) select(id); }}>{children}</button> : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{mapWikiLinks(selected.body, (id, label) => `[${label.replaceAll('[', '\\[').replaceAll(']', '\\]')}](#md-node=${encodeURIComponent(id)})`)}</ReactMarkdown></div>
            : <label>{t(flow ? '任务内容' : '内容', flow ? 'Assignment' : 'Content')}<textarea rows={9} aria-label={t(flow ? '任务内容' : '节点内容', flow ? 'Assignment' : 'Node content')} value={selected.body} onChange={event => changeNode(selected.id, { body: event.target.value })}/></label>}
          <div className="md-node-links"><h4><Link2 size={14}/>{t(flow ? '等待以下节点' : '引用节点', flow ? 'Prerequisites' : 'Linked nodes')}</h4>
            {document.nodes.filter(node => node.id !== selected.id).map(node => <label key={node.id} className="md-link-choice"><input type="checkbox" checked={nodeLinks(selected).includes(node.id)} onChange={event => changeNode(selected.id, setNodeLink(selected, node.id, event.target.checked))}/><span>{nodeName(node)}</span></label>)}
            {document.nodes.length < 2 && <p>{t('添加另一个节点即可连线。', 'Add another node to create a link.')}</p>}
          </div>
          <button type="button" className="md-delete-node" onClick={() => update(removeNode(document, selected.id))}><Trash2 size={14}/>{t('移除节点', 'Remove node')}</button>
        </> : <><header><span className="md-editor-kicker">md演示</span><h3>{t('文档设置', 'Document')}</h3></header>{documentFields?.(document, attributes => update({ ...document, attributes })) ?? <label>{t('文档名称', 'Document name')}<input value={String(document.attributes.name || '')} onChange={event => update({ ...document, attributes: { ...document.attributes, name: event.target.value } })}/></label>}
          <div className="md-editor-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>{t('编辑', 'Edit')}</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>{t('预览', 'Preview')}</button></div>
          {preview ? <div className="md-node-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{document.introduction}</ReactMarkdown></div> : <label>{t('文档说明', 'Introduction')}<textarea rows={6} value={document.introduction} onChange={event => update({ ...document, introduction: event.target.value })}/></label>}</>}</aside>
      </>}
    </div>
  </section>;
}
