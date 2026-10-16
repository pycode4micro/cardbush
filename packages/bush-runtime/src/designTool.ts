import { z } from 'zod';
import { canvasItemSchema, canvasLayoutFacts, creationCanvasSchema, serializeCanvas } from '@cardbush/bush-protocol';
import { withCanvasFileLock } from './canvasFileLock.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import type { ToolRegistry } from './toolRegistry.js';

const inputSchema = z.object({
  action: z.enum(['inspect', 'update']), path: z.string().min(1),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  canvas: z.object({ title: z.string().max(200).optional(), width: z.number().optional(), height: z.number().optional(), background: z.string().optional() }).strict().optional(),
  upsert: z.array(canvasItemSchema).max(100).optional(), remove: z.array(z.string()).max(100).optional(),
}).strict();

export function registerDesignTool(registry: ToolRegistry) {
  if (registry.resolve('design')) return;
  registry.register({
    definition: { name: 'design', description: 'Inspect and assemble a CardBush creation canvas. Use the canvas manifest path supplied in editing context. inspect returns the current revision, full content, frames and overlap facts. update requires that exact revision and applies a batch atomically: upsert complete items by stable ID; remove IDs; optionally resize or rename the canvas. Coordinates are CSS pixels, top-left origin. Items render HTML (sandboxed), Markdown, or local/relative/HTTPS files using existing preview adapters (slides, spreadsheets, documents, PDF, media). Generate/edit file contents with existing tools or plugins, then reference them here. Preserve unrelated items. Reference snapshots must identify their original file and selected page/cells/region; never claim a snapshot is live. HTML items are self-contained and cannot access local files or host APIs. Use file items for external resources. Do not simulate mouse typing to populate a canvas.', inputSchema: z.toJSONSchema(inputSchema) },
    manifest: { effect_kind: 'delegation', operation: 'design.canvas', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: true },
    delegatesToolExecution: true,
    decodeInput: value => inputSchema.parse(value),
    execute: async context => {
      let writing = false;
      try {
      const input = context.input;
      const read = async () => {
        const result = await context.invokeTool('read_file', { path: input.path }) as { path: string; sha256: string; content: string };
        if (!result || typeof result.content !== 'string' || typeof result.sha256 !== 'string' || typeof result.path !== 'string') throw Error('Canvas read did not succeed.');
        return { ...result, document: creationCanvasSchema.parse(JSON.parse(result.content)) };
      };
      const initial = await read();
      if (input.action === 'inspect') {
        if (input.canvas || input.upsert || input.remove || input.expected_revision) throw Error('inspect does not accept changes.');
        return { path: initial.path, revision: initial.sha256, document: initial.document, layout: canvasLayoutFacts(initial.document) };
      }
      if (!input.expected_revision) throw Error('Inspect the canvas first and supply expected_revision.');
      return await withCanvasFileLock(initial.path, async () => {
        const current = await read();
        if (current.sha256 !== input.expected_revision) throw Error('CANVAS_REVISION_CONFLICT: the canvas changed. Inspect it again before updating.');
        const removed = new Set(input.remove), updated = new Map((input.upsert ?? []).map(item => [item.id, item]));
        if (removed.size !== (input.remove?.length ?? 0) || updated.size !== (input.upsert?.length ?? 0)) throw Error('Change IDs must be unique.');
        for (const id of removed) if (updated.has(id) || !current.document.items.some(item => item.id === id)) throw Error('Remove must identify an existing item, without an upsert for the same ID.');
        const items = current.document.items.filter(item => !removed.has(item.id)).map(item => updated.get(item.id) ?? item);
        for (const item of updated.values()) if (!items.some(existing => existing.id === item.id)) items.push(item);
        const document = creationCanvasSchema.parse({ ...current.document, ...input.canvas, items });
        const content = serializeCanvas(document); writing = true;
        await context.invokeTool('edit_file', { path: current.path, old_text: current.content, new_text: content });
        const saved = await read();
        if (JSON.stringify(saved.document) !== JSON.stringify(document)) throw Error('Canvas write was not confirmed; inspect the latest state.');
        return { path: saved.path, revision: saved.sha256, layout: canvasLayoutFacts(document) };
      }, context.signal);
      } catch (error) { throw writing ? error : withToolFailureFacts(error instanceof Error ? error : new Error(String(error)), { effects: 'none', result: 'known' }); }
    },
  });
}
