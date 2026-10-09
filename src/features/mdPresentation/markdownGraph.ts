import { dump, load, JSON_SCHEMA } from 'js-yaml';

export type MdPosition = { x: number; y: number };
export type MdNode = { id: string; attributes: Record<string, unknown>; body: string };
export type MdDocument = { attributes: Record<string, unknown>; introduction: string; nodes: MdNode[] };
const identifier = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,119}$/u;
export const MAX_MARKDOWN_LENGTH = 2 * 1024 * 1024;
export const MAX_GRAPH_COORDINATE = 100000;

function attributes(source: string): Record<string, unknown> {
  const value = load(source, { schema: JSON_SCHEMA });
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Markdown metadata must be a mapping.');
  let count = 0; const seen = new Set<object>();
  const visit = (item: unknown, depth: number) => {
    if (++count > 2000 || depth > 8) throw Error('Markdown metadata is too complex.');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw Error('Markdown metadata must not contain YAML aliases.');
      seen.add(item); Object.values(item).forEach(child => visit(child, depth + 1));
    }
  };
  visit(value, 0);
  return value as Record<string, unknown>;
}

/** Ordinary Markdown stays intact. Explicit md-node blocks delimit editable nodes,
 * so headings and fenced code inside an assignment never split it into new nodes. */
export function parseMarkdownGraph(source: string): MdDocument {
  if (source.length > MAX_MARKDOWN_LENGTH) throw Error('Markdown exceeds 2 MB.');
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const document: MdDocument = { attributes: {}, introduction: '', nodes: [] };
  let start = 0, introduction = '';
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) throw Error('Unclosed Markdown metadata (---).');
    document.attributes = attributes(lines.slice(1, end).join('\n')); start = end + 1;
    if ('introduction' in document.attributes) {
      if (typeof document.attributes.introduction !== 'string') throw Error('Invalid literal Markdown introduction.');
      introduction = document.attributes.introduction; delete document.attributes.introduction;
    }
  }
  let body: string[] = [], current: MdNode | undefined, literal = '';
  let fence: { character: string; length: number } | undefined;
  const finish = () => { if (current) current.body = [literal, body.join('\n').trim()].filter(Boolean).join('\n\n'); else document.introduction = [introduction, body.join('\n').trim()].filter(Boolean).join('\n\n'); body = []; literal = ''; };
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    const heading = !fence && /^## (.+?)\s*$/.exec(line);
    if (heading && lines[index + 1] === '```md-node') {
      finish();
      const id = heading[1];
      if (!identifier.test(id)) throw Error(`Invalid node ID: ${id}`);
      if (document.nodes.some(node => node.id === id)) throw Error(`Duplicate node ID: ${id}`);
      const end = lines.indexOf('```', index + 2);
      if (end < 0) throw Error(`Unclosed md-node metadata: ${id}`);
      current = { id, attributes: attributes(lines.slice(index + 2, end).join('\n')), body: '' };
      if ('markdown' in current.attributes) {
        if (typeof current.attributes.markdown !== 'string') throw Error(`Invalid literal Markdown: ${id}`);
        literal = current.attributes.markdown; delete current.attributes.markdown;
      }
      if ('links' in current.attributes && (!Array.isArray(current.attributes.links) || current.attributes.links.length > 128 || current.attributes.links.some(link => typeof link !== 'string' || !identifier.test(link)))) throw Error(`Invalid node links: ${id}`);
      document.nodes.push(current); index = end;
      if (document.nodes.length > 128) throw Error('A document supports at most 128 nodes.');
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    }
    body.push(line);
  }
  finish();
  return document;
}

export function writeMarkdownGraph(document: MdDocument): string {
  const yaml = (value: Record<string, unknown>) => dump(value, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }).trimEnd();
  const literalIntroduction = needsLiteralMarkdown(document.introduction);
  const documentAttributes = { ...document.attributes, ...(literalIntroduction ? { introduction: document.introduction } : {}) };
  const sections = [Object.keys(documentAttributes).length ? `---\n${yaml(documentAttributes)}\n---` : '', literalIntroduction ? '' : document.introduction,
    ...document.nodes.map(node => {
      const literal = needsLiteralMarkdown(node.body);
      return `## ${node.id}\n\`\`\`md-node\n${yaml({ ...node.attributes, ...(literal ? { markdown: node.body } : {}) })}\n\`\`\`\n\n${literal ? '' : node.body.trim()}`;
    })];
  return sections.filter(Boolean).join('\n\n').trimEnd() + '\n';
}

/** Keep unfinished code and format examples editable without swallowing later nodes. */
export function needsLiteralMarkdown(body: string): boolean {
  let fence: { character: string; length: number } | undefined;
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!fence && /^## .+$/.test(lines[index]) && lines[index + 1] === '```md-node') return true;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    }
  }
  return Boolean(fence);
}

/** Ignore examples in fenced/inline code and escaped wiki links. */
export function mapWikiLinks(body: string, transform: (id: string, label: string, original: string) => string): string {
  let fence: { character: string; length: number } | undefined;
  return body.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.split(/(`+[^`]*`+)/g).map(part => part.startsWith('`') ? part : part.replace(/(?<!\\)\[\[#([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g,
      (original: string, id: string, label: string | undefined) => transform(id.trim(), label || id.trim(), original))).join('');
  }).join('\n');
}

export function nodeLinks(node: MdNode): string[] {
  const links = new Set<string>(Array.isArray(node.attributes.links) ? node.attributes.links as string[] : []); mapWikiLinks(node.body, (id, _label, original) => { links.add(id); return original; }); return [...links];
}
export function setNodeLink(node: MdNode, target: string, enabled: boolean): MdNode {
  if (enabled) return nodeLinks(node).includes(target) ? node : needsLiteralMarkdown(node.body)
    ? { ...node, attributes: { ...node.attributes, links: [...(Array.isArray(node.attributes.links) ? node.attributes.links : []), target] } }
    : { ...node, body: `${node.body.trim()}\n\n[[#${target}]]`.trim() };
  const attributes = { ...node.attributes };
  if (Array.isArray(attributes.links)) { const links = attributes.links.filter(id => id !== target); if (links.length) attributes.links = links; else delete attributes.links; }
  return { ...node, attributes, body: mapWikiLinks(node.body, (id, _label, original) => id === target ? '' : original).trim() };
}
export function renameNode(document: MdDocument, before: string, after: string): MdDocument {
  if (!identifier.test(after) || document.nodes.some(node => node.id === after && node.id !== before)) throw Error('Node IDs must be unique and contain only letters, numbers, spaces, dots, underscores or hyphens.');
  return { ...document, nodes: document.nodes.map(node => ({ ...node, id: node.id === before ? after : node.id,
    attributes: { ...node.attributes, ...(Array.isArray(node.attributes.links) ? { links: node.attributes.links.map(id => id === before ? after : id) } : {}) },
    body: mapWikiLinks(node.body, (id, label, original) => id === before ? `[[#${after}${label === id ? '' : `|${label}`}]]` : original) })) };
}
export function removeNode(document: MdDocument, id: string): MdDocument {
  return { ...document, nodes: document.nodes.filter(node => node.id !== id).map(node => setNodeLink(node, id, false)) };
}
export function nodeName(node: MdNode) { return typeof node.attributes.name === 'string' && node.attributes.name.trim() ? node.attributes.name : node.id; }
export function nodePosition(node: MdNode): MdPosition | undefined {
  const position = node.attributes.position as MdPosition | undefined;
  return position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) <= MAX_GRAPH_COORDINATE && Math.abs(position.y) <= MAX_GRAPH_COORDINATE ? position : undefined;
}
export function layoutNodes(nodes: MdNode[], flow = false): Map<string, MdPosition> {
  const positions = new Map<string, MdPosition>();
  if (!flow) {
    const radius = Math.max(180, nodes.length * 30);
    nodes.forEach((node, index) => positions.set(node.id, nodes.length === 1 ? { x: 320, y: 240 } : {
      x: 360 + radius + Math.cos(index * Math.PI * 2 / nodes.length - Math.PI / 2) * radius,
      y: 120 + radius + Math.sin(index * Math.PI * 2 / nodes.length - Math.PI / 2) * radius,
    }));
  } else {
    const levels = new Map<string, number>(), visiting = new Set<string>();
    const depth = (node: MdNode): number => {
      if (levels.has(node.id)) return levels.get(node.id)!;
      if (visiting.has(node.id)) return 0;
      visiting.add(node.id);
      const dependencies = nodeLinks(node).map(id => nodes.find(item => item.id === id)).filter((item): item is MdNode => Boolean(item));
      const level = dependencies.length ? Math.max(...dependencies.map(depth)) + 1 : 0;
      visiting.delete(node.id); levels.set(node.id, level); return level;
    };
    const counts = new Map<number, number>();
    nodes.forEach(node => { const level = depth(node), row = counts.get(level) || 0; counts.set(level, row + 1); positions.set(node.id, { x: 80 + level * 280, y: 110 + row * 140 }); });
  }
  return positions;
}
