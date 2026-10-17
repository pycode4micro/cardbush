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
export const canvasContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), source: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal('markdown'), markdown: z.string().max(524288) }).strict(),
  z.object({ kind: z.literal('html'), html: z.string().max(262144) }).strict(),
]);
const base = {
  id: z.string().regex(/^[\w-]{1,100}$/), title: z.string().max(200), frame: canvasFrameSchema,
  reference: canvasReferenceSchema.optional(),
  purpose: z.string().max(2000).optional(),
  group: z.string().max(100).optional(),
  assignment: z.object({ teamId: z.string().min(1).max(120), nodeId: z.string().min(1).max(120) }).strict().optional(),
  fixed: z.object({ capturedAt: z.iso.datetime(), original: canvasContentSchema }).strict().optional(),
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
  desktop: z.object({ kind: z.literal('development'), repository: z.string().min(1).max(8192) }).strict().optional(),
  team: z.object({ id: z.string().min(1).max(120) }).strict().optional(),
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
export type CanvasContent = NonNullable<CanvasItem['fixed']>['original'];
export function canvasContent(item: CanvasItem): CanvasContent {
  if (item.kind === 'html') return { kind: item.kind, html: item.html };
  if (item.kind === 'markdown') return { kind: item.kind, markdown: item.markdown };
  return { kind: item.kind, source: item.source };
}
export function replaceCanvasContent(item: CanvasItem, content: CanvasContent): CanvasItem {
  const { kind: _kind, ...rest } = item;
  delete (rest as Record<string, unknown>).source;
  delete (rest as Record<string, unknown>).html;
  delete (rest as Record<string, unknown>).markdown;
  return { ...rest, ...content } as CanvasItem;
}
/** Ordinary saves may move or rename a fixed item, but cannot silently rewrite its version. */
export function assertCanvasVersionsUnchanged(before: CreationCanvas, after: CreationCanvas) {
  for (const item of after.items) {
    const previous = before.items.find(value => value.id === item.id);
    if (!previous?.fixed && !item.fixed) continue;
    if (!previous?.fixed || JSON.stringify(previous.fixed) !== JSON.stringify(item.fixed) ||
        JSON.stringify(canvasContent(previous)) !== JSON.stringify(canvasContent(item)) ||
        JSON.stringify(previous.reference) !== JSON.stringify(item.reference))
      throw Error(`CANVAS_FIXED_VERSION: ${item.id} is a fixed version. Use freeze/unfreeze explicitly; update a live region instead.`);
  }
}
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
    ...(document.desktop ? { desktop: document.desktop } : {}), ...(document.team ? { team: document.team } : {}),
    overlaps, items: document.items.map(item => ({ id: item.id, kind: item.kind, title: item.title, frame: item.frame,
      ...(item.purpose ? { purpose: item.purpose } : {}), ...(item.group ? { group: item.group } : {}), ...(item.assignment ? { assignment: item.assignment } : {}),
      contentMode: item.fixed ? 'fixed' : item.reference ? 'excerpt' : 'live',
      ...(item.fixed ? { fixed: { capturedAt: item.fixed.capturedAt, ...(item.fixed.original.kind === 'file' ? { source: item.fixed.original.source } : {}) } } : {}),
      ...(item.kind === 'file' ? { source: item.source } : {}), ...(item.reference ? { reference: item.reference } : {}) })) };
}

export function developmentDesktop(repository: string, language: 'zh' | 'en' = 'zh'): CreationCanvas {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const region = (id: string, title: string, purpose: string, frame: CanvasItem['frame']): CanvasItem => ({ id, title, purpose, kind: 'markdown', frame,
    markdown: `## ${title}\n\n${t('等待首次更新', 'Awaiting first update')}\n\n${purpose}` });
  return { ...emptyCanvas(t('CardBush 开发桌面', 'CardBush development desk')), desktop: { kind: 'development', repository }, items: [
    region('changes', t('最近改动', 'Recent changes'), t('根据实际提交与本地改动整理进度，保留来源与更新时间。', 'Summarize actual commits and local changes with sources and update time.'), { x: 24, y: 36, width: 388, height: 400 }),
    region('release', t('准备发布', 'Release checklist'), t('整理本次发布内容、待办与阻塞项，未经验证的事项保持待确认。', 'Track release scope, pending work and blockers; keep unverified items pending.'), { x: 436, y: 36, width: 556, height: 400 }),
    region('verification', t('验证与问题', 'Checks & issues'), t('放置实际测试结果、问题与截图，不把执行结束当作验证通过。', 'Keep actual test results, issues and screenshots; completion alone is not verification.'), { x: 1016, y: 36, width: 400, height: 400 }),
    region('comparison', t('版本对照', 'Version comparison'), t('放置需要对照的设计、文件或截图；固定的版本保留不动。', 'Keep designs, files or screenshots for comparison; preserve fixed versions.'), { x: 24, y: 484, width: 680, height: 440 }),
    region('decisions', t('设计与记录', 'Decisions & notes'), t('记录已确认的取舍与发布记录，延续已有内容。', 'Maintain confirmed decisions and release notes, building on existing records.'), { x: 728, y: 484, width: 688, height: 440 }),
  ] };
}
