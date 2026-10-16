import { z } from 'zod';

export const CANVAS_FILE_NAME = 'space.canvas.json';
export const CANVAS_MAX_BYTES = 8 * 1024 * 1024;
export const canvasFrameSchema = z.object({
  x: z.number().finite().min(0).max(50000), y: z.number().finite().min(0).max(50000),
  width: z.number().finite().min(80).max(10000), height: z.number().finite().min(60).max(10000),
}).strict();
export const canvasReferenceSchema = z.object({
  source: z.string().min(1).max(8192), mode: z.literal('snapshot'),
  page: z.string().max(100).optional(), sheet: z.string().max(200).optional(), cells: z.string().max(200).optional(),
  locator: z.string().max(8000).optional(), text: z.string().max(20000).optional(),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).optional(),
}).strict();
const base = {
  id: z.string().regex(/^[\w-]{1,100}$/), title: z.string().max(200), frame: canvasFrameSchema,
  reference: canvasReferenceSchema.optional(),
};
export const canvasItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('html'), html: z.string().max(262144) }).strict(),
  z.object({ ...base, kind: z.literal('markdown'), markdown: z.string().max(524288) }).strict(),
  z.object({ ...base, kind: z.literal('file'), source: z.string().min(1).max(8192) }).strict(),
]);
export const creationCanvasSchema = z.object({
  format: z.literal('cardbush-canvas'), version: z.literal(1), title: z.string().max(200),
  width: z.number().finite().min(320).max(50000), height: z.number().finite().min(240).max(50000),
  background: z.string().regex(/^#[\da-fA-F]{6}$/).default('#181818'),
  items: z.array(canvasItemSchema).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'Duplicate canvas item ID.' });
    ids.add(item.id);
    if (item.frame.x + item.frame.width > value.width || item.frame.y + item.frame.height > value.height)
      ctx.addIssue({ code: 'custom', path: ['items', index, 'frame'], message: 'Item extends beyond the canvas. Enlarge the canvas or adjust its frame.' });
  }
});
export type CreationCanvas = z.infer<typeof creationCanvasSchema>;
export type CanvasItem = z.infer<typeof canvasItemSchema>;
export type CanvasReference = z.infer<typeof canvasReferenceSchema>;
export type CanvasSnapshot = { path: string; revision: string; document: CreationCanvas; resources?: Record<string, string> };
export function serializeCanvas(value: CreationCanvas) {
  const content = JSON.stringify(creationCanvasSchema.parse(value), null, 2) + '\n';
  if (new TextEncoder().encode(content).length > CANVAS_MAX_BYTES) throw Error('Canvas exceeds the 8 MiB limit. Place large content in referenced files.');
  return content;
}
export function emptyCanvas(title = ''): CreationCanvas {
  return { format: 'cardbush-canvas', version: 1, title, width: 1440, height: 960, background: '#181818', items: [] };
}
export function canvasLayoutFacts(document: CreationCanvas) {
  const overlaps: Array<[string, string]> = [];
  document.items.forEach((item, index) => document.items.slice(index + 1).forEach(other => {
    const a = item.frame, b = other.frame;
    if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) overlaps.push([item.id, other.id]);
  }));
  return { coordinateSystem: 'CSS pixels, origin at canvas top-left; item order is back-to-front', width: document.width, height: document.height,
    overlaps, items: document.items.map(item => ({ id: item.id, kind: item.kind, title: item.title, frame: item.frame, ...(item.kind === 'file' ? { source: item.source } : {}), ...(item.reference ? { reference: item.reference } : {}) })) };
}
