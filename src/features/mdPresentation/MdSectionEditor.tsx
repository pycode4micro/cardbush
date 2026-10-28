import { uiText } from '../../i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Link2, Trash2 } from 'lucide-react';
import { MarkdownDocument } from './MarkdownDocument';
import { nodeDependencies, nodeLinks, nodeName, removeNode, renameNode, setNodeDependency, setNodeLink, type MdDocument, type MdNode } from './markdownGraph';

export function MdSectionEditor({ document, node, update, language, flow, nodeFields, documentFields, onSelect }: {
  document: MdDocument; node?: MdNode; update: (document: MdDocument) => void; language: string; flow?: boolean;
  nodeFields?: (node: MdNode, change: (patch: Partial<MdNode>) => void) => ReactNode;
  documentFields?: (document: MdDocument, change: (attributes: MdDocument['attributes']) => void) => ReactNode;
  onSelect: (id: string) => void;
}) {

  const [renaming, setRenaming] = useState(node?.id || ''), [preview, setPreview] = useState(false), [error, setError] = useState('');
  useEffect(() => { setRenaming(node?.id || ''); setError(''); setPreview(false); }, [node?.id]);
  const change = (patch: Partial<MdNode>) => { if (node) update({ ...document, nodes: document.nodes.map(item => item.id === node.id ? { ...item, ...patch } : item) }); };
  const task = flow && node && 'agent_id' in node.attributes;
  return <div className="md-node-editor">
    {node ? <>
      <label>{uiText(language)('mdSectionEditor.sectionTitle')}<input value={nodeName(node)} onChange={event => change({ attributes: { ...node.attributes, name: event.target.value } })}/></label>
      <details className="md-advanced-settings"><summary>{uiText(language)('mdSectionEditor.identityAndConfiguration')}</summary>
        <label>{uiText(language)('mdSectionEditor.sectionId')}<span className="md-id-field"><input value={renaming} onChange={event => setRenaming(event.target.value)}/><button type="button" disabled={renaming === node.id} aria-label={uiText(language)('mdSectionEditor.renameSectionAndUpdateReferences')} onClick={() => {
          try { update(renameNode(document, node.id, renaming.trim())); onSelect(renaming.trim()); } catch (caught) { setError(String((caught as Error).message)); }
        }}><Check size={14}/></button></span></label>
      </details>
      {nodeFields?.(node, change)}
    </> : <>
      <label>{uiText(language)('mdSectionEditor.documentName')}<input value={String(document.attributes.name || '')} onChange={event => update({ ...document, attributes: { ...document.attributes, name: event.target.value } })}/></label>
      {documentFields?.(document, attributes => update({ ...document, attributes }))}
    </>}
    {error && <p role="alert" className="md-error">{error}</p>}
    <div className="md-editor-tabs"><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>{uiText(language)('common.edit')}</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>{uiText(language)('inlineHtmlPreview.preview')}</button></div>
    {preview ? <div className="md-node-preview"><MarkdownDocument source={node?.body ?? document.introduction} scope="section-preview" onNavigate={onSelect} language={language}/></div>
      : <label>{(node ? (task ? uiText(language)('mdSectionEditor.assignment') : uiText(language)('mdPresentation.sectionContent')) : uiText(language)('mdSectionEditor.documentContent'))}<textarea rows={10} aria-label={(node ? (task ? uiText(language)('mdSectionEditor.assignment') : uiText(language)('mdPresentation.sectionContent')) : uiText(language)('mdSectionEditor.documentContent'))} value={node?.body ?? document.introduction}
        onChange={event => node ? change({ body: event.target.value }) : update({ ...document, introduction: event.target.value })}/></label>}
    {node && <>
      <div className="md-node-links"><h4><Link2 size={14}/>{(task ? uiText(language)('mdSectionEditor.prerequisites') : uiText(language)('mdSectionEditor.references'))}</h4>
        {document.nodes.filter(item => item.id !== node.id && (!task || 'agent_id' in item.attributes)).map(item => <label key={item.id} className="md-link-choice"><input type="checkbox" checked={(task ? nodeDependencies(node) : nodeLinks(node)).includes(item.id)}
          onChange={event => change((task ? setNodeDependency : setNodeLink)(node, item.id, event.target.checked))}/><span>{nodeName(item)}</span></label>)}
        {document.nodes.length < 2 && <p>{uiText(language)('mdSectionEditor.addASectionToCreateAReference')}</p>}
      </div>
      <button type="button" className="md-delete-node" onClick={() => { update(removeNode(document, node.id)); onSelect(''); }}><Trash2 size={14}/>{uiText(language)('mdSectionEditor.deleteSection')}</button>
    </>}
  </div>;
}
