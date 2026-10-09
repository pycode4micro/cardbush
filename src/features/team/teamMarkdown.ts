import { teamWorkflowSchema, type TeamWorkflow } from '@cardbush/bush-protocol';
import { mapWikiLinks, needsLiteralMarkdown, nodeLinks, parseMarkdownGraph, writeMarkdownGraph, type MdNode } from '../mdPresentation/markdownGraph';

export function teamToMarkdown(team: TeamWorkflow): string {
  return writeMarkdownGraph({ attributes: { id: team.id, name: team.name, max_parallel: team.max_parallel }, introduction: team.description,
    nodes: team.nodes.map(node => {
      const result: MdNode = { id: node.id, attributes: { ...(node.name ? { name: node.name } : {}), agent_id: node.agent_id, ...(node.position ? { position: node.position } : {}) }, body: node.prompt };
      const existing = new Set(nodeLinks(result));
      const links = node.depends_on.filter(id => !existing.has(id));
      if (links.length) {
        if (needsLiteralMarkdown(node.prompt)) result.attributes.links = links;
        else result.body = `${node.prompt}\n\n${links.map(id => `[[#${id}]]`).join(' ')}`;
      }
      return result;
    }),
  });
}

export function teamFromMarkdown(source: string): TeamWorkflow {
  const document = parseMarkdownGraph(source);
  const checkKeys = (value: Record<string, unknown>, allowed: string[]) => {
    const extra = Object.keys(value).filter(key => !allowed.includes(key));
    if (extra.length) throw Error(`Unknown Team metadata: ${extra.join(', ')}`);
  };
  checkKeys(document.attributes, ['id', 'name', 'max_parallel']);
  return teamWorkflowSchema.parse({ ...document.attributes, description: document.introduction,
    nodes: document.nodes.map(node => {
      checkKeys(node.attributes, ['name', 'agent_id', 'position', 'links']);
      // Link-only lines encode dependencies, not assignment prose. Code samples stay intact.
      const marker = '\u0000md-link\u0000';
      const marked = mapWikiLinks(node.body, () => marker).split('\n');
      const prompt = node.body.split('\n').filter((_line, index) => marked[index].split(marker).join('').trim() !== '' || !marked[index].includes(marker)).join('\n').trim();
      const { links: _links, ...attributes } = node.attributes;
      return { ...attributes, id: node.id, prompt, depends_on: nodeLinks(node) };
    }),
  });
}
