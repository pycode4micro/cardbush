import { z } from 'zod';
import { assertCanvasVersionsUnchanged, canvasContentSchema, canvasItemSchema, canvasLayoutFacts, creationCanvasSchema, replaceCanvasContent, serializeCanvas } from '@cardbush/bush-protocol';
import { withCanvasFileLock } from './canvasFileLock.js';
import { captureCanvasVersion, releaseCanvasVersion } from './canvasVersions.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import type { ToolRegistry } from './toolRegistry.js';

const inputSchema = z.object({
  action: z.enum(['inspect', 'update', 'freeze', 'unfreeze']), path: z.string().min(1),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  canvas: z.object({ title: z.string().max(200).optional(), width: z.number().optional(), height: z.number().optional(), background: z.string().optional(), team: z.object({ id: z.string().min(1).max(120) }).strict().nullable().optional() }).strict().optional(),
  upsert: z.array(canvasItemSchema).max(100).optional(), remove: z.array(z.string()).max(100).optional(),
  content: z.array(z.object({ id: z.string().min(1), content: canvasContentSchema }).strict()).max(100).optional(),
  layout: z.boolean().optional(), item_id: z.string().min(1).optional(),
}).strict();

export function registerDesignTool(registry: ToolRegistry) {
  if (registry.resolve('design')) return;
  registry.register({
    definition: { name: 'design', description: 'Inspect and assemble a persistent CardBush canvas. inspect returns current revision, content, stable region IDs, purpose, Team assignments, frames and fixed-version facts. Mutations require expected_revision. For routine updates use content:[{id,content:{kind,markdown|html|source}}]; this preserves position, size, group and ownership. upsert adds/replaces items; changing existing frames or canvas dimensions requires layout:true, only when the user requests rearranging. remove explicitly removes IDs. freeze + item_id captures local content and dependencies as a fixed version; unfreeze explicitly resumes its original source. Fixed content cannot be changed by update. Create another live region when retaining a comparison. File tools/plugins edit live source documents; previews refresh in place. Local file versions use ordinary permission-checked file tools (8 MiB per file). Remote content must first be saved locally or captured as an excerpt. HTML is sandboxed and self-contained. Snapshot references retain provenance, not a live crop. Team members only update assigned regions; coordinate cross-region changes through the parent. No simulated typing.', inputSchema: z.toJSONSchema(inputSchema) },
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
        if (input.canvas || input.upsert || input.remove || input.expected_revision || input.content || input.layout !== undefined || input.item_id) throw Error('inspect does not accept changes.');
        return { path: initial.path, revision: initial.sha256, document: initial.document, layout: canvasLayoutFacts(initial.document) };
      }
      if (!input.expected_revision) throw Error('Inspect the canvas first and supply expected_revision.');
      return await withCanvasFileLock(initial.path, async () => {
        const current = await read();
        if (current.sha256 !== input.expected_revision) throw Error('CANVAS_REVISION_CONFLICT: the canvas changed. Inspect it again before updating.');
        const metadata = context.turn?.request.metadata;
        if (metadata?.teamMemberId) {
          // The parent owns composition. A worker can only fill its assigned regions.
          const ids = [...(input.content ?? []).map(item => item.id), ...(input.upsert ?? []).map(item => item.id)];
          if (input.action !== 'update' || input.canvas || input.layout || input.remove?.length || ids.some(id => {
            const item = current.document.items.find(item => item.id === id), replacement = input.upsert?.find(value => value.id === id);
            return !item || !item.assignment || item.assignment.teamId !== metadata.teamId || item.assignment.nodeId !== metadata.teamMemberId ||
              replacement && JSON.stringify(replacement.assignment) !== JSON.stringify(item.assignment);
          })) throw Error('CANVAS_REGION_OWNERSHIP: update only your assigned regions. Ask the parent to handle layout, version or cross-region changes.');
        }
        if (input.action === 'freeze' || input.action === 'unfreeze') {
          if (input.canvas || input.upsert || input.remove || input.content || input.layout !== undefined) throw Error('Version actions accept only item_id and expected_revision.');
          const item = current.document.items.find(value => value.id === input.item_id);
          if (!item) throw Error('Choose an existing item_id.');
          const replacement = input.action === 'unfreeze' ? releaseCanvasVersion(item) : await captureCanvasVersion(item, current.path, {
            read: async path => {
              const value = await context.invokeTool('read_file', { path, encoding: 'base64' }) as { content: string };
              if (!value || typeof value.content !== 'string') throw Error('Could not read version source.');
              return Buffer.from(value.content, 'base64');
            },
            write: async (path, bytes) => { writing = true; await context.invokeTool('write_file', { path, content: bytes.toString('base64'), encoding: 'base64' }); },
          });
          const document = creationCanvasSchema.parse({ ...current.document, items: current.document.items.map(value => value.id === item.id ? replacement : value) });
          const content = serializeCanvas(document); writing = true;
          await context.invokeTool('edit_file', { path: current.path, old_text: current.content, new_text: content });
          const saved = await read();
          if (JSON.stringify(saved.document) !== JSON.stringify(document)) throw Error('Version write was not confirmed; inspect the latest state.');
          return { path: saved.path, revision: saved.sha256, layout: canvasLayoutFacts(saved.document) };
        }
        if (input.item_id) throw Error('item_id is only for freeze/unfreeze.');
        const removed = new Set(input.remove), updated = new Map((input.upsert ?? []).map(item => [item.id, item]));
        if (removed.size !== (input.remove?.length ?? 0) || updated.size !== (input.upsert?.length ?? 0)) throw Error('Change IDs must be unique.');
        for (const id of removed) if (updated.has(id) || !current.document.items.some(item => item.id === id)) throw Error('Remove must identify an existing item, without an upsert for the same ID.');
        const contents = new Map((input.content ?? []).map(item => [item.id, item.content]));
        if (contents.size !== (input.content?.length ?? 0)) throw Error('Content IDs must be unique.');
        for (const id of contents.keys()) if (removed.has(id) || updated.has(id) || !current.document.items.some(item => item.id === id)) throw Error('Content must identify an existing item without another operation for the same ID.');
        if (!input.layout && (input.canvas?.width !== undefined && input.canvas.width !== current.document.width || input.canvas?.height !== undefined && input.canvas.height !== current.document.height))
          throw Error('CANVAS_LAYOUT_PRESERVED: resizing requires layout:true.');
        const items = current.document.items.filter(item => !removed.has(item.id)).map(item => {
          const replacement = updated.get(item.id);
          if (replacement && !input.layout && JSON.stringify(replacement.frame) !== JSON.stringify(item.frame))
            throw Error('CANVAS_LAYOUT_PRESERVED: use content for in-place updates; moving/resizing requires layout:true.');
          return replacement ? { ...replaceCanvasContent(item, replacement), ...replacement } : contents.has(item.id) ? replaceCanvasContent(item, contents.get(item.id)!) : item;
        });
        for (const item of updated.values()) if (!items.some(existing => existing.id === item.id)) items.push(item);
        const document = creationCanvasSchema.parse({ ...current.document, ...input.canvas, team: input.canvas?.team === null ? undefined : input.canvas?.team ?? current.document.team, items });
        assertCanvasVersionsUnchanged(current.document, document);
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
