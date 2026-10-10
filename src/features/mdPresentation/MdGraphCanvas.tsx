import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText, Maximize2, Minus, Plus, Unlink, WandSparkles } from 'lucide-react';
import { graphLinks, layoutNodes, MAX_GRAPH_COORDINATE, nodeDependencies, nodeName, nodePosition, type MdDocument, type MdNode, type MdPosition } from './markdownGraph';

const width = 184, height = 76;
export function MdGraphCanvas({ document, selectedId, onSelect, onMove, onConnect, onLayout, language, flow = false, icon, subtitle, readOnly = false }: {
  document: MdDocument; selectedId: string; onSelect: (id: string) => void; onMove: (id: string, point: MdPosition) => void;
  onConnect: (source: string, target: string) => void; onLayout: (positions: Map<string, MdPosition>) => void;
  language: 'zh' | 'en'; flow?: boolean; icon?: (node: MdNode) => ReactNode; subtitle?: (node: MdNode) => string; readOnly?: boolean;
}) {
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const viewport = useRef<HTMLDivElement>(null), markerId = useId().replaceAll(':', '');
  const [camera, setCamera] = useState({ x: 20, y: 20, scale: 1 }), [connecting, setConnecting] = useState('');
  const [drag, setDrag] = useState<{ id: string; point: MdPosition } | null>(null);
  const gesture = useRef<{ id: string; x: number; y: number; point: MdPosition; moved: boolean } | null>(null);
  const defaults = useMemo(() => layoutNodes(document.nodes, flow), [document.nodes, flow]);
  const positions = new Map(document.nodes.map(node => [node.id, drag?.id === node.id ? drag.point : nodePosition(node) ?? defaults.get(node.id)!]));
  const links = document.nodes.flatMap(node => graphLinks(node).filter(id => positions.has(id)).map(id => ({ from: id, to: node.id, dependency: nodeDependencies(node).includes(id) })));
  const missing = document.nodes.flatMap(node => graphLinks(node).filter(id => !positions.has(id)));
  const fit = () => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !positions.size) return;
    const points = [...positions.values()];
    const minX = Math.min(...points.map(point => point.x)), minY = Math.min(...points.map(point => point.y));
    const graphWidth = Math.max(...points.map(point => point.x)) + width - minX, graphHeight = Math.max(...points.map(point => point.y)) + height - minY;
    const scale = Math.max(.01, Math.min(1.15, (rect.width - 80) / graphWidth, (rect.height - 110) / graphHeight));
    setCamera({ x: (rect.width - graphWidth * scale) / 2 - minX * scale, y: (rect.height - graphHeight * scale) / 2 - minY * scale, scale });
  };
  const fitRef = useRef(fit); fitRef.current = fit;
  // Fit when the canvas is first laid out or resized, never on each keystroke/drag.
  useEffect(() => { const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => fitRef.current()); observer.observe(element); return () => observer.disconnect();
  }, []);
  const nodeIds = document.nodes.map(node => node.id).join('\0');
  useEffect(() => { fitRef.current(); setConnecting(''); }, [nodeIds]);
  const zoom = (amount: number, x?: number, y?: number) => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect) return;
    const cx = x ?? rect.width / 2, cy = y ?? rect.height / 2;
    setCamera(before => { const scale = Math.max(.01, Math.min(2, before.scale * amount)), ratio = scale / before.scale;
      return { x: cx - (cx - before.x) * ratio, y: cy - (cy - before.y) * ratio, scale }; });
  };
  useEffect(() => { const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = element.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top); };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, []);
  const completeLink = (id: string) => { if (connecting && id !== connecting) { onConnect(connecting, id); setConnecting(''); } else onSelect(id); };
  return <div className="md-graph" ref={viewport} aria-label={t('节点图谱', 'Node graph')} tabIndex={0}
    onKeyDown={event => { if (event.key === 'Escape') { setConnecting(''); setDrag(null); gesture.current = null; } }}
    onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('button, .md-graph-controls')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { id: '', x: event.clientX, y: event.clientY, point: { x: camera.x, y: camera.y }, moved: false };
    }}
    onPointerMove={event => {
      const active = gesture.current; if (!active) return;
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) active.moved = true;
      if (active.id) setDrag({ id: active.id, point: { x: Math.max(-MAX_GRAPH_COORDINATE, Math.min(MAX_GRAPH_COORDINATE, active.point.x + dx / camera.scale)), y: Math.max(-MAX_GRAPH_COORDINATE, Math.min(MAX_GRAPH_COORDINATE, active.point.y + dy / camera.scale)) } });
      else setCamera(before => ({ ...before, x: active.point.x + dx, y: active.point.y + dy }));
    }}
    onPointerUp={() => { const active = gesture.current; if (!active) return;
      if (active.id && active.moved && drag) onMove(active.id, drag.point);
      gesture.current = null; setDrag(null);
    }}
    onPointerCancel={() => { gesture.current = null; setDrag(null); }}>
    <div className="md-graph-caption"><span>{t(flow ? 'Team 任务关系' : '文档关系', flow ? 'Team dependencies' : 'Document links')}</span><small>{document.nodes.length} {t('章节', 'sections')} · {links.length} {t('链接', 'links')}</small></div>
    {!document.nodes.length && <div className="md-graph-empty"><FileText size={30}/><strong>{t('从一个节点开始', 'Start with a node')}</strong><p>{t('添加节点，或打开一份 Markdown。', 'Add a node or open a Markdown file.')}</p></div>}
    <div className="md-graph-stage" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
      <svg className="md-graph-edges" width="1" height="1" aria-hidden="true"><defs><marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
        {links.map(({ from, to, dependency }) => { const a = positions.get(from)!, b = positions.get(to)!;
          const x1 = a.x + width, y1 = a.y + height / 2, x2 = b.x, y2 = b.y + height / 2, bend = Math.max(65, Math.abs(x2 - x1) / 2);
          return <path key={`${from}\0${to}`} data-edge={`${from}:${to}`} data-kind={dependency ? 'dependency' : 'reference'} data-active={from === selectedId || to === selectedId} d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`} markerEnd={flow && dependency ? `url(#${markerId})` : undefined} strokeDasharray={flow && !dependency ? '5 5' : undefined}/>;
        })}
      </svg>
      {document.nodes.map(node => { const point = positions.get(node.id)!, connectable = !readOnly && (!flow || 'agent_id' in node.attributes);
        return <div className="md-graph-node" key={node.id} data-node-id={node.id} data-selected={selectedId === node.id} data-linking={connecting === node.id}
          style={{ left: point.x, top: point.y, width, height }}>
          {connectable && <button type="button" className="md-node-port md-node-in" aria-label={`${t('连接到', 'Connect to')} ${nodeName(node)}`} onClick={() => completeLink(node.id)} />}
          <button type="button" className="md-node-face" aria-pressed={selectedId === node.id} onClick={event => { if (event.detail === 0) completeLink(node.id); }}
            onPointerDown={event => { if (event.button !== 0) return; event.stopPropagation();
              if (connecting) { completeLink(node.id); return; }
              onSelect(node.id); if (readOnly) return; event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = { id: node.id, x: event.clientX, y: event.clientY, point, moved: false };
            }}
            onKeyDown={event => { const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
              if (!readOnly && direction && event.altKey) { event.preventDefault(); onMove(node.id, { x: point.x + direction[0] * 20, y: point.y + direction[1] * 20 }); }
            }}>
            <span className="md-node-icon">{icon?.(node) ?? <FileText size={19}/>}</span><span><strong>{nodeName(node)}</strong><small>{subtitle?.(node) || node.id}</small></span>
          </button>
          {connectable && <button type="button" className="md-node-port md-node-out" aria-label={`${t('从此节点连线', 'Link from')} ${nodeName(node)}`} onClick={() => setConnecting(node.id)} />}
        </div>;
      })}
    </div>
    {connecting && <div className="md-link-hint" role="status">{t('选择下游节点；它将引用当前节点。', 'Choose a downstream node to reference this node.')}<button type="button" onClick={() => setConnecting('')} aria-label={t('取消连线', 'Cancel link')}><Unlink size={14}/></button></div>}
    {missing.length > 0 && <div className="md-link-warning" role="status">{t('未找到节点：', 'Unresolved links: ')}{[...new Set(missing)].join(', ')}</div>}
    <div className="md-graph-controls"><span>{Math.round(camera.scale * 100)}%</span><button type="button" onClick={() => zoom(1 / 1.2)} aria-label={t('缩小图谱', 'Zoom out')}><Minus size={15}/></button><button type="button" onClick={() => zoom(1.2)} aria-label={t('放大图谱', 'Zoom in')}><Plus size={15}/></button><button type="button" onClick={fit} aria-label={t('适应画布', 'Fit graph')}><Maximize2 size={15}/></button>{!readOnly && <button type="button" onClick={() => { onLayout(defaults); requestAnimationFrame(() => fitRef.current()); }} aria-label={t('自动排列', 'Auto layout')}><WandSparkles size={15}/></button>}</div>
  </div>;
}
