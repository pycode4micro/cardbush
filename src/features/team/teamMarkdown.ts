import { teamWorkflowSchema, type TeamWorkflow } from '@cardbush/bush-protocol';
import { mapWikiLinks, nodeDependencies, nodeLinks, parseMarkdownGraph, writeMarkdownGraph, type MdDocument, type MdNode } from '../mdPresentation/markdownGraph';

export function documentTeam(document: MdDocument): Record<string, unknown> | undefined {
  const team = document.attributes.team;
  if (team && typeof team === 'object' && !Array.isArray(team)) return team as Record<string, unknown>;
  // The first graph editor used top-level Team fields.
  if (typeof document.attributes.id === 'string' && 'max_parallel' in document.attributes) return document.attributes;
}

export function enableDocumentTeam(source: string): string {
  const document = parseMarkdownGraph(source);
  if (documentTeam(document)) return source;
  return writeMarkdownGraph({ ...document, attributes: { ...document.attributes,
    name: document.attributes.name || /^# (.+)$/m.exec(document.introduction)?.[1] || '新团队',
    team: { id: `team-${crypto.randomUUID().slice(0, 8)}`, max_parallel: 3, description: '' } } });
}

/** Reconcile runtime edits with the saved article, retaining notes and Markdown metadata. */
export function teamToMarkdown(team: TeamWorkflow): string {
  let document: MdDocument;
  try { document = team.presentation ? parseMarkdownGraph(team.presentation.markdown) : {
    attributes: {}, introduction: `# ${team.name}\n\n${team.description}`.trimEnd(), nodes: [],
  }; } catch { return team.presentation!.markdown; } // Keep malformed source editable instead of crashing or discarding it.
  const attributes = { ...document.attributes };
  if (!attributes.team && attributes.id === team.id) { delete attributes.id; delete attributes.max_parallel; }
  attributes.name = team.name;
  attributes.team = { id: team.id, max_parallel: team.max_parallel, description: team.description };
  const remaining = new Map(team.nodes.map(node => [node.id, node]));
  const task = (node: TeamWorkflow['nodes'][number], prior?: MdNode): MdNode => {
    const attributes: Record<string, unknown> = { ...prior?.attributes, agent_id: node.agent_id, depends_on: node.depends_on };
    if (node.name) attributes.name = node.name; else delete attributes.name;
    if (node.position) attributes.position = node.position; else delete attributes.position;
    return { id: node.id, body: node.prompt, attributes };
  };
  const nodes = document.nodes.flatMap(node => {
    const definition = remaining.get(node.id);
    if (definition) { remaining.delete(node.id); return [task(definition, node)]; }
    return 'agent_id' in node.attributes ? [] : [node];
  });
  nodes.push(...[...remaining.values()].map(node => task(node)));
  return writeMarkdownGraph({ ...document, attributes, nodes });
}

export function teamFromMarkdown(source: string): TeamWorkflow {
  const document = parseMarkdownGraph(source), config = documentTeam(document);
  if (!config) throw Error('请先添加 Team 配置。Add Team configuration first.');
  const legacy = !document.attributes.team;
  const allowed = legacy ? ['id', 'name', 'max_parallel'] : ['id', 'max_parallel', 'description'];
  const extra = Object.keys(config).filter(key => !allowed.includes(key));
  if (extra.length) throw Error(`Unknown Team metadata: ${extra.join(', ')}`);
  if (!document.nodes.some(node => 'agent_id' in node.attributes)) throw Error('至少将一个章节标记为 Team 任务，并选择员工。Mark at least one section as a Team task and choose an agent.');
  return teamWorkflowSchema.parse({ id: config.id, name: document.attributes.name,
    description: legacy ? document.introduction : config.description ?? '', max_parallel: config.max_parallel,
    presentation: { markdown: source },
    nodes: document.nodes.filter(node => 'agent_id' in node.attributes).map(node => {
      let prompt = node.body;
      if (legacy && !('depends_on' in node.attributes)) {
        const marker = '\u0000md-link\u0000', marked = mapWikiLinks(prompt, () => marker).split('\n');
        prompt = prompt.split('\n').filter((_line, index) => marked[index].split(marker).join('').trim() !== '' || !marked[index].includes(marker)).join('\n').trim();
      }
      return { id: node.id, ...(node.attributes.name ? { name: node.attributes.name } : {}), agent_id: node.attributes.agent_id,
        prompt, depends_on: legacy && !('depends_on' in node.attributes) ? nodeLinks(node) : nodeDependencies(node),
        ...(node.attributes.position ? { position: node.attributes.position } : {}) };
    }),
  });
}
