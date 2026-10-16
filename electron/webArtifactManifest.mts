import { fromMarkdown } from 'mdast-util-from-markdown';
import type { SessionSnapshot, ToolExecutionRecord } from '@cardbush/bush-protocol';
import type { WebAgent } from './webAgentPool.mjs';
import { WebError } from './webCommon.mjs';

const imageTools = new Map([
  ['seedream_create_task', 'seedream'], ['seedream_get_task', 'seedream'], ['generation_wait_tasks', 'seedream'],
  ['image_convert', 'image_conversion'], ['image_stitch', 'image_stitch'],
].map(([name, kind]) => [`mcp__plugin_volcengine_images_images__${name}`, kind]));
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function generatedArtifactPath(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  let path = source;
  try {
    if (path.startsWith('file://')) { const url = new URL(path); if (url.hostname && url.hostname !== 'localhost') return null; path = url.pathname; }
    path = decodeURIComponent(path).replace(/^\/\/(?=data\/workspaces\/)/, '/');
  } catch { return null; }
  if (!path.startsWith('/data/workspaces/generated/') || !/\.(png|jpe?g|webp)$/i.test(path) || path.length > 1000 || /[\\\x00-\x1f\x7f?#:]/.test(path) || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) return null;
  return path;
}
type Output = { path: string; sources: string[] };
export function receiptOutputs(records: ToolExecutionRecord[]): Output[] {
  const outputs = new Map<string, Output>();
  for (const record of records) {
    const kind = imageTools.get(record.toolCall.name);
    if (!kind || record.outcome !== 'returned') continue;
    const native = object(record.result), result = object(native.mcp).name ? object(native.result) : native;
    if (result.isError) continue;
    const structured = object(result.structuredContent);
    const tasks = [structured.task, ...(Array.isArray(structured.items) ? structured.items.map(item => object(object(item).observation).task) : [])];
    for (const value of tasks) {
      const task = object(value), result = object(task.result);
      if (task.kind !== kind || task.status !== 'succeeded' || !Array.isArray(result.data)) continue;
      // A completed stitch receipt attests to the exact source files it read.
      // Keep those generated originals downloadable across continuation turns.
      const sources = kind === 'image_stitch' && Array.isArray(result.sources)
        ? result.sources.map(item => generatedArtifactPath(object(item).source_path)).filter((path): path is string => Boolean(path)) : [];
      for (const item of result.data) {
        const path = generatedArtifactPath(object(item).local_path);
        if (path) outputs.set(path, { path, sources });
      }
    }
  }
  return [...outputs.values()];
}

function authoredReferences(turn: SessionSnapshot['turns'][number] | undefined): Set<string> {
  const paths = new Set<string>();
  for (const entry of turn?.messages ?? []) {
    const message = entry.message;
    if (message.role !== 'assistant') continue;
    const tree = fromMarkdown(message.content), definitions = new Map<string, string>();
    const define = (node: any) => { if (node.type === 'definition') definitions.set(node.identifier, node.url); node.children?.forEach(define); };
    define(tree);
    const visit = (node: any) => {
      if (['code', 'inlineCode', 'html', 'definition'].includes(node.type)) return;
      if (['image', 'link', 'imageReference', 'linkReference'].includes(node.type)) {
        const path = generatedArtifactPath(node.url ?? definitions.get(node.identifier)); if (path) paths.add(path);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  }
  return paths;
}

/** A small, on-demand projection of this account's receipts; no directory scan or model call. */
export async function webArtifactManifest(agent: WebAgent, sessionId: string, turnId: string, snapshot: SessionSnapshot | null) {
  const turns = snapshot?.turns ?? [], index = turns.findIndex(turn => turn.turnId === turnId);
  const references = authoredReferences(index < 0 ? undefined : turns[index]);
  const selected = new Map<string, Output>(), unresolved = new Set(references);
  const read = async (id: string) => receiptOutputs(await agent.call('runtime.command', {
    kind: 'runtime.list_turn_tool_executions', payload: { sessionId, turnId: id },
  }) as ToolExecutionRecord[]);
  const add = (output: Output) => {
    selected.set(output.path, output); unresolved.delete(output.path);
    for (const path of output.sources) {
      if (!selected.has(path)) selected.set(path, { path, sources: [] });
      // Follow an older collage only when it is a dependency of this delivery.
      if (/\/stitched-[^/]+\//.test(path)) unresolved.add(path);
    }
    if (selected.size > 1024) throw new WebError(400, '本轮产物超过 1024 个，请分批下载。');
  };
  for (const output of await read(turnId)) add(output);
  // Only referenced earlier outputs belong to this delivery. Unrelated history stays out.
  for (let i = index - 1; i >= 0 && unresolved.size; i--) {
    for (const output of (await read(turns[i]!.turnId)).reverse()) if (unresolved.has(output.path)) add(output);
  }
  for (const path of references) if (!selected.has(path)) selected.set(path, { path, sources: [] });
  if (selected.size > 1024) throw new WebError(400, '本轮产物超过 1024 个，请分批下载。');
  const items: Array<{ id: string; path: string; name: string; type: 'image'; display: 'attachment'; readOnly: true }> = [];
  // Validate candidates before offering them; a typo in Markdown cannot poison the ZIP.
  const candidates = [...selected.keys()];
  for (let start = 0; start < candidates.length; start += 4) {
    const group = await Promise.all(candidates.slice(start, start + 4).map(async path => {
      try {
        const file = await agent.call('web.files', { action: 'describe', path }) as { path: string; size: number; mime: string };
        return file.path === path && file.size <= 64 * 1024 * 1024 && ['image/png', 'image/jpeg', 'image/webp'].includes(file.mime)
          ? { id: path, path, name: path.split('/').at(-1)!, type: 'image' as const, display: 'attachment' as const, readOnly: true as const } : null;
      } catch (error) {
        // Missing authored references are excluded; transport/runtime failures must remain retryable.
        if (error instanceof Error && /ENOENT|File unavailable|Access outside personal files denied/.test(error.message)) return null;
        throw error;
      }
    }));
    items.push(...group.filter((item): item is NonNullable<typeof item> => item !== null));
  }
  return items;
}
