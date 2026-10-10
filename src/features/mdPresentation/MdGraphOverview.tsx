import { Network } from 'lucide-react';
import { graphLinks, layoutNodes, nodeDependencies, nodeName, nodePosition, type MdDocument } from './markdownGraph';

/** A quiet overview of the article. The full canvas is an explicit secondary view. */
export function MdGraphOverview({ document, flow, onOpen, language }: { document: MdDocument; flow?: boolean; onOpen: () => void; language: 'zh' | 'en' }) {
  if (!document.nodes.length) return null;
  const layout = layoutNodes(document.nodes, flow);
  const points = new Map(document.nodes.map(node => [node.id, nodePosition(node) ?? layout.get(node.id)!]));
  const values = [...points.values()], x = Math.min(...values.map(point => point.x)) - 24, y = Math.min(...values.map(point => point.y)) - 24;
  const width = Math.max(...values.map(point => point.x)) - x + 208, height = Math.max(...values.map(point => point.y)) - y + 100;
  return <button type="button" className="md-graph-overview" onClick={onOpen} aria-label={language === 'zh' ? '展开关系图' : 'Expand graph'}>
    <span><Network size={13}/>{language === 'zh' ? '关系概览' : 'Overview'}</span>
    <svg viewBox={`${x} ${y} ${width} ${height}`} aria-hidden="true">
      {document.nodes.flatMap(node => graphLinks(node).filter(id => points.has(id)).map(id => {
        const from = points.get(id)!, to = points.get(node.id)!;
        return <path key={`${id}:${node.id}`} d={`M${from.x + 184},${from.y + 38} L${to.x},${to.y + 38}`} strokeDasharray={flow && !nodeDependencies(node).includes(id) ? '6 6' : undefined}/>;
      }))}
      {document.nodes.map(node => { const point = points.get(node.id)!; return <g key={node.id}>
        <rect x={point.x} y={point.y} width="184" height="76" rx="12"/>
        <text x={point.x + 16} y={point.y + 44}>{nodeName(node).slice(0, 12)}</text>
      </g>; })}
    </svg>
  </button>;
}
